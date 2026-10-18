import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer } from "../../tests/web-server.js";
import { createSafeFetcher, FetchError } from "./safe-fetch.js";
import { BlockedUrlError } from "./ssrf.js";

let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer({
    "/ok": (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<p>hello</p>");
    },
    "/gzip": (_req, res) => {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync("compressed hello"));
    },
    "/big": (_req, res) => res.end("x".repeat(5000)),
    "/bomb": (_req, res) => {
      // 1 MB of zeros compresses to ~1 KB: the decompressed size must be limited too.
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(1024 * 1024)));
    },
    "/to-ok": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/ok");
      res.end();
    },
    "/to-internal": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "http://internal.test/admin");
      res.end();
    },
    "/to-metadata": (_req, res) => {
      res.statusCode = 301;
      res.setHeader("Location", "http://169.254.169.254/latest/meta-data/");
      res.end();
    },
    "/loop": (_req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/loop");
      res.end();
    },
  });
});
afterAll(() => server.close());

/** Treats 127.0.0.1 (our test server) as "public"; internal.test resolves to a private IP. */
const fetcher = createSafeFetcher({
  maxBytes: 2000,
  timeoutMs: 5000,
  allowAnyPort: true,
  resolve: async (host) => [
    { address: host === "internal.test" ? "10.0.0.5" : "127.0.0.1", family: 4 },
  ],
  isAllowedAddress: (address) => address === "127.0.0.1",
});

/** The real configuration: only public addresses, only ports 80/443, real DNS. */
const productionFetcher = createSafeFetcher({ maxBytes: 2000, timeoutMs: 5000 });

describe("safe fetcher", () => {
  it("fetches a page and reports its content type", async () => {
    const res = await fetcher(server.url("/ok"));
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(new TextDecoder().decode(res.body)).toBe("<p>hello</p>");
  });

  it("decompresses gzip responses", async () => {
    const res = await fetcher(server.url("/gzip"));
    expect(new TextDecoder().decode(res.body)).toBe("compressed hello");
  });

  it("follows safe redirects", async () => {
    const res = await fetcher(server.url("/to-ok"));
    expect(res.url).toMatch(/\/ok$/);
  });

  it("re-checks every redirect hop and refuses internal targets", async () => {
    await expect(fetcher(server.url("/to-internal"))).rejects.toThrow(BlockedUrlError);
    await expect(fetcher(server.url("/to-metadata"))).rejects.toThrow(BlockedUrlError);
  });

  it("limits the response size, also after decompression", async () => {
    await expect(fetcher(server.url("/big"))).rejects.toThrow(/too large/);
    await expect(fetcher(server.url("/bomb"))).rejects.toThrow(/too large/);
  });

  it("stops redirect loops", async () => {
    await expect(fetcher(server.url("/loop"))).rejects.toThrow(/Too many redirects/);
  });

  it("reports HTTP errors", async () => {
    await expect(fetcher(server.url("/missing"))).rejects.toBeInstanceOf(FetchError);
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://10.1.2.3/",
    "http://0.0.0.0/",
  ])("production config refuses %s without connecting", async (url) => {
    await expect(productionFetcher(url)).rejects.toThrow(BlockedUrlError);
  });
});
