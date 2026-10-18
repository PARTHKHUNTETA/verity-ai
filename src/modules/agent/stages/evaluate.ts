import { and, eq, gt } from "drizzle-orm";
import {
  reports,
  runScorecards,
  subQuestions,
} from "../../../infrastructure/database/schema/index.js";
import { evaluateReport, type ReportEvaluation } from "../../evaluation/evaluate-report.js";
import { REVISION_THRESHOLD } from "../../evaluation/targets.js";
import type { StageContext } from "./context.js";
import { applyReportOutcome, synthesizeStage } from "./synthesize.js";

/**
 * Evaluating (Phase 10): score the report, and revise it once if too many claims fail.
 *
 *   evaluate v1 ──claim support ≥ target──▶ scorecard(v1)
 *        │
 *        └─below target──▶ write v2 with the judge's feedback ──▶ evaluate v2
 *                             ──▶ keep whichever version scores better ──▶ scorecard
 *
 * One revision at most: a second pass rarely helps much, and each pass costs a full report.
 * The version that isn't kept stays in the database as "superseded", with its judgments.
 */
export async function evaluateStage(ctx: StageContext): Promise<void> {
  const { db, run } = ctx;
  // Resume: start the stage clean (drop a half-written revision and an old scorecard).
  await db.delete(runScorecards).where(eq(runScorecards.runId, run.id));
  await db.delete(reports).where(and(eq(reports.runId, run.id), gt(reports.version, 1)));
  const [original] = await db
    .update(reports)
    .set({ status: "final" })
    .where(and(eq(reports.runId, run.id), eq(reports.version, 1)))
    .returning();
  if (!original) return; // nothing to evaluate

  const first = await evaluateReport(ctx, original.id);
  let kept: ReportEvaluation = first;
  let revision: ReportEvaluation["extra"]["revision"];

  const rate = first.scores.claimSupportRate;
  if (rate !== null && rate < REVISION_THRESHOLD && first.weakClaims.length) {
    ctx.checkCancelled();
    const revisedId = await synthesizeStage(ctx, {
      version: 2,
      revision: { previousDraft: original.contentMd, flagged: first.weakClaims },
    });
    const second = await evaluateReport(ctx, revisedId);
    const better = (second.scores.claimSupportRate ?? 0) >= rate;
    kept = better ? second : first;
    const dropped = better ? original.id : revisedId;
    await db.transaction(async (tx) => {
      await tx.update(reports).set({ status: "superseded" }).where(eq(reports.id, dropped));
      // synthesizeStage applied v2's outcome; restore v1's if v1 stays.
      if (!better) await applyReportOutcome(tx, run.id, original.id);
    });
    revision = {
      fromReportId: original.id,
      before: {
        claimSupportRate: first.scores.claimSupportRate,
        citationAccuracy: first.scores.citationAccuracy,
      },
      kept: better ? "revised" : "original",
    };
  }

  // Coverage on the sub-questions follows the version that is shown.
  for (const c of kept.coverageStatuses) {
    await db
      .update(subQuestions)
      .set({ coverage: c.coverage })
      .where(eq(subQuestions.id, c.subQuestionId));
  }

  const latencyMs = run.startedAt ? Date.now() - run.startedAt.getTime() : null;
  await db.insert(runScorecards).values({
    organizationId: run.organizationId,
    runId: run.id,
    reportId: kept.reportId,
    ...kept.scores,
    passed: kept.passed,
    latencyMs,
    costUsd: ctx.state.usage.costUsd,
    extra: { ...kept.extra, ...(revision && { revision }) },
  });

  await ctx.recordStep({
    stage: "evaluating",
    type: "observation",
    input: { reportVersions: revision ? 2 : 1 },
    output: {
      ...kept.scores,
      passed: kept.passed,
      flags: kept.extra.flags,
      ...(revision && { revision }),
    },
  });
}
