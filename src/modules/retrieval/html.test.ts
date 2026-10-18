import { describe, expect, it } from "vitest";
import { ARTICLE_HTML } from "../../tests/web-server.js";
import { extractHtml } from "./html.js";

describe("extractHtml", () => {
  it("extracts article text and scholarly metadata, dropping navigation", () => {
    const page = extractHtml(ARTICLE_HTML);
    expect(page.title).toBe("How Research Agents Work");
    expect(page.authors).toEqual(["Grace Hopper"]);
    expect(page.publishedAt).toBe("2026/03/05");
    expect(page.text).toContain("Research agents combine web search with document reading.");
    expect(page.text).not.toContain("Subscribe");
    // Paragraphs stay separate for the chunker.
    expect(page.text.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to body text for pages Readability can't parse", () => {
    const page = extractHtml(
      "<html><body><div>Short page text that is still worth indexing.</div></body></html>",
    );
    expect(page.text).toContain("Short page text");
  });
});
