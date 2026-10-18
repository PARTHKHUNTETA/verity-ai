import { CHARS_PER_TOKEN, estimateTokens } from "./tokens.js";

/**
 * Splits a document into overlapping chunks for retrieval (docs/system-design.md §4.6).
 *
 * Why chunk at all? Embeddings work best on focused passages, and the model can only read a
 * limited amount of context. Why ~800 tokens? Big enough to keep an argument together,
 * small enough that a retrieved chunk is mostly relevant. Why overlap? A sentence that
 * straddles a boundary still appears whole in one of the two chunks.
 *
 * Strategy: break pages into "units" (paragraphs, or sentences of very long paragraphs),
 * then pack units greedily into chunks. Boundaries therefore fall between paragraphs or
 * sentences, never mid-word. Page numbers are tracked per unit for citations ("p. 4–5").
 */

export type Chunk = {
  content: string;
  tokenCount: number;
  pageStart: number | null;
  pageEnd: number | null;
};

export type ChunkOptions = { maxTokens?: number; overlapTokens?: number };

type Unit = { text: string; page: number | null };

export function chunkPages(
  pages: string[],
  { maxTokens = 800, overlapTokens = 100 }: ChunkOptions = {},
  /** false for documents without pages (plain text), so chunks don't claim "page 1". */
  hasPages = true,
): Chunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const units: Unit[] = [];
  pages.forEach((pageText, i) => {
    const page = hasPages ? i + 1 : null;
    for (const paragraph of splitParagraphs(pageText)) {
      for (const piece of splitToFit(paragraph, maxChars)) units.push({ text: piece, page });
    }
  });

  const chunks: Chunk[] = [];
  let current: Unit[] = [];
  let currentChars = 0;

  const emit = () => {
    const content = current.map((u) => u.text).join("\n\n");
    const pagesInChunk = current.map((u) => u.page).filter((p): p is number => p !== null);
    chunks.push({
      content,
      tokenCount: estimateTokens(content),
      pageStart: pagesInChunk.length ? Math.min(...pagesInChunk) : null,
      pageEnd: pagesInChunk.length ? Math.max(...pagesInChunk) : null,
    });
  };

  for (const unit of units) {
    if (current.length > 0 && currentChars + unit.text.length + 2 > maxChars) {
      emit();
      // Start the next chunk with the tail of this one (whole units, up to overlapChars).
      const overlap: Unit[] = [];
      let overlapSize = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const u = current[i]!;
        if (overlapSize + u.text.length > overlapChars) break;
        overlap.unshift(u);
        overlapSize += u.text.length + 2;
      }
      current = overlap;
      currentChars = overlapSize;
    }
    current.push(unit);
    currentChars += unit.text.length + 2;
  }
  if (current.length > 0) emit();
  return chunks;
}

/** Normalizes whitespace and splits on blank lines. */
function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p.length > 0);
}

/** Splits text longer than maxChars at sentence boundaries, or hard-cuts as a last resort. */
function splitToFit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const pieces: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buffer) pieces.push(buffer.trim());
      buffer = "";
      for (let i = 0; i < sentence.length; i += maxChars) {
        pieces.push(sentence.slice(i, i + maxChars).trim());
      }
      continue;
    }
    if (buffer.length + sentence.length > maxChars) {
      pieces.push(buffer.trim());
      buffer = "";
    }
    buffer += sentence;
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces.filter((p) => p.length > 0);
}
