import { describe, expect, it } from "vitest";
import { chunkPages } from "./chunker.js";

const paragraph = (n: number, words = 60) =>
  `Paragraph ${n} ` + Array.from({ length: words }, (_, i) => `word${i}`).join(" ") + ".";

describe("chunkPages", () => {
  it("keeps a short document in one chunk with its page", () => {
    const chunks = chunkPages(["Hello world. This is a short page."]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 1 });
    expect(chunks[0]!.content).toBe("Hello world. This is a short page.");
  });

  it("splits long documents under the size limit, at paragraph boundaries", () => {
    const text = Array.from({ length: 20 }, (_, i) => paragraph(i)).join("\n\n");
    const chunks = chunkPages([text], { maxTokens: 200, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(200 * 4);
      expect(c.content.startsWith("Paragraph")).toBe(true); // never mid-paragraph
    }
  });

  it("repeats the end of one chunk at the start of the next (overlap)", () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i, 20)).join("\n\n");
    const chunks = chunkPages([text], { maxTokens: 120, overlapTokens: 40 });

    const lastParagraphOfFirst = chunks[0]!.content.split("\n\n").at(-1)!;
    expect(chunks[1]!.content.startsWith(lastParagraphOfFirst)).toBe(true);
  });

  it("tracks page ranges across page breaks", () => {
    const chunks = chunkPages(["First page text.", "Second page text.", "Third page text."]);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 3 });
  });

  it("splits a giant paragraph by sentences", () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`);
    const chunks = chunkPages([sentences.join(" ")], { maxTokens: 50, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content).toMatch(/\.$/);
  });

  it("omits page numbers for documents without pages", () => {
    const [chunk] = chunkPages(["Plain text."], {}, false);
    expect(chunk).toMatchObject({ pageStart: null, pageEnd: null });
  });

  it("returns nothing for empty input", () => {
    expect(chunkPages(["", "   \n\n  "])).toEqual([]);
  });
});
