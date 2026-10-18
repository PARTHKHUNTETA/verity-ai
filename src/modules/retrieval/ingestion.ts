import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import { sourceChunks, sources } from "../../infrastructure/database/schema/index.js";
import type { LlmClient } from "../../infrastructure/llm/index.js";
import type { FileStorage } from "../../infrastructure/storage/file-storage.js";
import { chunkPages } from "./chunker.js";
import { parseDocument, type ParsedDocument, type SupportedMimeType } from "./parsers.js";
import { estimateTokens } from "./tokens.js";

/**
 * The `source.ingest` job (docs/system-design.md §4.6):
 *   load file → parse to text (per page) → chunk → embed (batched) → store chunks → ready
 *
 * Idempotent: chunks are replaced in one transaction, so a retried job never leaves
 * half-ingested or duplicated chunks behind.
 */

const EMBED_BATCH_SIZE = 64;

export type IngestionDeps = {
  db: Database;
  llm: LlmClient;
  storage: FileStorage;
  embeddingModel: string;
  logger: Logger;
};

/** A user-facing reason the document can't be ingested (as opposed to a transient error). */
export class IngestionError extends Error {}

export function createIngestionService({
  db,
  llm,
  storage,
  embeddingModel,
  logger,
}: IngestionDeps) {
  async function fail(sourceId: string, message: string) {
    await db
      .update(sources)
      .set({ status: "failed", error: message })
      .where(eq(sources.id, sourceId));
  }

  /** Chunks, embeds and stores an already-parsed document; marks the source ready. */
  async function ingestParsed(sourceId: string, parsed: ParsedDocument): Promise<number> {
    const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
    if (!source) throw new IngestionError("Source not found");
    await db
      .update(sources)
      .set({ status: "processing", error: null })
      .where(eq(sources.id, sourceId));

    const chunks = chunkPages(parsed.pages, {}, parsed.hasPages);
    if (chunks.length === 0) {
      throw new IngestionError(
        parsed.hasPages
          ? "No text found in this PDF. Scanned documents need OCR, which isn't supported yet."
          : "The document has no text.",
      );
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE).map((c) => c.content);
      const result = await llm.embed(batch, embeddingModel);
      embeddings.push(...result.embeddings);
    }

    await db.transaction(async (tx) => {
      await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, sourceId));
      await tx.insert(sourceChunks).values(
        chunks.map((chunk, i) => ({
          organizationId: source.organizationId,
          sourceId,
          chunkIndex: i,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          embedding: embeddings[i],
          embeddingModel,
        })),
      );
      await tx
        .update(sources)
        .set({
          status: "ready",
          error: null,
          pageCount: parsed.hasPages ? parsed.pages.length : null,
          tokenCount: chunks.reduce((sum, c) => sum + estimateTokens(c.content), 0),
          // Prefer the document's own title/authors when an upload had only a file name.
          title: parsed.title && source.title === source.fileName ? parsed.title : source.title,
          authors: source.authors ?? parsed.authors ?? null,
        })
        .where(eq(sources.id, sourceId));
    });
    return chunks.length;
  }

  return {
    ingestParsed,

    /** The `source.ingest` job for uploads: load the stored file, parse it, then ingest. */
    async ingestSource(sourceId: string): Promise<void> {
      const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
      if (!source || source.deletedAt) return;
      if (!source.storageKey || !source.mimeType) {
        await fail(sourceId, "Source has no stored file");
        return;
      }

      const started = Date.now();
      try {
        const bytes = await storage.get(source.storageKey);
        const parsed = await parseDocument(bytes, source.mimeType as SupportedMimeType);
        const chunkCount = await ingestParsed(sourceId, parsed);
        logger.info({ sourceId, chunks: chunkCount, ms: Date.now() - started }, "Source ingested");
      } catch (err) {
        if (err instanceof IngestionError) {
          await fail(sourceId, err.message);
          return;
        }
        logger.error({ err, sourceId }, "Source ingestion failed");
        await fail(sourceId, "Processing failed. Try uploading the file again.");
        throw err; // let pg-boss retry transient failures
      }
    },

    fail,
  };
}

export type IngestionService = ReturnType<typeof createIngestionService>;
