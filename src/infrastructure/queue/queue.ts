import { PgBoss } from "pg-boss";
import type { Logger } from "pino";

/**
 * Background jobs with pg-boss: a job queue stored in Postgres (its own `pgboss` schema),
 * so we don't need Redis. The API enqueues; the worker process consumes.
 * Long LLM work never runs inside an HTTP request.
 */

export const RESEARCH_RUN_QUEUE = "research.run";
export type ResearchRunJob = { runId: string };

/** What the API needs from the queue (tests pass a fake). */
export interface ResearchJobQueue {
  enqueueResearchRun(runId: string): Promise<void>;
}

export type JobQueue = ResearchJobQueue & {
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
    // A failed run is marked failed and shown to the user; retrying silently would double-bill.
    retryLimit: 0,
    // If a worker dies mid-job, pg-boss gives up on the job after this long.
    expireInSeconds: 15 * 60,
  });

  return {
    boss,
    async enqueueResearchRun(runId) {
      await boss.send(RESEARCH_RUN_QUEUE, { runId } satisfies ResearchRunJob);
    },
    stop: () => boss.stop({ graceful: true, timeout: 30_000 }),
  };
}

async function ensureQueue(
  boss: PgBoss,
  name: string,
  options: { retryLimit: number; expireInSeconds: number },
) {
  const existing = await boss.getQueue(name);
  if (!existing) await boss.createQueue(name, options);
}
