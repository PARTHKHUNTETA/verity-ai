import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../../infrastructure/database/client.js";
import {
  claimEvidence,
  claims,
  evalCases,
  evalResults,
  evalRuns,
  evidence,
  reports,
  researchRuns,
  researchTasks,
  runScorecards,
  runSources,
  sources,
  type EvalCase,
  type EvalRun,
} from "../../../infrastructure/database/schema/index.js";
import { LlmError, type LlmClient } from "../../../infrastructure/llm/index.js";
import type { AgentRuntime } from "../../agent/agent-runtime.js";
import type { RunConfig } from "../../agent/stages/context.js";
import {
  buildPointsJudgeInput,
  parseRequiredPoints,
  POINTS_JUDGE_INSTRUCTIONS,
  POINTS_JUDGE_PROMPT_VERSION,
  requiredPointsSchema,
} from "../prompts/points-judge.js";
import {
  forbiddenContentFound,
  forbiddenSourcesCited,
  scoreCase,
  sourceRecall,
  type SourceRef,
} from "./case-scorers.js";
import { summarize } from "./summary.js";

/**
 * Runs an offline eval: every case of the dataset goes through the real agent pipeline with
 * the eval run's frozen config, unattended (no approvals), then gets scored.
 *
 * Resumable: a case that already has a result is skipped, and a case whose research run was
 * interrupted (worker died) is resumed. So the `eval.run` job can simply be retried.
 */

export type EvalRunnerDeps = {
  db: Database;
  runtime: AgentRuntime;
  /** For the required-points judge. */
  llm: LlmClient;
  logger: Logger;
  /** Lets the worker cancel the research run in flight (it maps run ids to abort signals). */
  track?: (researchRunId: string) => { signal: AbortSignal; done: () => void };
};

export function createEvalRunner({ db, runtime, llm, logger, track }: EvalRunnerDeps) {
  async function currentStatus(evalRunId: string) {
    const [row] = await db
      .select({ status: evalRuns.status })
      .from(evalRuns)
      .where(eq(evalRuns.id, evalRunId));
    return row?.status;
  }

  /** The research run for this case: an existing one (resume) or a new one. */
  async function researchRunFor(evalRun: EvalRun, evalCase: EvalCase) {
    const [existing] = await db
      .select({ id: researchRuns.id, status: researchRuns.status })
      .from(researchRuns)
      .where(
        and(
          eq(researchRuns.organizationId, evalRun.organizationId),
          sql`${researchRuns.config}->'eval'->>'runId' = ${evalRun.id}`,
          sql`${researchRuns.config}->'eval'->>'caseId' = ${evalCase.id}`,
        ),
      )
      .limit(1);
    if (existing) return { id: existing.id, resume: existing.status === "running" };

    const c = evalRun.config;
    const config: RunConfig = {
      collectionIds: c.collectionIds,
      topK: c.topK,
      discovery: { enabled: c.discovery },
      revise: c.revise,
      unattended: true,
      eval: { runId: evalRun.id, caseId: evalCase.id },
    };
    const run = await db.transaction(async (tx) => {
      const [task] = await tx
        .insert(researchTasks)
        .values({
          organizationId: evalRun.organizationId,
          question: evalCase.question,
          instructions: evalCase.instructions,
          origin: "eval",
          createdBy: evalRun.startedBy,
        })
        .returning();
      const [created] = await tx
        .insert(researchRuns)
        .values({
          organizationId: evalRun.organizationId,
          taskId: task!.id,
          startedBy: evalRun.startedBy,
          model: c.model,
          promptVersion: c.pipelineVersion,
          config,
        })
        .returning({ id: researchRuns.id });
      return created!;
    });
    return { id: run.id, resume: false };
  }

  async function scoreResearchRun(evalRun: EvalRun, evalCase: EvalCase, researchRunId: string) {
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, researchRunId));
    const [scorecard] = await db
      .select()
      .from(runScorecards)
      .where(eq(runScorecards.runId, researchRunId));
    const [report] = scorecard
      ? await db.select().from(reports).where(eq(reports.id, scorecard.reportId))
      : await db
          .select()
          .from(reports)
          .where(eq(reports.runId, researchRunId))
          .orderBy(sql`${reports.version} desc`)
          .limit(1);
    const text = report?.contentMd ?? "";

    const sourceCols = {
      url: sources.url,
      canonicalUrl: sources.canonicalUrl,
      doi: sources.doi,
      domain: sources.domain,
      title: sources.title,
    };
    // Found: everything the run discovered or retrieved evidence from. Cited: what the report cites.
    const discovered: SourceRef[] = (
      await db
        .select({ url: runSources.url, title: runSources.title })
        .from(runSources)
        .where(eq(runSources.runId, researchRunId))
    ).map((s) => ({ url: s.url, canonicalUrl: null, doi: null, domain: null, title: s.title }));
    const evidenced: SourceRef[] = await db
      .selectDistinct(sourceCols)
      .from(evidence)
      .innerJoin(sources, eq(sources.id, evidence.sourceId))
      .where(eq(evidence.runId, researchRunId));
    const cited: SourceRef[] = report
      ? await db
          .selectDistinct(sourceCols)
          .from(claimEvidence)
          .innerJoin(claims, eq(claims.id, claimEvidence.claimId))
          .innerJoin(evidence, eq(evidence.id, claimEvidence.evidenceId))
          .innerJoin(sources, eq(sources.id, evidence.sourceId))
          .where(eq(claims.reportId, report.id))
      : [];

    const recall = sourceRecall(evalCase.expectedSources, [...discovered, ...evidenced]);

    let points: ReturnType<typeof parseRequiredPoints> | null = null;
    let judgeError: string | null = null;
    if (evalCase.requiredPoints.length && text) {
      try {
        const result = await llm.generateObject({
          model: evalRun.config.model,
          instructions: POINTS_JUDGE_INSTRUCTIONS,
          input: buildPointsJudgeInput(evalCase.requiredPoints, text),
          schema: requiredPointsSchema,
          schemaName: "required_points",
        });
        points = parseRequiredPoints(result.object, evalCase.requiredPoints);
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        judgeError = err.message;
      }
    }
    const requiredPoints = evalCase.requiredPoints.length
      ? points
        ? points.filter((p) => p.covered).length / points.length
        : 0
      : null;

    const latencyMs =
      run?.startedAt && run.completedAt
        ? run.completedAt.getTime() - run.startedAt.getTime()
        : null;
    const verdict = scoreCase({
      evalCase,
      status: run?.status ?? "missing",
      scorecard: scorecard ?? null,
      sourceRecall: recall.rate,
      requiredPoints: requiredPoints === null ? null : Math.round(requiredPoints * 1000) / 1000,
      forbiddenSourcesCited: forbiddenSourcesCited(evalCase.forbiddenSources, cited),
      forbiddenContentFound: forbiddenContentFound(evalCase.forbiddenContent, text),
      latencyMs,
      costUsd: run?.costUsd ?? null,
    });
    if (judgeError) verdict.failures.push(`Required-points judge failed: ${judgeError}`);

    await db
      .insert(evalResults)
      .values({
        organizationId: evalRun.organizationId,
        evalRunId: evalRun.id,
        caseId: evalCase.id,
        researchRunId,
        scores: verdict.scores,
        passed: verdict.passed && !judgeError,
        failures: verdict.failures,
        details: {
          matchedSources: recall.matched,
          points,
          pointsJudgePromptVersion: POINTS_JUDGE_PROMPT_VERSION,
          errorCode: run?.errorCode ?? null,
        },
      })
      .onConflictDoNothing();
  }

  async function finish(evalRunId: string) {
    const rows = await db
      .select({
        scores: evalResults.scores,
        passed: evalResults.passed,
        category: evalCases.category,
      })
      .from(evalResults)
      .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
      .where(eq(evalResults.evalRunId, evalRunId));
    const summary = summarize(rows);
    await db
      .update(evalRuns)
      .set({ status: "completed", summary, completedAt: new Date() })
      .where(and(eq(evalRuns.id, evalRunId), eq(evalRuns.status, "running")));
    return summary;
  }

  return {
    /** Executes (or resumes) an eval run. Returns the summary, or null if it didn't finish. */
    async execute(evalRunId: string) {
      // Claim: queued → running (a running one is a retried job resuming).
      const [claimed] = await db
        .update(evalRuns)
        .set({ status: "running", startedAt: sql`coalesce(${evalRuns.startedAt}, now())` })
        .where(and(eq(evalRuns.id, evalRunId), inArray(evalRuns.status, ["queued", "running"])))
        .returning();
      if (!claimed) return null;
      const evalRun = claimed;

      try {
        const cases = await db
          .select()
          .from(evalCases)
          .where(eq(evalCases.datasetId, evalRun.datasetId))
          .orderBy(asc(evalCases.position), asc(evalCases.createdAt))
          .limit(evalRun.config.limit ?? 10_000);
        const done = new Set(
          (
            await db
              .select({ caseId: evalResults.caseId })
              .from(evalResults)
              .where(eq(evalResults.evalRunId, evalRun.id))
          ).map((r) => r.caseId),
        );

        for (const evalCase of cases) {
          if (done.has(evalCase.id)) continue;
          if ((await currentStatus(evalRun.id)) !== "running") {
            logger.info({ evalRunId }, "Eval run stopped");
            return null;
          }
          const { id: researchRunId, resume } = await researchRunFor(evalRun, evalCase);
          const tracked = track?.(researchRunId);
          try {
            await runtime.runResearch(researchRunId, { resume, signal: tracked?.signal });
          } finally {
            tracked?.done();
          }
          // Cancelled while this case ran: don't score a half-finished run.
          if ((await currentStatus(evalRun.id)) !== "running") return null;
          await scoreResearchRun(evalRun, evalCase, researchRunId);
          logger.info({ evalRunId, caseId: evalCase.id }, "Eval case scored");
        }
        const summary = await finish(evalRun.id);
        logger.info({ evalRunId, passRate: summary.passRate }, "Eval run completed");
        return summary;
      } catch (err) {
        logger.error({ err, evalRunId }, "Eval run failed");
        await db
          .update(evalRuns)
          .set({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date(),
          })
          .where(and(eq(evalRuns.id, evalRunId), eq(evalRuns.status, "running")));
        return null;
      }
    },
  };
}

export type EvalRunner = ReturnType<typeof createEvalRunner>;

/** Research runs of an eval run that are still going (to cancel them with the eval run). */
export async function activeResearchRuns(db: Database, organizationId: string, evalRunId: string) {
  return db
    .select({ id: researchRuns.id, stage: researchRuns.stage })
    .from(researchRuns)
    .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
    .where(
      and(
        eq(researchRuns.organizationId, organizationId),
        eq(researchTasks.origin, "eval"),
        isNull(researchTasks.deletedAt),
        inArray(researchRuns.status, ["queued", "running", "awaiting_approval"]),
        sql`${researchRuns.config}->'eval'->>'runId' = ${evalRunId}`,
      ),
    );
}
