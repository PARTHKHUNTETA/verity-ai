import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  approvals,
  evidence,
  policyDecisions,
  reports,
  researchRuns,
  researchTasks,
  runSources,
  sourceChunks,
  subQuestions,
  toolCalls,
  sources,
  type ResearchRun,
  type ResearchTask,
} from "../../infrastructure/database/schema/index.js";

/** Tenant rule: every function filters by organizationId. */

export async function insertTask(
  db: DbExecutor,
  values: { organizationId: string; createdBy: string; question: string; instructions?: string },
): Promise<ResearchTask> {
  const [task] = await db.insert(researchTasks).values(values).returning();
  return task!;
}

export async function insertRun(
  db: DbExecutor,
  values: {
    organizationId: string;
    taskId: string;
    startedBy: string;
    model: string;
    promptVersion: string;
    config: Record<string, unknown>;
  },
): Promise<ResearchRun> {
  const [run] = await db.insert(researchRuns).values(values).returning();
  return run!;
}

export async function findTask(db: DbExecutor, organizationId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(researchTasks)
    .where(
      and(
        eq(researchTasks.id, taskId),
        eq(researchTasks.organizationId, organizationId),
        isNull(researchTasks.deletedAt),
      ),
    );
  return task;
}

export async function listTasks(db: DbExecutor, organizationId: string, limit = 50) {
  return db
    .select()
    .from(researchTasks)
    .where(and(eq(researchTasks.organizationId, organizationId), isNull(researchTasks.deletedAt)))
    .orderBy(desc(researchTasks.createdAt))
    .limit(limit);
}

export async function listRunsForTasks(db: DbExecutor, organizationId: string, taskIds: string[]) {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(researchRuns)
    .where(
      and(eq(researchRuns.organizationId, organizationId), inArray(researchRuns.taskId, taskIds)),
    )
    .orderBy(desc(researchRuns.createdAt));
}

export async function findRun(db: DbExecutor, organizationId: string, runId: string) {
  const [row] = await db
    .select({ run: researchRuns, task: researchTasks })
    .from(researchRuns)
    .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
    .where(and(eq(researchRuns.id, runId), eq(researchRuns.organizationId, organizationId)));
  return row;
}

export async function findLatestReport(db: DbExecutor, organizationId: string, runId: string) {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.runId, runId), eq(reports.organizationId, organizationId)))
    // The version shown: the newest one that hasn't been superseded by the evaluation stage.
    .orderBy(sql`${reports.status} = 'superseded'`, desc(reports.version))
    .limit(1);
  return report;
}

/** Cancels only if the run hasn't finished yet. Returns the run when this call cancelled it. */
export async function cancelRun(db: DbExecutor, organizationId: string, runId: string) {
  const [run] = await db
    .update(researchRuns)
    .set({ status: "cancelled", errorCode: "CANCELLED", errorMessage: "Cancelled by user" })
    .where(
      and(
        eq(researchRuns.id, runId),
        eq(researchRuns.organizationId, organizationId),
        inArray(researchRuns.status, ["queued", "running", "awaiting_approval"]),
      ),
    )
    .returning();
  return run;
}

export async function markRunFailed(db: DbExecutor, runId: string, code: string, message: string) {
  await db
    .update(researchRuns)
    .set({ status: "failed", errorCode: code, errorMessage: message, completedAt: new Date() })
    .where(eq(researchRuns.id, runId));
}

/** The passages a run showed the model, with their source, ordered by citation number. */
export async function listCitations(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      number: evidence.rank,
      evidenceId: evidence.id,
      chunkId: evidence.chunkId,
      sourceId: evidence.sourceId,
      sourceTitle: sources.title,
      quote: evidence.quote,
      stance: evidence.stance,
      confidence: evidence.confidence,
      note: evidence.note,
      subQuestionId: evidence.subQuestionId,
      pageStart: sourceChunks.pageStart,
      pageEnd: sourceChunks.pageEnd,
    })
    .from(evidence)
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .leftJoin(sourceChunks, eq(sourceChunks.id, evidence.chunkId))
    .where(and(eq(evidence.runId, runId), eq(evidence.organizationId, organizationId)))
    .orderBy(asc(evidence.rank));
}

export async function listRunSources(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      id: runSources.id,
      url: runSources.url,
      title: runSources.title,
      provider: runSources.provider,
      discoveredVia: runSources.discoveredVia,
      rank: runSources.rank,
      status: runSources.status,
      reason: runSources.reason,
      sourceId: runSources.sourceId,
    })
    .from(runSources)
    .where(and(eq(runSources.runId, runId), eq(runSources.organizationId, organizationId)))
    .orderBy(asc(runSources.rank));
}

/** The run's plan, with how much evidence each sub-question got. */
export async function listSubQuestions(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      id: subQuestions.id,
      position: subQuestions.position,
      text: subQuestions.text,
      rationale: subQuestions.rationale,
      searchQueries: subQuestions.searchQueries,
      coverage: subQuestions.coverage,
      evidenceCount: count(evidence.id),
    })
    .from(subQuestions)
    .leftJoin(evidence, eq(evidence.subQuestionId, subQuestions.id))
    .where(and(eq(subQuestions.runId, runId), eq(subQuestions.organizationId, organizationId)))
    .groupBy(subQuestions.id)
    .orderBy(asc(subQuestions.position));
}

/** The step timeline (what the agent did, in order). */
export async function listSteps(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      seq: agentSteps.seq,
      stage: agentSteps.stage,
      type: agentSteps.type,
      input: agentSteps.input,
      output: agentSteps.output,
      model: agentSteps.model,
      tokensInput: agentSteps.tokensInput,
      tokensOutput: agentSteps.tokensOutput,
      costUsd: agentSteps.costUsd,
      durationMs: agentSteps.durationMs,
      createdAt: agentSteps.createdAt,
    })
    .from(agentSteps)
    .where(and(eq(agentSteps.runId, runId), eq(agentSteps.organizationId, organizationId)))
    .orderBy(asc(agentSteps.seq));
}

export async function listToolCalls(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      id: toolCalls.id,
      stage: toolCalls.stage,
      tool: toolCalls.tool,
      args: toolCalls.args,
      status: toolCalls.status,
      result: toolCalls.result,
      error: toolCalls.error,
      durationMs: toolCalls.durationMs,
      createdAt: toolCalls.createdAt,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.runId, runId), eq(toolCalls.organizationId, organizationId)))
    .orderBy(asc(toolCalls.createdAt));
}

/** Approvals requested by a run (pending and decided). */
export async function listRunApprovals(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      id: approvals.id,
      kind: approvals.kind,
      summary: approvals.summary,
      status: approvals.status,
      comment: approvals.comment,
      createdAt: approvals.createdAt,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.organizationId, organizationId)))
    .orderBy(asc(approvals.createdAt));
}

/** Gateway decisions that weren't a plain "allow" (denials and approval requests). */
export async function listRunDecisions(db: DbExecutor, organizationId: string, runId: string) {
  return db
    .select({
      id: policyDecisions.id,
      tool: toolCalls.tool,
      args: toolCalls.args,
      decision: policyDecisions.decision,
      matchedRule: policyDecisions.matchedRule,
      reason: policyDecisions.reason,
      policyVersion: policyDecisions.policyVersion,
      createdAt: policyDecisions.createdAt,
    })
    .from(policyDecisions)
    .leftJoin(toolCalls, eq(toolCalls.id, policyDecisions.toolCallId))
    .where(
      and(
        eq(policyDecisions.runId, runId),
        eq(policyDecisions.organizationId, organizationId),
        inArray(policyDecisions.decision, ["deny", "require_approval"]),
      ),
    )
    .orderBy(asc(policyDecisions.createdAt))
    .limit(100);
}
