/**
 * Turns a Markdown answer into claims: every sentence that carries citation markers like
 * [1] or [2, 5] becomes a claim linked to those passage numbers. Phase 7 replaces this with
 * structured synthesis; Phase 10 uses claims to check that each citation supports its sentence.
 */

export type ExtractedClaim = {
  position: number;
  section: string | null;
  text: string;
  citations: number[];
};

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
// Split after ., ! or ? (and any citations right after it) when the next sentence starts.
const SENTENCE_BOUNDARY = /(?<=[.!?](?:\s*\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=[A-Z0-9"'(*_])/;

export function extractClaims(
  markdown: string,
  validNumbers: ReadonlySet<number>,
): { claims: ExtractedClaim[]; invalidCitations: number[] } {
  const claims: ExtractedClaim[] = [];
  const invalid = new Set<number>();
  let section: string | null = null;
  let inCodeBlock = false;

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock || !line) continue;

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = stripMarkdown(heading[1]!.replace(CITATION, "")).trim() || null;
      continue;
    }

    // Drop list markers, blockquotes and table pipes; keep the sentence text.
    const body = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "").replace(/\|/g, " ");
    for (const sentence of body.split(SENTENCE_BOUNDARY)) {
      const numbers = [...sentence.matchAll(CITATION)].flatMap((m) =>
        m[1]!.split(",").map((n) => Number(n.trim())),
      );
      const valid = [...new Set(numbers.filter((n) => validNumbers.has(n)))];
      numbers.filter((n) => !validNumbers.has(n)).forEach((n) => invalid.add(n));
      if (valid.length === 0) continue;

      const text = stripMarkdown(sentence.replace(CITATION, ""))
        .replace(/\s+([.,;:!?])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
      if (text) claims.push({ position: claims.length + 1, section, text, citations: valid });
    }
  }
  return { claims, invalidCitations: [...invalid] };
}

function stripMarkdown(text: string): string {
  return text.replace(/(\*\*|__|\*|_|`)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}
