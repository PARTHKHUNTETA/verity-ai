import { asc, eq } from "drizzle-orm";
import { subQuestions } from "../../../infrastructure/database/schema/index.js";
import type { Passage } from "../state.js";
import type { StageContext } from "./context.js";

const MAX_PASSAGES = 20;

/**
 * Retrieving: hybrid search per sub-question over the user's collections plus the documents
 * acquired for this run. Each passage is kept once (for the first sub-question that found it)
 * and numbered P1..Pn for evidence extraction.
 */
export async function retrieveStage(ctx: StageContext): Promise<void> {
  const started = Date.now();
  const sqs = await ctx.db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, ctx.run.id))
    .orderBy(asc(subQuestions.position));

  const seen = new Set<string>();
  const passages: Passage[] = [];
  const perSubQuestion: Record<number, number> = {};
  for (const sq of sqs) {
    ctx.checkCancelled();
    const hits = await ctx.search.search(sq.text, {
      organizationId: ctx.run.organizationId,
      collectionIds: ctx.config.collectionIds ?? [],
      sourceIds: ctx.state.acquiredSourceIds,
      topK: ctx.config.topK ?? 4,
    });
    perSubQuestion[sq.position] = 0;
    for (const hit of hits) {
      if (seen.has(hit.chunkId) || passages.length >= MAX_PASSAGES) continue;
      seen.add(hit.chunkId);
      perSubQuestion[sq.position]!++;
      passages.push({
        number: passages.length + 1,
        subQuestionId: sq.id,
        chunkId: hit.chunkId,
        sourceId: hit.sourceId,
        sourceTitle: hit.sourceTitle,
        origin: hit.sourceDomain ?? "your documents",
        pageStart: hit.pageStart,
        pageEnd: hit.pageEnd,
        content: hit.content,
        score: hit.score,
      });
    }
  }
  ctx.state.passages = passages;

  await ctx.recordStep({
    stage: "retrieving",
    type: "tool_call",
    input: {
      tool: "rag",
      subQuestions: sqs.length,
      collectionIds: ctx.config.collectionIds ?? [],
      acquiredSources: ctx.state.acquiredSourceIds.length,
    },
    output: { passages: passages.length, perSubQuestion },
    durationMs: Date.now() - started,
  });
}
