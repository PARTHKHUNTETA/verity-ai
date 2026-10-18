import { extractText, getMeta } from "unpdf";
import { extractHtml } from "./html.js";

/** Document types we can ingest (uploads and fetched web content). */
export const SUPPORTED_TYPES = {
  "application/pdf": { extensions: [".pdf"], label: "PDF" },
  "text/plain": { extensions: [".txt"], label: "Text" },
  "text/markdown": { extensions: [".md", ".markdown"], label: "Markdown" },
  "text/html": { extensions: [".html", ".htm"], label: "Web page" },
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_TYPES;

export type ParsedDocument = {
  /** Text per page. Plain-text files are a single "page" with hasPages = false. */
  pages: string[];
  hasPages: boolean;
  title?: string;
  authors?: string[];
  publishedAt?: string;
};

export class UnsupportedDocumentError extends Error {}

/** Decides the type from the file name and checks the content really matches it. */
export function detectMimeType(fileName: string, bytes: Uint8Array): SupportedMimeType {
  const lower = fileName.toLowerCase();
  const match = (Object.keys(SUPPORTED_TYPES) as SupportedMimeType[]).find((type) =>
    SUPPORTED_TYPES[type].extensions.some((ext) => lower.endsWith(ext)),
  );
  if (!match) {
    throw new UnsupportedDocumentError(
      "Unsupported file type. Upload a PDF, .txt, .md or .html file.",
    );
  }
  // Don't trust the extension alone: a PDF starts with "%PDF-".
  const isPdf = new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if ((match === "application/pdf") !== isPdf) {
    throw new UnsupportedDocumentError("The file's content doesn't match its extension.");
  }
  return match;
}

/**
 * Removes characters Postgres text columns reject or that are noise: NUL (some PDFs embed it
 * in extracted text) and other control characters. Newlines and tabs are kept.
 */
export function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export async function parseDocument(
  bytes: Uint8Array,
  mimeType: SupportedMimeType,
): Promise<ParsedDocument> {
  const doc = await parseRaw(bytes, mimeType);
  return {
    ...doc,
    pages: doc.pages.map(sanitizeText),
    title: doc.title ? sanitizeText(doc.title) : undefined,
    authors: doc.authors?.map(sanitizeText),
  };
}

async function parseRaw(bytes: Uint8Array, mimeType: SupportedMimeType): Promise<ParsedDocument> {
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
  if (mimeType === "text/html") {
    const page = extractHtml(text);
    return {
      pages: [page.text],
      hasPages: false,
      title: page.title,
      authors: page.authors,
      publishedAt: page.publishedAt,
    };
  }
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

/** Maps an HTTP Content-Type (plus a peek at the bytes) to a type we can parse, or null. */
export function mimeTypeFromResponse(
  contentType: string | null,
  bytes: Uint8Array,
): SupportedMimeType | null {
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "text/html" || type === "application/xhtml+xml") return "text/html";
  if (type === "text/markdown") return "text/markdown";
  if (type === "text/plain") return "text/plain";
  return null;
}
