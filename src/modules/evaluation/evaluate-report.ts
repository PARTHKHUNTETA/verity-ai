import { and, asc, eq, inArray } from "drizzle-orm";
import {
  approvals,
  claimEvidence,
  claimJudgments,
  claims,
  evidence,
  policyDecisions,
  reports,
  sources,
  subQuestions,
  toolCalls,
  type ClaimVerdict,
  type CoverageStatus,
  type ScorecardExtra,
} from "../../infrastructure/database/schema/index.js";
import { LlmError } from "../../infrastructure/llm/index.js";
import { extractClaims } from "../agent/citations.js";
import type { StageContext } from "../agent/stages/context.js";
import {
  buildClaimJudgeInput,
  CLAIM_JUDGE_BATCH,
  CLAIM_JUDGE_INSTRUCTIONS,
  CLAIM_JUDGE_PROMPT_VERSION,
  claimJudgmentsSchema,
  parseClaimJudgments,
  type ClaimToJudge,
  type ParsedJudgment,
} from "./prompts/claim-judge.js";
import {
  buildTaskJudgeInput,
  TASK_JUDGE_INSTRUCTIONS,
  TASK_JUDGE_PROMPT_VERSION,
} from "./prompts/task-judge.js";
import {
  citationAccuracy,
  citationValidity,
  claimSupport,
  contradictionHandling,
  coverage,
  meanReliability,
  policyCompliance,
  sourceReliability,
  taskCompletionSchema,
  taskCompletionScore,
  type TaskCompletionJudgment,
} from "./scorers/index.js";
import { TARGETS, type TargetMetric } from "./targets.js";

/**
 * Online evaluation of one report version (docs/system-design.md §6):
 *
 *   1. the claim judge checks every cited claim against the quotes it cites (LLM, batched);
 *   2. the task judge scores how completely the report does what was asked (LLM);
 *   3. deterministic scorers: citation validity, coverage, source reliability, contradiction
 *      handling, policy compliance.
 *
 * Judgments are stored per claim; the metrics are returned for the scorecard. If a judge call
 * fails, the scorecard still gets the deterministic metrics and the judge metrics stay null.
 */

export type ReportScores = {
  claimSupportRate: number | null;
  citationAccuracy: number | null;
  citationValidity: number | null;
  sourceReliability: number | null;
  coverage: number | null;
  taskCompletion: number | null;
  policyCompliant: boolean;
};

export type ReportEvaluation = {
  reportId: string;
  scores: ReportScores;
  passed: boolean;
  extra: ScorecardExtra;
  /** Claims the judge did not fully accept: the revision loop's feedback. */
  weakClaims: Array<{ text: string; verdict: ClaimVerdict; rationale: string }>;
  /** Coverage per sub-question for this version (applied if this version is kept). */
  coverageStatuses: Array<{ subQuestionId: string; coverage: CoverageStatus }>;
};

export async function evaluateReport(
  ctx: StageContext,
  reportId: string,
): Promise<ReportEvaluation> {
  const { db, run } = ctx;
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId));
  const claimRows = await db
    .select()
    .from(claims)
    .where(eq(claims.reportId, reportId))
    .orderBy(asc(claims.position));
  const claimIds = claimRows.map((c) => c.id);
  // Resume: judge this version afresh.
  if (claimIds.length)
    await db.delete(claimJudgments).where(inArray(claimJudgments.claimId, claimIds));

  const links = claimIds.length
    ? await db
        .select({
          claimId: claimEvidence.claimId,
          number: claimEvidence.citationNumber,
          evidenceId: evidence.id,
          quote: evidence.quote,
          sourceId: sources.id,
          sourceTitle: sources.title,
          domain: sources.domain,
          type: sources.type,
          doi: sources.doi,
          publishedAt: sources.publishedAt,
          deletedAt: sources.deletedAt,
          status: sources.status,
        })
        .from(claimEvidence)
        .innerJoin(evidence, eq(evidence.id, claimEvidence.evidenceId))
        .innerJoin(sources, eq(sources.id, evidence.sourceId))
        .where(inArray(claimEvidence.claimId, claimIds))
        .orderBy(asc(claimEvidence.citationNumber))
    : [];
  const runEvidence = await db
    .select({
      id: evidence.id,
      rank: evidence.rank,
      stance: evidence.stance,
      subQuestionId: evidence.subQuestionId,
    })
    .from(evidence)
    .where(eq(evidence.runId, run.id));
  const sqs = await db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, run.id))
    .orderBy(asc(subQuestions.position));

  // 1. Claim judge, in parallel batches.
  const toJudge: ClaimToJudge[] = claimRows.map((c) => ({
    number: c.position,
    text: c.text,
    citations: links
      .filter((l) => l.claimId === c.id)
      .map((l) => ({
        number: l.number,
        quote: l.quote,
        source: `${l.sourceTitle} (${l.domain ?? "your documents"})`,
      })),
  }));
  let judgeError: string | undefined;
  const judged = new Map<number, ParsedJudgment>();
  let judgeModel = run.model;
  try {
    const batches = chunk(toJudge, CLAIM_JUDGE_BATCH);
    const results = await Promise.all(
      batches.map(async (batch) => {
        const started = Date.now();
        const result = await ctx.llm.generateObject({
          model: run.model,
          instructions: CLAIM_JUDGE_INSTRUCTIONS,
          input: buildClaimJudgeInput(ctx.task.question, batch),
          schema: claimJudgmentsSchema,
          schemaName: "claim_judgments",
          signal: ctx.signal,
        });
        return { batch, result, ms: Date.now() - started };
      }),
    );
    for (const { batch, result, ms } of results) {
      judgeModel = result.model;
      const costUsd = ctx.trackUsage(result.model, result.usage);
      const parsed = parseClaimJudgments(
        result.object,
        batch.map((c) => ({ number: c.number, citations: c.citations.map((q) => q.number) })),
      );
      for (const [n, j] of parsed) judged.set(n, j);
      await ctx.recordStep({
        stage: "evaluating",
        type: "llm_call",
        input: {
          promptVersion: CLAIM_JUDGE_PROMPT_VERSION,
          reportVersion: report!.version,
          claims: batch.length,
        },
        output: { verdicts: countBy([...parsed.values()].map((j) => j.verdict)) },
        model: result.model,
        tokensInput: result.usage.inputTokens,
        tokensOutput: result.usage.outputTokens,
        costUsd,
        durationMs: ms,
      });
    }
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    judgeError = `Claim judge failed: ${err.message}`;
    judged.clear();
  }

  if (judged.size) {
    await db.insert(claimJudgments).values(
      claimRows.flatMap((c) => {
        const j = judged.get(c.position);
        return j
          ? [
              {
                organizationId: run.organizationId,
                claimId: c.id,
                verdict: j.verdict,
                citationAccurate: j.citationAccurate,
                citations: j.citations,
                rationale: j.rationale,
                judgeModel,
                judgePromptVersion: CLAIM_JUDGE_PROMPT_VERSION,
              },
            ]
          : [];
      }),
    );
  }

  // 2. Task judge.
  let task: TaskCompletionJudgment | null = null;
  try {
    const started = Date.now();
    const result = await ctx.llm.generateObject({
      model: run.model,
      instructions: TASK_JUDGE_INSTRUCTIONS,
      input: buildTaskJudgeInput({
        question: ctx.task.question,
        instructions: ctx.task.instructions,
        subQuestions: sqs.map((sq) => sq.text),
        report: report!.contentMd,
      }),
      schema: taskCompletionSchema,
      schemaName: "task_completion",
      signal: ctx.signal,
    });
    task = result.object;
    const costUsd = ctx.trackUsage(result.model, result.usage);
    await ctx.recordStep({
      stage: "evaluating",
      type: "llm_call",
      input: { promptVersion: TASK_JUDGE_PROMPT_VERSION, reportVersion: report!.version },
      output: { score: taskCompletionScore(task), missing: task.missing },
      model: result.model,
      tokensInput: result.usage.inputTokens,
      tokensOutput: result.usage.outputTokens,
      costUsd,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    judgeError = [judgeError, `Task judge failed: ${err.message}`].filter(Boolean).join("; ");
  }

  // 3. Deterministic scorers.
  const support = claimSupport([...judged.values()].map((j) => j.verdict));
  const accuracy = citationAccuracy([...judged.values()]);
  const { invalidCitations } = extractClaims(
    report!.contentMd,
    new Set(runEvidence.map((e) => e.rank)),
  );
  const unresolvable = links.filter((l) => l.deletedAt !== null || l.status !== "ready").length;
  const validity = citationValidity({
    linked: links.length,
    unresolvable,
    invalidNumbers: invalidCitations,
  });

  const citedEvidence = new Set(links.map((l) => l.evidenceId));
  const coverageStatuses = sqs.map((sq) => {
    const sqEvidence = runEvidence.filter((e) => e.subQuestionId === sq.id);
    const status: CoverageStatus = sqEvidence.some((e) => citedEvidence.has(e.id))
      ? "answered"
      : sqEvidence.length
        ? "partial"
        : "unanswered";
    return { subQuestionId: sq.id, coverage: status };
  });

  const citedSources = new Map(links.map((l) => [l.sourceId, l]));
  const reliability = [...citedSources.values()].map((s) => ({
    sourceId: s.sourceId,
    title: s.sourceTitle,
    ...sourceReliability({
      type: s.type,
      domain: s.domain,
      doi: s.doi,
      publishedAt: s.publishedAt,
    }),
  }));
  for (const r of reliability) {
    await db.update(sources).set({ reliabilityScore: r.score }).where(eq(sources.id, r.sourceId));
  }

  const policy = await checkPolicyCompliance(ctx);

  const scores: ReportScores = {
    claimSupportRate: judgeError && !judged.size ? null : round(support.rate),
    citationAccuracy: judged.size ? round(accuracy.rate) : null,
    citationValidity: round(validity),
    sourceReliability: meanReliability(reliability.map((r) => r.score)),
    coverage: round(coverage(coverageStatuses.map((c) => c.coverage))),
    taskCompletion: task ? taskCompletionScore(task) : null,
    policyCompliant: policy.compliant,
  };
  const flags: string[] = (Object.keys(TARGETS) as TargetMetric[]).filter((m) => {
    const value = scores[m];
    return value !== null && value < TARGETS[m];
  });
  if (!policy.compliant) flags.push("policyCompliant");
  if (!claimRows.length) flags.push("noCitedClaims");

  return {
    reportId,
    scores,
    // Passing needs the judge's verdicts: an unjudged report is not a verified one.
    passed: flags.length === 0 && scores.claimSupportRate !== null,
    extra: {
      claims: {
        total: support.total,
        supported: support.supported,
        partial: support.partial,
        unsupported: support.unsupported,
      },
      citations: {
        total: links.length,
        supporting: accuracy.supporting,
        invalidNumbers: invalidCitations,
        unresolvable,
      },
      contradictionHandling: round(contradictionHandling(runEvidence, citedEvidence)),
      taskCompletion: task ? { missing: task.missing, rationale: task.rationale } : null,
      policy: { violations: policy.violations },
      sources: reliability,
      flags,
      ...(judgeError && { judgeError }),
    },
    weakClaims: claimRows.flatMap((c) => {
      const j = judged.get(c.position);
      return j && j.verdict !== "supported"
        ? [{ text: c.text, verdict: j.verdict, rationale: j.rationale }]
        : [];
    }),
    coverageStatuses,
  };
}

async function checkPolicyCompliance(ctx: StageContext) {
  const { db, run } = ctx;
  const calls = await db
    .select({ id: toolCalls.id, tool: toolCalls.tool, status: toolCalls.status })
    .from(toolCalls)
    .where(eq(toolCalls.runId, run.id));
  const decisions = await db
    .select({ toolCallId: policyDecisions.toolCallId, decision: policyDecisions.decision })
    .from(policyDecisions)
    .where(eq(policyDecisions.runId, run.id))
    .orderBy(asc(policyDecisions.createdAt));
  const approvalRows = await db
    .select({ toolCallId: approvals.toolCallId, status: approvals.status })
    .from(approvals)
    .where(and(eq(approvals.runId, run.id), eq(approvals.kind, "tool_call")));
  return policyCompliance(
    calls.map((c) => ({
      tool: c.tool,
      status: c.status,
      decisions: decisions.filter((d) => d.toolCallId === c.id).map((d) => d.decision),
      approval: approvalRows.find((a) => a.toolCallId === c.id)?.status ?? null,
    })),
  );
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
