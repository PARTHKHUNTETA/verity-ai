import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  approvals,
  type Report,
  type ResearchRun,
  type ResearchTask,
} from "../../infrastructure/database/schema/index.js";
import { terminalRunStatuses } from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import type { ResearchJobQueue } from "../../infrastructure/queue/queue.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { PIPELINE_VERSION } from "../agent/pipeline.js";
import {
  findReportRating,
  findScorecard,
  listJudgedClaims,
} from "../evaluation/evaluation.repository.js";
import { getRunTrace } from "../observability/trace.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { can } from "../policies/permissions.js";
import { filterReadable, readableCollectionIds } from "../sources/sources.repository.js";
import type { CreateTaskInput } from "./research.schema.js";
import {
  cancelRun,
  findLatestReport,
  findRun,
  findTask,
  insertRun,
  insertTask,
  listCitations,
  listRunSources,
  listRunsForTasks,
  listRunApprovals,
  listRunDecisions,
  listSteps,
  listSubQuestions,
  listToolCalls,
  listTasks,
  markRunFailed,
} from "./research.repository.js";

export type ResearchDeps = {
  queue: ResearchJobQueue;
  events: RunEventPublisher;
  /** Model recorded on new runs (the worker records the exact version it used). */
  model: string;
  /** Which discovery providers the worker has (shown in the UI). */
  capabilities: { webSearch: string | null; academicSearch: string[] };
};

/** API shapes: only what the frontend needs, with derived fields like durationMs. */
export function toRunDto(run: ResearchRun) {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    stage: run.stage,
    model: run.model,
    promptVersion: run.promptVersion,
    /** Whether this run searches the web/academic databases (shows the discovery stages). */
    discovery: Boolean((run.config as { discovery?: { enabled?: boolean } }).discovery?.enabled),
    tokensInput: run.tokensInput,
    tokensOutput: run.tokensOutput,
    costUsd: run.costUsd,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs:
      run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null,
  };
}

function toTaskDto(task: ResearchTask) {
  return {
    id: task.id,
    question: task.question,
    instructions: task.instructions,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
  };
}

function toReportDto(report: Report | undefined) {
  return report
    ? {
        id: report.id,
        version: report.version,
        title: report.title,
        status: report.status,
        contentMd: report.contentMd,
      }
    : null;
}

export type RunDetail = {
  run: ReturnType<typeof toRunDto>;
  task: ReturnType<typeof toTaskDto>;
  report: ReturnType<typeof toReportDto>;
  /** Passages the model could cite, by number. Available as soon as retrieval finishes. */
  citations: Awaited<ReturnType<typeof listCitations>>;
  /** Sources found by web/academic search and what happened to each. */
  discovered: Awaited<ReturnType<typeof listRunSources>>;
  /** The plan (Phase 7). */
  subQuestions: Awaited<ReturnType<typeof listSubQuestions>>;
  /** What the agent did, step by step. */
  steps: Awaited<ReturnType<typeof listSteps>>;
  /** Tool calls the agent made (search, fetch, rag, run_code). */
  toolCalls: Awaited<ReturnType<typeof listToolCalls>>;
  /** Human approvals this run asked for. */
  approvals: Awaited<ReturnType<typeof listRunApprovals>>;
  /** Policy decisions other than "allow". */
  decisions: Awaited<ReturnType<typeof listRunDecisions>>;
  /** Online evaluation (Phase 10): the scorecard, judged claims and the reader's own ratings. */
  evaluation: {
    scorecard: Awaited<ReturnType<typeof findScorecard>>;
    claims: Awaited<ReturnType<typeof listJudgedClaims>>;
    myReportRating: Awaited<ReturnType<typeof findReportRating>>;
  };
};

/** A re-run keeps the discovery setting of the task's latest run. */
function previousDiscovery(runs: ResearchRun[]): boolean {
  const config = runs[0]?.config as { discovery?: { enabled?: boolean } } | undefined;
  return config?.discovery?.enabled ?? true;
}

export function isTerminal(status: ResearchRun["status"]): boolean {
  return terminalRunStatuses.includes(status);
}

export function createResearchService(db: Database, deps: ResearchDeps) {
  /** Enqueue after the DB commit, so the worker never picks up a run that doesn't exist yet. */
  async function enqueue(run: ResearchRun) {
    try {
      await deps.queue.enqueueResearchRun(run.id);
    } catch (err) {
      await markRunFailed(db, run.id, "QUEUE_ERROR", "Could not start the research run");
      throw err;
    }
  }

  /**
   * The run's configuration snapshot. Which collections were searched is decided (and checked
   * against the user's access) when the run is created, so the worker never needs to know roles.
   */
  async function runConfig(actor: AuthContext, collectionIds?: string[], discover = true) {
    const ids = collectionIds
      ? await filterReadable(db, actor, collectionIds)
      : await readableCollectionIds(db, actor);
    return { collectionIds: ids, topK: 4, discovery: { enabled: discover } };
  }

  async function getRunDetail(actor: AuthContext, runId: string): Promise<RunDetail> {
    const row = await findRun(db, actor.organizationId, runId);
    if (!row) throw new NotFoundError("Run not found");
    const [report, citations, discovered, plan, steps, codeRuns, runApprovals, decisions] =
      await Promise.all([
        findLatestReport(db, actor.organizationId, runId),
        listCitations(db, actor.organizationId, runId),
        listRunSources(db, actor.organizationId, runId),
        listSubQuestions(db, actor.organizationId, runId),
        listSteps(db, actor.organizationId, runId),
        listToolCalls(db, actor.organizationId, runId),
        listRunApprovals(db, actor.organizationId, runId),
        listRunDecisions(db, actor.organizationId, runId),
      ]);
    const [scorecard, judgedClaims, myReportRating] = report
      ? await Promise.all([
          findScorecard(db, actor.organizationId, runId),
          listJudgedClaims(db, actor.organizationId, report.id, actor.userId),
          findReportRating(db, report.id, actor.userId),
        ])
      : [null, [], null];
    return {
      run: toRunDto(row.run),
      task: toTaskDto(row.task),
      report: toReportDto(report),
      citations,
      discovered,
      subQuestions: plan,
      steps,
      toolCalls: codeRuns,
      approvals: runApprovals,
      decisions,
      evaluation: { scorecard, claims: judgedClaims, myReportRating },
    };
  }

  return {
    getRunDetail,

    /** The run's trace (spans) and a time/cost summary; 404 for runs the actor can't see. */
    async getTrace(actor: AuthContext, runId: string) {
      const row = await findRun(db, actor.organizationId, runId);
      if (!row) throw new NotFoundError("Run not found");
      return getRunTrace(db, actor.organizationId, runId);
    },

    /** The run's scorecard (null until the evaluation stage has run). */
    async getScorecard(actor: AuthContext, runId: string) {
      const row = await findRun(db, actor.organizationId, runId);
      if (!row) throw new NotFoundError("Run not found");
      return { scorecard: await findScorecard(db, actor.organizationId, runId) };
    },

    /** Creates a task and its first run, then queues the run. */
    capabilities: () => deps.capabilities,

    async createTask(actor: AuthContext, input: CreateTaskInput) {
      const config = await runConfig(actor, input.collectionIds, input.discover);
      const { task, run } = await db.transaction(async (tx) => {
        const task = await insertTask(tx, {
          organizationId: actor.organizationId,
          createdBy: actor.userId,
          question: input.question,
          instructions: input.instructions,
        });
        const run = await insertRun(tx, {
          organizationId: actor.organizationId,
          taskId: task.id,
          startedBy: actor.userId,
          model: deps.model,
          promptVersion: PIPELINE_VERSION,
          config,
        });
        return { task, run };
      });
      await enqueue(run);
      return { task: toTaskDto(task), run: toRunDto(run) };
    },

    /** Re-runs an existing task (e.g. after changing the model or prompt). */
    async startRun(actor: AuthContext, taskId: string) {
      const task = await findTask(db, actor.organizationId, taskId);
      if (!task) throw new NotFoundError("Task not found");
      const runs = await listRunsForTasks(db, actor.organizationId, [taskId]);
      const run = await insertRun(db, {
        organizationId: actor.organizationId,
        taskId,
        startedBy: actor.userId,
        model: deps.model,
        promptVersion: PIPELINE_VERSION,
        config: await runConfig(actor, undefined, previousDiscovery(runs)),
      });
      await enqueue(run);
      return toRunDto(run);
    },

    /** Recent tasks, each with its latest run (for the history list). */
    async listTasks(actor: AuthContext) {
      const tasks = await listTasks(db, actor.organizationId);
      const runs = await listRunsForTasks(
        db,
        actor.organizationId,
        tasks.map((t) => t.id),
      );
      const latest = new Map<string, ResearchRun>();
      for (const run of runs) if (!latest.has(run.taskId)) latest.set(run.taskId, run);
      return tasks.map((task) => {
        const run = latest.get(task.id);
        return { ...toTaskDto(task), latestRun: run ? toRunDto(run) : null };
      });
    },

    async getTask(actor: AuthContext, taskId: string) {
      const task = await findTask(db, actor.organizationId, taskId);
      if (!task) throw new NotFoundError("Task not found");
      const runs = await listRunsForTasks(db, actor.organizationId, [taskId]);
      return { ...toTaskDto(task), runs: runs.map(toRunDto) };
    },

    /** You can cancel your own runs; owners and admins (run:manage) can cancel anyone's. */
    async cancel(actor: AuthContext, runId: string) {
      const row = await findRun(db, actor.organizationId, runId);
      if (!row) throw new NotFoundError("Run not found");
      if (row.run.startedBy !== actor.userId && !can(actor.role, "run:manage")) {
        throw new ForbiddenError("You can only cancel your own runs");
      }
      const cancelled = await cancelRun(db, actor.organizationId, runId);
      if (!cancelled) throw new ConflictError(`Run is already ${row.run.status}`);
      // Nobody needs to approve anything for a cancelled run.
      await db
        .update(approvals)
        .set({ status: "rejected", comment: "Run cancelled", decidedAt: new Date() })
        .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
      // The worker listens for this event and aborts the LLM call.
      await deps.events.publish({
        type: "status",
        runId,
        status: "cancelled",
        stage: cancelled.stage,
      });
      return toRunDto(cancelled);
    },
  };
}

export type ResearchService = ReturnType<typeof createResearchService>;
