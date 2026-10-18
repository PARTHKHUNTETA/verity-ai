import { sql } from "drizzle-orm";
import {
  customType,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import { collectionVisibility, sourceStatus, sourceType } from "./enums.js";
import { organizations, users } from "./identity.js";

/** Knowledge base (docs/db-design.md §5.2). */

/** Dimensions of OpenAI text-embedding-3-small. Changing models means re-embedding every chunk. */
export const EMBEDDING_DIMENSIONS = 1536;

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

/** A user-curated set of documents, e.g. "AI agent papers 2025". */
export const collections = pgTable(
  "collections",
  {
    id: id(),
    organizationId: organizationId(),
    name: text("name").notNull(),
    description: text("description"),
    visibility: collectionVisibility("visibility").notNull().default("organization"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("collections_org_idx").on(t.organizationId)],
);

/**
 * One row per document, whatever its origin (upload now; web pages and papers in Phase 6).
 * Deduplicated per organization by content_hash, so the same PDF is stored and embedded once.
 */
export const sources = pgTable(
  "sources",
  {
    id: id(),
    organizationId: organizationId(),
    type: sourceType("type").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    canonicalUrl: text("canonical_url"),
    doi: text("doi"),
    authors: text("authors").array(),
    publishedAt: date("published_at"),
    domain: text("domain"),
    storageKey: text("storage_key"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    /** SHA-256 of the original bytes (uploads) or of the normalized text (web, Phase 6). */
    contentHash: text("content_hash").notNull(),
    status: sourceStatus("status").notNull().default("pending"),
    error: text("error"),
    pageCount: integer("page_count"),
    tokenCount: integer("token_count"),
    reliabilityScore: real("reliability_score"),
    /** When a web/paper source was last downloaded (acts as the fetch cache timestamp). */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sources_org_content_hash_unique").on(t.organizationId, t.contentHash),
    // The same web page / paper is stored once per organization.
    uniqueIndex("sources_org_canonical_url_unique")
      .on(t.organizationId, t.canonicalUrl)
      .where(sql`${t.canonicalUrl} is not null`),
    index("sources_org_status_idx").on(t.organizationId, t.status),
  ],
);

/** Retrieval units: ~800-token pieces of a source, with an embedding and a full-text index. */
export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: id(),
    organizationId: organizationId(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count").notNull(),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model").notNull(),
    // Maintained by Postgres from `content`, so it can never drift out of sync.
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('english', content)`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("source_chunks_source_index_unique").on(t.sourceId, t.chunkIndex),
    index("source_chunks_org_source_idx").on(t.organizationId, t.sourceId),
    index("source_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("source_chunks_tsv_gin").using("gin", t.tsv),
  ],
);

/** Which sources are in which collections (a source can be in several). */
export const collectionSources = pgTable(
  "collection_sources",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.sourceId] })],
);

export type Collection = typeof collections.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type SourceChunk = typeof sourceChunks.$inferSelect;
