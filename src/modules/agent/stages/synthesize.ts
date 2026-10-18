import { and, asc, eq, inArray } from "drizzle-orm";
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
import { buildReportInput, REPORT_INSTRUCTIONS, REPORT_PROMPT_VERSION } from "../prompts/report.js";
import type { StageContext } from "./context.js";

/**
 * Synthesizing: stream the structured report (summary, findings per sub-question, comparison
 * table, research gaps, limitations) citing evidence [n]. Afterwards, cited sentences become
 * claims, discovered sources that got cited are marked "used", and each sub-question's
 * coverage is recorded (answered / partial / unanswered).
 */
export async function synthesizeStage(ctx: StageContext): Promise<void> {
  const { db, run } = ctx;
  await db.delete(reports).where(eq(reports.runId, run.id)); // resume: start clean (cascades to claims)

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
      version: 1,
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
      await ctx.events.publish({ type: "delta", runId: run.id, offset, text });
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
      instructions: REPORT_INSTRUCTIONS,
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
  const citedEvidence = new Set(
    extracted.flatMap((c) => c.citations.map((n) => byNumber.get(n)!.id)),
  );
  const citedSourceIds = [
    ...new Set(
      rows.filter((r) => citedEvidence.has(r.evidence.id)).map((r) => r.evidence.sourceId),
    ),
  ];

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
    if (citedSourceIds.length) {
      await tx
        .update(runSources)
        .set({ status: "used" })
        .where(and(eq(runSources.runId, run.id), inArray(runSources.sourceId, citedSourceIds)));
    }
    // Coverage: answered = a claim cites its evidence; partial = evidence but uncited; else unanswered.
    for (const sq of sqs) {
      const sqEvidence = rows.filter((r) => r.evidence.subQuestionId === sq.id);
      const coverage = sqEvidence.some((r) => citedEvidence.has(r.evidence.id))
        ? "answered"
        : sqEvidence.length
          ? "partial"
          : "unanswered";
      await tx.update(subQuestions).set({ coverage }).where(eq(subQuestions.id, sq.id));
    }
  });

  await ctx.recordStep({
    stage: "synthesizing",
    type: "llm_call",
    input: { promptVersion: REPORT_PROMPT_VERSION, evidence: rows.length },
    output: { characters: result.text.length, claims: extracted.length, invalidCitations },
    model: result.model,
    tokensInput: result.usage.inputTokens,
    tokensOutput: result.usage.outputTokens,
    costUsd,
    durationMs: Date.now() - started,
  });
}
