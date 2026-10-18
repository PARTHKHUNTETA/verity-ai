import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../../infrastructure/database/client.js";
import {
  claimEvidence,
  claims,
  evidence,
  reports,
  runSources,
  sourceChunks,
  sources,
  subQuestions,
} from "../../../infrastructure/database/schema/index.js";
import { extractClaims } from "../citations.js";
import {
  buildReportInput,
  REPORT_INSTRUCTIONS,
  REPORT_PROMPT_VERSION,
  REVISION_INSTRUCTIONS,
  REVISION_PROMPT_VERSION,
  type RevisionFeedback,
} from "../prompts/report.js";
import type { StageContext } from "./context.js";

/**
 * Synthesizing: stream the structured report (summary, findings per sub-question, comparison
 * table, research gaps, limitations) citing evidence [n]. Afterwards, cited sentences become
 * claims, discovered sources that got cited are marked "used", and each sub-question's
 * coverage is recorded (answered / partial / unanswered).
 *
 * Phase 10: the evaluation stage calls this again with the judge's feedback to write version 2
 * of the report (the revision loop). Returns the new report's id.
 */
export async function synthesizeStage(
  ctx: StageContext,
  { version = 1, revision }: { version?: number; revision?: RevisionFeedback } = {},
): Promise<string> {
  const { db, run } = ctx;
  // Resume: start this version clean (cascades to its claims).
  await db.delete(reports).where(and(eq(reports.runId, run.id), eq(reports.version, version)));

  const sqs = await db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, run.id))
    .orderBy(asc(subQuestions.position));
  const rows = await db
    .select({
      evidence,
      sourceTitle: sources.title,
      domain: sources.domain,
      pageStart: sourceChunks.pageStart,
      pageEnd: sourceChunks.pageEnd,
    })
    .from(evidence)
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .leftJoin(sourceChunks, eq(sourceChunks.id, evidence.chunkId))
    .where(eq(evidence.runId, run.id))
    .orderBy(asc(evidence.rank));
  const position = new Map(sqs.map((sq) => [sq.id, sq.position]));

  const [report] = await db
    .insert(reports)
    .values({
      organizationId: run.organizationId,
      runId: run.id,
      version,
      title: ctx.state.title,
    })
    .returning();

  // Streamed text is buffered: one event per ~100 ms, a DB save per ~1 s.
  let content = "";
  let published = 0;
  let persisted = 0;
  const flush = async () => {
    if (content.length > published) {
      const text = content.slice(published);
      const offset = published;
      published = content.length;
      await ctx.events.publish({ type: "delta", runId: run.id, offset, text, version });
    }
  };
  const persist = async () => {
    if (content.length > persisted) {
      persisted = content.length;
      await db.update(reports).set({ contentMd: content }).where(eq(reports.id, report!.id));
    }
  };
  const logError = (err: unknown) =>
    ctx.logger.warn({ err, runId: run.id }, "Progress update failed");
  const publishTimer = setInterval(() => void flush().catch(logError), ctx.publishIntervalMs);
  const persistTimer = setInterval(() => void persist().catch(logError), ctx.persistIntervalMs);
  const stopTimers = async () => {
    clearInterval(publishTimer);
    clearInterval(persistTimer);
    await flush().catch(logError);
  };

  const started = Date.now();
  let result;
  try {
    result = await ctx.llm.streamText({
      model: run.model,
      instructions: revision ? REVISION_INSTRUCTIONS : REPORT_INSTRUCTIONS,
      input: buildReportInput({
        question: ctx.task.question,
        instructions: ctx.task.instructions,
        title: ctx.state.title,
        subQuestions: sqs.map((sq) => sq.text),
        evidence: rows.map((r) => ({
          number: r.evidence.rank,
          subQuestion: position.get(r.evidence.subQuestionId ?? "") ?? 0,
          stance: r.evidence.stance ?? "neutral",
          confidence: r.evidence.confidence ?? 0,
          quote: r.evidence.quote,
          sourceTitle: r.sourceTitle,
          origin: r.domain ?? "your documents",
          pages:
            r.pageStart === null
              ? null
              : r.pageEnd && r.pageEnd !== r.pageStart
                ? `pp. ${r.pageStart}–${r.pageEnd}`
                : `p. ${r.pageStart}`,
        })),
        analysis: ctx.state.analysis,
        revision,
      }),
      onDelta: (text) => {
        content += text;
      },
      signal: ctx.signal,
    });
  } catch (err) {
    await stopTimers();
    await persist().catch(logError);
    throw err;
  }
  await stopTimers();
  const costUsd = ctx.trackUsage(result.model, result.usage);

  const byNumber = new Map(rows.map((r) => [r.evidence.rank, r.evidence]));
  const { claims: extracted, invalidCitations } = extractClaims(
    result.text,
    new Set(byNumber.keys()),
  );
  await db.transaction(async (tx) => {
    await tx
      .update(reports)
      .set({ contentMd: result.text, status: "final" })
      .where(eq(reports.id, report!.id));
    if (extracted.length) {
      const inserted = await tx
        .insert(claims)
        .values(
          extracted.map((c) => ({
            organizationId: run.organizationId,
            reportId: report!.id,
            position: c.position,
            section: c.section,
            text: c.text,
          })),
        )
        .returning({ id: claims.id, position: claims.position });
      const idByPosition = new Map(inserted.map((c) => [c.position, c.id]));
      await tx.insert(claimEvidence).values(
        extracted.flatMap((c) =>
          c.citations.map((n) => ({
            claimId: idByPosition.get(c.position)!,
            evidenceId: byNumber.get(n)!.id,
            citationNumber: n,
          })),
        ),
      );
    }
    await applyReportOutcome(tx, run.id, report!.id);
  });

  await ctx.recordStep({
    stage: revision ? "evaluating" : "synthesizing",
    type: "llm_call",
    input: {
      promptVersion: revision ? REVISION_PROMPT_VERSION : REPORT_PROMPT_VERSION,
      evidence: rows.length,
      ...(revision && { revisionOf: version - 1, flagged: revision.flagged.length }),
    },
    output: { characters: result.text.length, claims: extracted.length, invalidCitations },
    model: result.model,
    tokensInput: result.usage.inputTokens,
    tokensOutput: result.usage.outputTokens,
    costUsd,
    durationMs: Date.now() - started,
  });
  return report!.id;
}

/**
 * Records what a report version means for the run: discovered sources it cites are "used",
 * and each sub-question's coverage is answered (a claim cites its evidence), partial (evidence
 * exists but the report doesn't cite it) or unanswered. Called for the version that is kept.
 */
export async function applyReportOutcome(db: DbExecutor, runId: string, reportId: string) {
  const cited = await db
    .selectDistinct({ id: evidence.id, sourceId: evidence.sourceId })
    .from(claimEvidence)
    .innerJoin(claims, eq(claims.id, claimEvidence.claimId))
    .innerJoin(evidence, eq(evidence.id, claimEvidence.evidenceId))
    .where(eq(claims.reportId, reportId));
  const citedIds = new Set(cited.map((c) => c.id));
  const citedSourceIds = [...new Set(cited.map((c) => c.sourceId))];

  await db
    .update(runSources)
    .set({ status: "acquired" })
    .where(and(eq(runSources.runId, runId), eq(runSources.status, "used")));
  if (citedSourceIds.length) {
    await db
      .update(runSources)
      .set({ status: "used" })
      .where(and(eq(runSources.runId, runId), inArray(runSources.sourceId, citedSourceIds)));
  }

  const all = await db
    .select({ id: evidence.id, subQuestionId: evidence.subQuestionId })
    .from(evidence)
    .where(eq(evidence.runId, runId));
  const sqs = await db
    .select({ id: subQuestions.id })
    .from(subQuestions)
    .where(eq(subQuestions.runId, runId));
  for (const sq of sqs) {
    const sqEvidence = all.filter((e) => e.subQuestionId === sq.id);
    const coverage = sqEvidence.some((e) => citedIds.has(e.id))
      ? "answered"
      : sqEvidence.length
        ? "partial"
        : "unanswered";
    await db.update(subQuestions).set({ coverage }).where(eq(subQuestions.id, sq.id));
  }
}
