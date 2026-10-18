import { describe, expect, it } from "vitest";
import { buildPdf } from "../../tests/pdf.js";
import {
  detectMimeType,
  parseDocument,
  sanitizeText,
  UnsupportedDocumentError,
} from "./parsers.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("detectMimeType", () => {
  it("accepts PDF, text and Markdown files", () => {
    expect(detectMimeType("paper.PDF", buildPdf(["x"]))).toBe("application/pdf");
    expect(detectMimeType("notes.txt", text("hello"))).toBe("text/plain");
    expect(detectMimeType("README.md", text("# Hi"))).toBe("text/markdown");
  });

  it("rejects other types and files whose content doesn't match the extension", () => {
    expect(() => detectMimeType("image.png", text("x"))).toThrow(UnsupportedDocumentError);
    expect(() => detectMimeType("fake.pdf", text("not a pdf"))).toThrow(UnsupportedDocumentError);
    expect(() => detectMimeType("sneaky.txt", buildPdf(["x"]))).toThrow(UnsupportedDocumentError);
  });
});

describe("parseDocument", () => {
  it("extracts text per page and metadata from a PDF", async () => {
    const pdf = buildPdf(["Agents use tools to act.", "Evaluation measures quality."], {
      title: "A Survey of Agents",
      author: "Ada Lovelace; Alan Turing",
    });
    const doc = await parseDocument(pdf, "application/pdf");

    expect(doc.hasPages).toBe(true);
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]).toContain("Agents use tools to act.");
    expect(doc.pages[1]).toContain("Evaluation measures quality.");
    expect(doc.title).toBe("A Survey of Agents");
    expect(doc.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
  });

  it("uses the first heading as the title of a Markdown file", async () => {
    const doc = await parseDocument(text("# Retrieval Notes\n\nSome text."), "text/markdown");
    expect(doc).toMatchObject({ hasPages: false, title: "Retrieval Notes" });
  });
});

describe("sanitizeText", () => {
  it("removes NUL and control characters Postgres can't store, keeping newlines and tabs", () => {
    // Real arXiv PDFs can contain NUL bytes in extracted text (found during Phase 6 testing).
    expect(sanitizeText("Yousuf1\u0000[0009]\u0007 ok\n\tnext")).toBe("Yousuf1[0009] ok\n\tnext");
  });

  it("is applied to every parsed document", async () => {
    const doc = await parseDocument(text("before\u0000after"), "text/plain");
    expect(doc.pages[0]).toBe("beforeafter");
  });
});
