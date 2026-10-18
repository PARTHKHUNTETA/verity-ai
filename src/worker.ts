import { env } from "./config/env.js";
import { closeDatabase, db, pool } from "./infrastructure/database/client.js";
import { createPgRunEventBus } from "./infrastructure/events/run-events.js";
import { createLlmClient, embeddingModelFor } from "./infrastructure/llm/index.js";
import {
  createJobQueue,
  RESEARCH_RUN_QUEUE,
  SOURCE_INGEST_QUEUE,
  type ResearchRunJob,
  type SourceIngestJob,
} from "./infrastructure/queue/queue.js";
import { createLocalFileStorage } from "./infrastructure/storage/file-storage.js";
import { createAgentRuntime } from "./modules/agent/agent-runtime.js";
import { createIngestionService } from "./modules/retrieval/ingestion.js";
import { createSearchService } from "./modules/retrieval/search.js";
import { logger } from "./shared/logger.js";

/**
 * The worker process: executes research runs and ingests uploaded documents.
 * Runs separately from the API (`npm run worker`) so slow LLM work never blocks HTTP requests,
 * and so API and workers can be scaled independently.
 */
const CONCURRENCY = 4;

const llm = createLlmClient(env);
const embeddingModel = embeddingModelFor(env);
const events = createPgRunEventBus({ pool, connectionString: env.DATABASE_URL, logger });
const search = createSearchService(db, llm, embeddingModel);
const runtime = createAgentRuntime({ db, llm, search, events, logger });
const ingestion = createIngestionService({
  db,
  llm,
  storage: createLocalFileStorage(env.STORAGE_DIR),
  embeddingModel,
  logger,
});

/** Runs being executed by this worker, so a cancel event can abort the right one. */
const active = new Map<string, AbortController>();

await events.start();
events.subscribe("*", (event) => {
  if (event.type === "status" && event.status === "cancelled") {
    active.get(event.runId)?.abort();
  }
});

const queue = await createJobQueue({ connectionString: env.DATABASE_URL, logger, role: "worker" });
await queue.boss.work<ResearchRunJob>(
  RESEARCH_RUN_QUEUE,
  { localConcurrency: CONCURRENCY },
  async ([job]) => {
    if (!job) return;
    const controller = new AbortController();
    active.set(job.data.runId, controller);
    try {
      await runtime.runResearch(job.data.runId, controller.signal);
    } finally {
      active.delete(job.data.runId);
    }
  },
);

await queue.boss.work<SourceIngestJob>(
  SOURCE_INGEST_QUEUE,
  { localConcurrency: 2 },
  async ([job]) => {
    if (job) await ingestion.ingestSource(job.data.sourceId);
  },
);

logger.info(
  `VerityAI worker started (LLM: ${llm.provider}, queues: ${RESEARCH_RUN_QUEUE} ×${CONCURRENCY}, ${SOURCE_INGEST_QUEUE} ×2)`,
);

async function shutdown(signal: string) {
  logger.info({ signal }, "Worker shutting down");
  // Let running jobs finish (up to the queue's timeout) before closing connections.
  await queue.stop();
  await events.stop();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
