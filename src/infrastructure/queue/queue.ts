import { PgBoss } from "pg-boss";
import type { Logger } from "pino";

/**
 * Background jobs with pg-boss: a job queue stored in Postgres (its own `pgboss` schema),
 * so we don't need Redis. The API enqueues; the worker process consumes.
 * Long LLM work never runs inside an HTTP request.
 */

export const RESEARCH_RUN_QUEUE = "research.run";
export type ResearchRunJob = { runId: string };

export const SOURCE_INGEST_QUEUE = "source.ingest";
export type SourceIngestJob = { sourceId: string };

export const EVAL_RUN_QUEUE = "eval.run";
export type EvalRunJob = { evalRunId: string };

/** What the API needs from the queue (tests pass a fake). */
export interface ResearchJobQueue {
  enqueueResearchRun(runId: string): Promise<void>;
}

export interface IngestJobQueue {
  enqueueSourceIngest(sourceId: string): Promise<void>;
}

export interface EvalJobQueue {
  enqueueEvalRun(evalRunId: string): Promise<void>;
}

export type JobQueue = ResearchJobQueue &
  IngestJobQueue &
  EvalJobQueue & {
    boss: PgBoss;
    stop(): Promise<void>;
  };

export async function createJobQueue(options: {
  connectionString: string;
  logger: Logger;
  /** The worker runs maintenance (expiring stuck jobs, archiving); the API only sends. */
  role: "api" | "worker";
}): Promise<JobQueue> {
  const { connectionString, logger, role } = options;
  const boss = new PgBoss({ connectionString, supervise: role === "worker", schedule: false });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();

  await ensureQueue(boss, RESEARCH_RUN_QUEUE, {
    // Workers send a heartbeat; if one dies, the job fails after 60 s and is retried once.
    // The retry resumes the run from its saved state (it doesn't start over or double-bill).
    retryLimit: 1,
    heartbeatSeconds: 60,
    expireInSeconds: 15 * 60,
  });
  await ensureQueue(boss, SOURCE_INGEST_QUEUE, {
    // Ingestion is idempotent (it replaces a source's chunks), so retrying transient
    // failures like an embedding API timeout is safe.
    retryLimit: 2,
    expireInSeconds: 15 * 60,
  });

  await ensureQueue(boss, EVAL_RUN_QUEUE, {
    // An eval run executes many research runs in a row, so it may take a long time. The runner
    // skips cases that already have results, so a retry after a crash continues where it was.
    retryLimit: 1,
    heartbeatSeconds: 60,
    expireInSeconds: 6 * 60 * 60,
  });

  return {
    boss,
    async enqueueEvalRun(evalRunId) {
      await boss.send(EVAL_RUN_QUEUE, { evalRunId } satisfies EvalRunJob);
    },
    async enqueueResearchRun(runId) {
      await boss.send(RESEARCH_RUN_QUEUE, { runId } satisfies ResearchRunJob);
    },
    async enqueueSourceIngest(sourceId) {
      await boss.send(SOURCE_INGEST_QUEUE, { sourceId } satisfies SourceIngestJob, {
        retryDelay: 10,
        retryBackoff: true,
      });
    },
    stop: () => boss.stop({ graceful: true, timeout: 30_000 }),
  };
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: { retryLimit: number; expireInSeconds: number; heartbeatSeconds?: number },
) {
  const existing = await boss.getQueue(name);
  if (!existing) await boss.createQueue(name, options);
}
