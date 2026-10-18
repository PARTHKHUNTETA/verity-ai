/**
 * Numbered citations → references. The report cites evidence as [n]; a reader needs two
 * lists at the end: the notes (what each [n] quotes, and from where) and the bibliography
 * (each source once, with the numbers that cite it). Pure functions, so they're easy to test.
 */

export type CitationInput = {
  number: number;
  quote: string;
  pageStart: number | null;
  pageEnd: number | null;
  source: {
    id: string;
    type: "upload" | "web" | "paper";
    title: string;
    authors: string[] | null;
    publishedAt: string | null;
    url: string | null;
    doi: string | null;
    domain: string | null;
    fileName: string | null;
  };
};

export type Reference = {
  /** Position in the bibliography (1-based, in order of first citation). */
  index: number;
  sourceId: string;
  /** "Author A, Author B et al. (2024). Title. arxiv.org. https://doi.org/…" */
  text: string;
  url: string | null;
  citedAs: number[];
};

export type Note = { number: number; quote: string; pages: string | null; referenceIndex: number };

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Citation numbers used in the text, in order of first appearance. */
export function citedNumbers(markdown: string): number[] {
  const seen = new Set<number>();
  for (const m of markdown.matchAll(CITATION)) {
    for (const n of m[1]!.split(",")) seen.add(Number(n.trim()));
  }
  return [...seen];
}

export function formatPages(start: number | null, end: number | null): string | null {
  if (start === null) return null;
  return end !== null && end !== start ? `pp. ${start}–${end}` : `p. ${start}`;
}

function formatAuthors(authors: string[] | null): string | null {
  if (!authors?.length) return null;
  return authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
}

/** One bibliography entry, APA-like but tolerant of missing fields. */
export function formatReference(source: CitationInput["source"]): string {
  const authors = formatAuthors(source.authors);
  const year = source.publishedAt?.slice(0, 4);
  // APA style: "Authors (Year). Title." or, without authors, "Title. (Year)."
  const lead = authors ? `${authors}${year ? ` (${year})` : ""}` : null;
  const where =
    source.type === "upload"
      ? `Uploaded document${source.fileName ? ` (${source.fileName})` : ""}`
      : (source.domain ?? null);
  const link = source.doi ? `https://doi.org/${source.doi}` : source.url;
  return [
    lead ? `${lead}.` : null,
    `${source.title.replace(/\.$/, "")}.`,
    !authors && year ? `(${year}).` : null,
    where ? `${where}.` : null,
    link,
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildReferences(markdown: string, citations: CitationInput[]) {
  const byNumber = new Map(citations.map((c) => [c.number, c]));
  const used = citedNumbers(markdown).filter((n) => byNumber.has(n));
  const references: Reference[] = [];
  const indexOf = new Map<string, number>();
  const notes: Note[] = [];

  for (const n of used) {
    const c = byNumber.get(n)!;
    let index = indexOf.get(c.source.id);
    if (index === undefined) {
      index = references.length + 1;
      indexOf.set(c.source.id, index);
      references.push({
        index,
        sourceId: c.source.id,
        text: formatReference(c.source),
        url: c.source.doi ? `https://doi.org/${c.source.doi}` : c.source.url,
        citedAs: [],
      });
    }
    references[index - 1]!.citedAs.push(n);
    notes.push({
      number: n,
      quote: c.quote,
      pages: formatPages(c.pageStart, c.pageEnd),
      referenceIndex: index,
    });
  }
  notes.sort((a, b) => a.number - b.number);
  for (const r of references) r.citedAs.sort((a, b) => a - b);
  return { notes, references };
}
