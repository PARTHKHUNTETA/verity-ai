import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../../infrastructure/database/client.js";
import { sources, type Source } from "../../infrastructure/database/schema/index.js";
import { BlockedUrlError } from "../../infrastructure/http/ssrf.js";
import type { SafeFetcher } from "../../infrastructure/http/safe-fetch.js";
import type { FileStorage } from "../../infrastructure/storage/file-storage.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { withSpan } from "../observability/tracer.js";
import type { SearchResult } from "../tools/search.tool.js";
import { IngestionError, type IngestionService } from "./ingestion.js";
import {
  mimeTypeFromResponse,
  parseDocument,
  type ParsedDocument,
  type SupportedMimeType,
} from "./parsers.js";
import { canonicalizeUrl, domainOf } from "./urls.js";

/**
 * Acquisition (docs/system-design.md §3, stage 3): turns a search result into an indexed source.
 *
 *   cache (same canonical URL already indexed?) → safe fetch → parse →
 *   dedupe by content hash → store original → chunk + embed (same pipeline as uploads)
 *
 * If the full text can't be fetched (paywall, timeout, unsupported format) but the search result
 * came with a real abstract, the abstract is indexed instead, and the note says so.
 */

export type AcquireResult =
  | { status: "acquired"; sourceId: string; reused: boolean; note?: string }
  | { status: "rejected" | "blocked"; reason: string };

export type AcquisitionDeps = {
  db: Database;
  fetcher: SafeFetcher;
  storage: FileStorage;
  ingestion: IngestionService;
  logger: Logger;
};

const MIN_TEXT_CHARS = 200;
const EXTENSIONS: Record<SupportedMimeType, string> = {
  "application/pdf": ".pdf",
  "text/html": ".html",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

type FetchedDocument = {
  bytes: Uint8Array;
  mimeType: SupportedMimeType;
  parsed: ParsedDocument;
  note?: string;
};

export function createAcquisitionService({
  db,
  fetcher,
  storage,
  ingestion,
  logger,
}: AcquisitionDeps) {
  async function findBy(
    organizationId: string,
    column: "canonicalUrl" | "contentHash",
    value: string,
  ) {
    const [row] = await db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.organizationId, organizationId),
          eq(sources[column], value),
          isNull(sources.deletedAt),
        ),
      );
    return row;
  }

  /** Downloads and parses the candidate; falls back to its abstract when that fails. */
  async function fetchDocument(
    candidate: SearchResult,
    signal?: AbortSignal,
  ): Promise<FetchedDocument | AcquireResult> {
    try {
      const target = candidate.pdfUrl ?? candidate.url;
      const res = await withSpan(
        "fetch.http",
        { url: target, host: new URL(target).host },
        async (span) => {
          const response = await fetcher(target, signal);
          span.setAttributes({
            status: response.status,
            bytes: response.body.byteLength,
            contentType: response.contentType,
          });
          return response;
        },
        "client",
      );
      const mimeType = mimeTypeFromResponse(res.contentType, res.body);
      if (!mimeType)
        throw new IngestionError(`Unsupported content type (${res.contentType ?? "unknown"})`);
      const parsed = await withSpan("parse", { mimeType }, async (span) => {
        const doc = await parseDocument(res.body, mimeType);
        span.setAttributes({ pages: doc.pages.length, characters: doc.pages.join("").length });
        return doc;
      });
      if (parsed.pages.join(" ").trim().length < MIN_TEXT_CHARS) {
        throw new IngestionError("The page has too little readable text");
      }
      return { bytes: res.body, mimeType, parsed };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof BlockedUrlError) return { status: "blocked", reason: err.message };
      const reason = err instanceof Error ? err.message : "Download failed";
      if (candidate.snippet.length >= MIN_TEXT_CHARS) {
        const text = `${candidate.title}\n\n${candidate.snippet}`;
        return {
          bytes: new TextEncoder().encode(text),
          mimeType: "text/plain",
          parsed: { pages: [text], hasPages: false },
          note: `Full text unavailable (${reason}); indexed the abstract instead`,
        };
      }
      return { status: "rejected", reason };
    }
  }

  return {
    async acquire(
      organizationId: string,
      candidate: SearchResult,
      signal?: AbortSignal,
    ): Promise<AcquireResult> {
      let canonicalUrl: string;
      try {
        canonicalUrl = canonicalizeUrl(candidate.url);
      } catch {
        return { status: "rejected", reason: "Invalid URL" };
      }
      // Domain rules are enforced by the policy gateway before acquire() is called.

      // Cache: this page/paper is already indexed for the organization.
      const cached = await findBy(organizationId, "canonicalUrl", canonicalUrl);
      if (cached?.status === "ready")
        return { status: "acquired", sourceId: cached.id, reused: true };

      const fetched = await fetchDocument(candidate, signal);
      if ("status" in fetched) return fetched;

      // Same content under a different URL (mirror, redirect): reuse it.
      const normalized = fetched.parsed.pages.join("\n").replace(/\s+/g, " ").trim();
      const contentHash = createHash("sha256").update(normalized).digest("hex");
      const sameContent = await findBy(organizationId, "contentHash", contentHash);
      if (sameContent?.status === "ready") {
        return { status: "acquired", sourceId: sameContent.id, reused: true, note: fetched.note };
      }

      const existing: Source | undefined = cached ?? sameContent;
      const id = existing?.id ?? uuidv7();
      const storageKey = `${organizationId}/${id}${EXTENSIONS[fetched.mimeType]}`;
      await storage.put(storageKey, fetched.bytes);

      const values = {
        type: candidate.kind === "paper" ? ("paper" as const) : ("web" as const),
        title: candidate.title || fetched.parsed.title || domainOf(candidate.url),
        url: candidate.url,
        canonicalUrl,
        domain: domainOf(candidate.url),
        doi: candidate.doi ?? null,
        authors: candidate.authors?.length ? candidate.authors : (fetched.parsed.authors ?? null),
        publishedAt: toDate(candidate.publishedAt ?? fetched.parsed.publishedAt),
        storageKey,
        mimeType: fetched.mimeType,
        sizeBytes: fetched.bytes.byteLength,
        contentHash,
        status: "pending" as const,
        error: null,
        fetchedAt: new Date(),
      };
      try {
        if (existing) {
          await db.update(sources).set(values).where(eq(sources.id, id));
        } else {
          await db.insert(sources).values({ id, organizationId, ...values });
        }
      } catch (err) {
        await storage.delete(storageKey);
        // Another run acquired the same document at the same moment: use theirs if it's ready.
        if (isUniqueViolation(err)) {
          const winner =
            (await findBy(organizationId, "canonicalUrl", canonicalUrl)) ??
            (await findBy(organizationId, "contentHash", contentHash));
          if (winner?.status === "ready")
            return { status: "acquired", sourceId: winner.id, reused: true };
          return {
            status: "rejected",
            reason: "The same document is being processed by another run",
          };
        }
        throw err;
      }

      try {
        await ingestion.ingestParsed(id, fetched.parsed);
      } catch (err) {
        const reason = err instanceof IngestionError ? err.message : "Indexing failed";
        await ingestion.fail(id, reason);
        if (!(err instanceof IngestionError))
          logger.error({ err, url: candidate.url }, "Indexing a fetched source failed");
        return { status: "rejected", reason };
      }
      return { status: "acquired", sourceId: id, reused: false, note: fetched.note };
    },
  };
}

export type AcquisitionService = ReturnType<typeof createAcquisitionService>;

/** Postgres `date` column wants YYYY-MM-DD; accept full timestamps or bare years. */
function toDate(value: string | undefined): string | null {
  if (!value) return null;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (iso) return iso;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
