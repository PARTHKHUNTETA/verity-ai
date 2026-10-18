import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { assertSafeUrl, BlockedUrlError, isPublicAddress } from "./ssrf.js";

/**
 * Fetches untrusted URLs safely:
 * - only http(s) on ports 80/443, no credentials in the URL;
 * - every address the hostname resolves to must be public, and the connection is pinned to the
 *   checked address (a DNS answer can't change between the check and the connect: "DNS rebinding");
 * - redirects are followed manually (max 5) and every hop is checked again;
 * - total time and (decompressed) size are limited.
 */

export type SafeFetchOptions = {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  userAgent?: string;
  /** For tests: resolve hostnames without real DNS. */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  /** For tests: decide which addresses are allowed (defaults to public addresses only). */
  isAllowedAddress?: (address: string) => boolean;
  /** For tests only: allow ports other than 80/443 (test servers use random ports). */
  allowAnyPort?: boolean;
};

export type SafeResponse = {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string | null;
  body: Uint8Array;
};

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export type SafeFetcher = (url: string, signal?: AbortSignal) => Promise<SafeResponse>;

function systemResolve(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (err, addresses: LookupAddress[]) =>
      err ? reject(err) : resolve(addresses),
    ),
  );
}

export function createSafeFetcher(options: SafeFetchOptions): SafeFetcher {
  const {
    maxBytes,
    timeoutMs,
    maxRedirects = 5,
    userAgent = "VerityAI/0.1 (research agent; +https://github.com/PARTHKHUNTETA/verity-ai)",
    resolve = systemResolve,
    isAllowedAddress = isPublicAddress,
    allowAnyPort = false,
  } = options;

  /** Resolves and checks the host; returns the address to connect to. */
  async function checkedAddress(hostname: string): Promise<{ address: string; family: number }> {
    const host = hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolve(host).catch(() => {
          throw new FetchError(`Could not resolve ${host}`);
        });
    if (addresses.length === 0) throw new FetchError(`Could not resolve ${host}`);
    // Every record must be allowed: mixing a public and a private record is a known trick.
    const bad = addresses.find((a) => !isAllowedAddress(a.address));
    if (bad) throw new BlockedUrlError(`${host} resolves to a non-public address (${bad.address})`);
    return addresses[0]!;
  }

  function requestOnce(url: URL, pinned: { address: string; family: number }, signal: AbortSignal) {
    // Node calls `lookup` when connecting; we answer with the address we already checked.
    const lookup: LookupFunction = (_hostname, opts, callback) => {
      if (opts && typeof opts === "object" && opts.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [pinned]);
      } else {
        callback(null, pinned.address, pinned.family);
      }
    };
    const client = url.protocol === "https:" ? https : http;
    return new Promise<IncomingMessage>((resolveRes, reject) => {
      const req = client.request(
        url,
        {
          method: "GET",
          lookup,
          signal,
          headers: {
            "User-Agent": userAgent,
            Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
          },
        },
        resolveRes,
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function readBody(res: IncomingMessage): Promise<Uint8Array> {
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      res.destroy();
      throw new FetchError(`Response too large (${declared} bytes)`);
    }
    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
    const stream =
      encoding === "gzip" || encoding === "x-gzip"
        ? res.pipe(createGunzip())
        : encoding === "br"
          ? res.pipe(createBrotliDecompress())
          : encoding === "deflate"
            ? res.pipe(createInflate())
            : res;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      // Checked after decompression too: a tiny gzip "bomb" can expand to gigabytes.
      if (size > maxBytes) {
        res.destroy();
        throw new FetchError(`Response too large (over ${maxBytes} bytes)`);
      }
      chunks.push(chunk as Buffer);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  return async function safeFetch(rawUrl, outerSignal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    let url = assertSafeUrl(rawUrl, { allowAnyPort });

    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const pinned = await checkedAddress(url.hostname);
        const res = await requestOnce(url, pinned, signal);
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // discard the redirect body
          url = assertSafeUrl(new URL(res.headers.location, url).toString(), { allowAnyPort });
          continue;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          throw new FetchError(`HTTP ${status}`, status);
        }
        return {
          url: url.toString(),
          status,
          contentType: res.headers["content-type"] ?? null,
          body: await readBody(res),
        };
      }
      throw new FetchError(`Too many redirects (more than ${maxRedirects})`);
    } catch (err) {
      if (timeout.aborted && !outerSignal?.aborted) {
        throw new FetchError(`Timed out after ${timeoutMs} ms`);
      }
      throw err;
    }
  };
}
