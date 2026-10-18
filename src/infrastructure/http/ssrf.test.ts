import { describe, expect, it } from "vitest";
import { assertSafeUrl, BlockedUrlError, isPublicAddress } from "./ssrf.js";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254", // cloud metadata endpoint
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1", // NAT64 → 10.0.0.1
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "151.101.1.69", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("assertSafeUrl", () => {
  it("accepts http(s) URLs on default ports", () => {
    expect(assertSafeUrl("https://arxiv.org/abs/1234").hostname).toBe("arxiv.org");
    expect(assertSafeUrl("http://example.com:80/x").hostname).toBe("example.com");
  });

  it.each([
    ["file:///etc/passwd", /Scheme/],
    ["ftp://example.com/x", /Scheme/],
    ["gopher://example.com/", /Scheme/],
    ["https://user:secret@example.com/", /credentials/],
    ["http://example.com:5432/", /Port/],
    ["not a url", /valid/],
  ])("rejects %s", (url, message) => {
    expect(() => assertSafeUrl(url)).toThrow(BlockedUrlError);
    expect(() => assertSafeUrl(url)).toThrow(message);
  });
});
