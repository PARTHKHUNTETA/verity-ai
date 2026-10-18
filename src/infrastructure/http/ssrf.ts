import { BlockList, isIP } from "node:net";

/**
 * SSRF protection (docs/system-design.md §7).
 *
 * The agent fetches URLs it found on the web. Without a guard, a malicious page or search
 * result could point it at internal services: http://localhost:5432, the cloud metadata
 * endpoint http://169.254.169.254/ (which can leak credentials), or private network hosts.
 * We only allow http(s) to publicly routable IP addresses.
 */

const blocked = new BlockList();
// IPv4: "this network", private, carrier-grade NAT, loopback, link-local (cloud metadata),
// IETF/test/benchmark ranges, multicast, reserved, broadcast.
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6: unspecified, loopback, unique-local, link-local, multicast, documentation, NAT64
// (can map to any IPv4, including private ones), discard, Teredo/6to4 (tunnel to IPv4).
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2002::", 16],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True only for publicly routable addresses. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !blocked.check(address, "ipv4");
  if (version === 6) {
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged as the IPv4 address it contains.
    const mapped = address.toLowerCase().match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:/i.test(address)) return false; // hex-form mapped addresses: just refuse
    return !blocked.check(address, "ipv6");
  }
  return false;
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

const ALLOWED_PORTS = new Set(["", "80", "443"]);

/** Checks the URL itself (scheme, credentials, port). Addresses are checked at connect time. */
export function assertSafeUrl(raw: string, { allowAnyPort = false } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("Not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password)
    throw new BlockedUrlError("URLs with credentials are not allowed");
  if (!allowAnyPort && !ALLOWED_PORTS.has(url.port))
    throw new BlockedUrlError(`Port ${url.port} is not allowed`);
  return url;
}
