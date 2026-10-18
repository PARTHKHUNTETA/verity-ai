import { asc, eq } from "drizzle-orm";
import { evidence, subQuestions } from "../../../infrastructure/database/schema/index.js";
import {
  buildExtractInput,
  evidenceExtractionSchema,
  EXTRACT_INSTRUCTIONS,
  EXTRACT_PROMPT_VERSION,
} from "../prompts/extract.js";
import type { StageContext } from "./context.js";

/** Normalizes text for the verbatim check: case, whitespace, curly quotes, hyphenation. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/-\s+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracting: for each sub-question, the model picks exact quotes from its passages, with a
 * stance and a confidence. Every quote is checked to really occur in the passage it claims to
 * come from; quotes that don't are discarded (and counted: a hallucination signal).
 * Evidence is numbered [1..n] across the run; the report cites these numbers.
 */
export async function extractStage(ctx: StageContext): Promise<void> {
  await ctx.db.delete(evidence).where(eq(evidence.runId, ctx.run.id)); // resume: start clean
  const sqs = await ctx.db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, ctx.run.id))
    .orderBy(asc(subQuestions.position));

  let rank = 0;
  for (const sq of sqs) {
    ctx.checkCancelled();
    const passages = ctx.state.passages.filter((p) => p.subQuestionId === sq.id);
    if (passages.length === 0) continue;

    const started = Date.now();
    const { object, model, usage } = await ctx.llm.generateObject({
      model: ctx.run.model,
      instructions: EXTRACT_INSTRUCTIONS,
      input: buildExtractInput(sq.text, passages),
      schema: evidenceExtractionSchema,
      schemaName: "evidence_extraction",
      signal: ctx.signal,
    });
    const costUsd = ctx.trackUsage(model, usage);

    const byNumber = new Map(passages.map((p) => [p.number, p]));
    const accepted: typeof object.evidence = [];
    const rejected: Array<{ passage: number; reason: string }> = [];
    for (const item of object.evidence) {
      const passage = byNumber.get(item.passage);
      if (!passage)
        rejected.push({ passage: item.passage, reason: "not a passage of this sub-question" });
      else if (!normalizeForMatch(passage.content).includes(normalizeForMatch(item.quote))) {
        rejected.push({ passage: item.passage, reason: "quote not found verbatim in the passage" });
      } else accepted.push(item);
    }
    accepted.sort((a, b) => b.confidence - a.confidence);

    if (accepted.length) {
      await ctx.db.insert(evidence).values(
        accepted.map((item) => {
          const passage = byNumber.get(item.passage)!;
          return {
            organizationId: ctx.run.organizationId,
            runId: ctx.run.id,
            subQuestionId: sq.id,
            chunkId: passage.chunkId,
            sourceId: passage.sourceId,
            rank: ++rank,
            quote: item.quote.trim(),
            stance: item.stance,
            confidence: item.confidence,
            note: item.note,
            score: passage.score,
          };
        }),
      );
    }

    await ctx.recordStep({
      stage: "extracting",
      type: "llm_call",
      input: {
        promptVersion: EXTRACT_PROMPT_VERSION,
        subQuestion: sq.position,
        passages: passages.length,
      },
      output: { accepted: accepted.length, rejected },
      model,
      tokensInput: usage.inputTokens,
      tokensOutput: usage.outputTokens,
      costUsd,
      durationMs: Date.now() - started,
    });
  }
}
