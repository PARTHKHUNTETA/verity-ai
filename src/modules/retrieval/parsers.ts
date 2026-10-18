import { extractText, getMeta } from "unpdf";

/** File types we can ingest in Phase 5. HTML/web pages arrive with the fetch tool in Phase 6. */
export const SUPPORTED_TYPES = {
  "application/pdf": { extensions: [".pdf"], label: "PDF" },
  "text/plain": { extensions: [".txt"], label: "Text" },
  "text/markdown": { extensions: [".md", ".markdown"], label: "Markdown" },
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_TYPES;

export type ParsedDocument = {
  /** Text per page. Plain-text files are a single "page" with hasPages = false. */
  pages: string[];
  hasPages: boolean;
  title?: string;
  authors?: string[];
};

export class UnsupportedDocumentError extends Error {}

/** Decides the type from the file name and checks the content really matches it. */
export function detectMimeType(fileName: string, bytes: Uint8Array): SupportedMimeType {
  const lower = fileName.toLowerCase();
  const match = (Object.keys(SUPPORTED_TYPES) as SupportedMimeType[]).find((type) =>
    SUPPORTED_TYPES[type].extensions.some((ext) => lower.endsWith(ext)),
  );
  if (!match) {
    throw new UnsupportedDocumentError("Unsupported file type. Upload a PDF, .txt or .md file.");
  }
  // Don't trust the extension alone: a PDF starts with "%PDF-".
  const isPdf = new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if ((match === "application/pdf") !== isPdf) {
    throw new UnsupportedDocumentError("The file's content doesn't match its extension.");
  }
  return match;
}

export async function parseDocument(
  bytes: Uint8Array,
  mimeType: SupportedMimeType,
): Promise<ParsedDocument> {
  if (mimeType === "application/pdf") {
    // pdf.js may take ownership of (detach) the buffer it is given, so pass copies.
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: false });
    const meta = await getMeta(new Uint8Array(bytes)).catch(() => null);
    const title = cleanMeta(meta?.info?.Title);
    const author = cleanMeta(meta?.info?.Author);
    return {
      pages: text,
      hasPages: true,
      title,
      authors: author ? author.split(/\s*[;,]\s*|\s+and\s+/).filter(Boolean) : undefined,
    };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    pages: [text],
    hasPages: false,
    title: mimeType === "text/markdown" ? heading : undefined,
  };
}

function cleanMeta(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
