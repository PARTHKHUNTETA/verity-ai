import { sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import type { LlmClient } from "../../infrastructure/llm/index.js";

/**
 * Hybrid search (docs/db-design.md §6.1):
 *   1. vector search: closest chunks by cosine distance of embeddings (meaning)
 *   2. keyword search: Postgres full-text ranking (exact terms, names, numbers)
 *   3. Reciprocal Rank Fusion: score = Σ 1 / (60 + rank) over both lists
 *
 * RRF only uses ranks, not raw scores, so the two very different scoring scales never need to
 * be calibrated against each other. A chunk ranked well by both lists wins.
 */

export type SearchHit = {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  /** null for uploaded documents. */
  sourceDomain: string | null;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
};

export type SearchOptions = {
  organizationId: string;
  /** Chunks of ready sources in these collections are searched… */
  collectionIds: string[];
  /** …plus these sources (e.g. documents a run fetched from the web). */
  sourceIds?: string[];
  topK?: number;
  /** How many candidates each method contributes before fusion. */
  candidates?: number;
};

const RRF_K = 60;

/**
 * A Postgres uuid[] literal. (Passing a JS array straight into drizzle's sql template expands it
 * into a comma-separated parameter list, which is not an array.)
 */
function uuidArray(ids: string[]) {
  return ids.length
    ? sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`
    : sql`ARRAY[]::uuid[]`;
}

export function createSearchService(db: Database, llm: LlmClient, embeddingModel: string) {
  return {
    async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
      const { organizationId, collectionIds, sourceIds = [], topK = 8, candidates = 30 } = options;
      if ((collectionIds.length === 0 && sourceIds.length === 0) || !query.trim()) return [];

      const {
        embeddings: [embedding],
      } = await llm.embed([query], embeddingModel);
      const vectorLiteral = `[${embedding!.join(",")}]`;

      const result = await db.execute<{
        chunk_id: string;
        source_id: string;
        source_title: string;
        source_domain: string | null;
        content: string;
        page_start: number | null;
        page_end: number | null;
        score: string;
        vector_rank: number | null;
        keyword_rank: number | null;
      }>(sql`
        WITH searchable AS (
          SELECT s.id
          FROM sources s
          WHERE s.organization_id = ${organizationId}
            AND s.status = 'ready' AND s.deleted_at IS NULL
            AND (
              s.id IN (
                SELECT cs.source_id
                FROM collection_sources cs
                JOIN collections c ON c.id = cs.collection_id
                WHERE c.deleted_at IS NULL AND cs.collection_id = ANY(${uuidArray(collectionIds)})
              )
              OR s.id = ANY(${uuidArray(sourceIds)})
            )
        ),
        vector_hits AS (
          SELECT ch.id, ROW_NUMBER() OVER (ORDER BY ch.embedding <=> ${vectorLiteral}::vector) AS rank
          FROM source_chunks ch
          WHERE ch.organization_id = ${organizationId}
            AND ch.source_id IN (SELECT id FROM searchable)
          ORDER BY ch.embedding <=> ${vectorLiteral}::vector
          LIMIT ${candidates}
        ),
        keyword_hits AS (
          SELECT ch.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ch.tsv, q) DESC) AS rank
          FROM source_chunks ch, websearch_to_tsquery('english', ${query}) q
          WHERE ch.organization_id = ${organizationId}
            AND ch.source_id IN (SELECT id FROM searchable)
            AND ch.tsv @@ q
          ORDER BY ts_rank_cd(ch.tsv, q) DESC
          LIMIT ${candidates}
        )
        SELECT ch.id AS chunk_id, ch.source_id, s.title AS source_title, s.domain AS source_domain,
               ch.content,
               ch.page_start, ch.page_end,
               COALESCE(1.0 / (${RRF_K} + v.rank), 0) + COALESCE(1.0 / (${RRF_K} + k.rank), 0) AS score,
               v.rank::int AS vector_rank, k.rank::int AS keyword_rank
        FROM source_chunks ch
        JOIN sources s ON s.id = ch.source_id
        LEFT JOIN vector_hits v ON v.id = ch.id
        LEFT JOIN keyword_hits k ON k.id = ch.id
        WHERE v.id IS NOT NULL OR k.id IS NOT NULL
        ORDER BY score DESC, ch.id
        LIMIT ${topK}
      `);

      return result.rows.map((r) => ({
        chunkId: r.chunk_id,
        sourceId: r.source_id,
        sourceTitle: r.source_title,
        sourceDomain: r.source_domain,
        content: r.content,
        pageStart: r.page_start,
        pageEnd: r.page_end,
        score: Number(r.score),
        vectorRank: r.vector_rank,
        keywordRank: r.keyword_rank,
      }));
    },
  };
}

export type SearchService = ReturnType<typeof createSearchService>;
