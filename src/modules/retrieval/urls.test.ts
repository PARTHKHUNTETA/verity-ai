import { describe, expect, it } from "vitest";
import { canonicalizeUrl, checkDomain, parseDomainList } from "./urls.js";

describe("canonicalizeUrl", () => {
  it("normalizes cosmetic differences", () => {
    expect(canonicalizeUrl("http://WWW.Example.com:80/Path/?utm_source=x&b=2&a=1#intro")).toBe(
      "https://example.com/Path?a=1&b=2",
    );
  });

  it("maps every arXiv link form to one abstract URL", () => {
    for (const url of [
      "https://arxiv.org/abs/2401.12345",
      "https://arxiv.org/abs/2401.12345v3",
      "http://arxiv.org/pdf/2401.12345v2",
      "https://arxiv.org/pdf/2401.12345.pdf",
      "https://export.arxiv.org/abs/2401.12345v1",
    ]) {
      expect(canonicalizeUrl(url)).toBe("https://arxiv.org/abs/2401.12345");
    }
  });

  it("keeps meaningful query parameters", () => {
    expect(canonicalizeUrl("https://example.com/search?q=agents&page=2")).toBe(
      "https://example.com/search?page=2&q=agents",
    );
  });
});

describe("checkDomain", () => {
  const policy = { blocked: parseDomainList("spam.com, www.Bad.org"), allowed: [] };

  it("blocks listed domains and their subdomains", () => {
    expect(checkDomain("https://spam.com/a", policy)).toMatch(/blocked/);
    expect(checkDomain("https://news.spam.com/a", policy)).toMatch(/blocked/);
    expect(checkDomain("https://bad.org/", policy)).toMatch(/blocked/);
    expect(checkDomain("https://notspam.com/", policy)).toBeNull();
  });

  it("enforces an allow list when one is set", () => {
    const allowOnly = { blocked: [], allowed: ["arxiv.org"] };
    expect(checkDomain("https://arxiv.org/abs/1", allowOnly)).toBeNull();
    expect(checkDomain("https://example.com/", allowOnly)).toMatch(/not on the allowed list/);
  });
});
