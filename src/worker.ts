import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "./config/env.js";
import * as schema from "./infrastructure/database/schema/index.js";
import { closeDatabase, db, pool } from "./infrastructure/database/client.js";
import { createPgRunEventBus } from "./infrastructure/events/run-events.js";
import { createLlmClient, embeddingModelFor } from "./infrastructure/llm/index.js";
import {
  createJobQueue,
  EVAL_RUN_QUEUE,
  RESEARCH_RUN_QUEUE,
  type EvalRunJob,
  SOURCE_INGEST_QUEUE,
  type ResearchRunJob,
  type SourceIngestJob,
} from "./infrastructure/queue/queue.js";
import { createLocalFileStorage } from "./infrastructure/storage/file-storage.js";
import { createSafeFetcher } from "./infrastructure/http/safe-fetch.js";
import { createAgentRuntime } from "./modules/agent/agent-runtime.js";
import { researchFakes } from "./modules/agent/fakes.js";
import { failStalledRuns } from "./modules/agent/maintenance.js";
import { createEvalRunner } from "./modules/evaluation/offline/runner.js";
import { maintainTracePartitions } from "./modules/observability/maintenance.js";
import { createTracer } from "./modules/observability/tracer.js";
import { createApprovalsService } from "./modules/policies/approvals.service.js";
import { createAcquisitionService } from "./modules/retrieval/acquisition.js";
import { parseDomainList } from "./modules/retrieval/urls.js";
import { discoveryProvidersFrom } from "./modules/tools/discovery.js";
import { createIngestionService } from "./modules/retrieval/ingestion.js";
import { createSearchService } from "./modules/retrieval/search.js";
import { logger } from "./shared/logger.js";

/**
 * The worker process: executes research runs and ingests uploaded documents.
 * Runs separately from the API (`npm run worker`) so slow LLM work never blocks HTTP requests,
 * and so API and workers can be scaled independently.
 */
const CONCURRENCY = 4;

// With LLM_PROVIDER=fake, every pipeline step uses deterministic stand-ins (modules/agent/fakes.ts).
const llm = createLlmClient(env, researchFakes);
const embeddingModel = embeddingModelFor(env);
const events = createPgRunEventBus({ pool, connectionString: env.DATABASE_URL, logger });
const storage = createLocalFileStorage(env.STORAGE_DIR);
const search = createSearchService(db, llm, embeddingModel);
const ingestion = createIngestionService({ db, llm, storage, embeddingModel, logger });
const providers = discoveryProvidersFrom(env);
const acquisition = createAcquisitionService({
  db,
  fetcher: createSafeFetcher({
    maxBytes: env.FETCH_MAX_MB * 1024 * 1024,
    timeoutMs: env.FETCH_TIMEOUT_MS,
  }),
  storage,
  ingestion,
  logger,
});
const tracer = createTracer({ db, logger });
// Creating partitions is a schema change: done as the schema owner when one is configured.
const ownerPool = env.MIGRATION_DATABASE_URL
  ? new Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 1 })
  : null;
const maintenanceDb = ownerPool ? drizzle(ownerPool, { schema, casing: "snake_case" }) : db;
await maintainTracePartitions(maintenanceDb, logger);
const runtime = createAgentRuntime({
  tracer,
  db,
  llm,
  search,
  events,
  logger,
  discovery: { providers, acquisition, maxSources: env.MAX_SOURCES_PER_RUN },
  // Platform-wide domain rules (env); each org's own rules come from its policy.
  platformDomains: {
    blocked: parseDomainList(env.BLOCKED_DOMAINS),
    allowed: parseDomainList(env.ALLOWED_DOMAINS),
  },
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
      // retryCount > 0: the previous worker died mid-run; continue from the saved state.
      await runtime.runResearch(job.data.runId, {
        signal: controller.signal,
        resume: job.retryCount > 0,
      });
    } finally {
      active.delete(job.data.runId);
    }
  },
);

// Offline eval runs execute their cases here, one at a time, through the same runtime.
const evalRunner = createEvalRunner({
  db,
  runtime,
  llm,
  logger,
  track(runId) {
    const controller = new AbortController();
    active.set(runId, controller);
    return { signal: controller.signal, done: () => active.delete(runId) };
  },
});
await queue.boss.work<EvalRunJob>(EVAL_RUN_QUEUE, { localConcurrency: 1 }, async ([job]) => {
  if (job) await evalRunner.execute(job.data.evalRunId);
});

await queue.boss.work<SourceIngestJob>(
  SOURCE_INGEST_QUEUE,
  { localConcurrency: 2 },
  async ([job]) => {
    if (job) await ingestion.ingestSource(job.data.sourceId);
  },
);

// Safety net: runs whose job was given up on (worker died twice) are marked failed.
// Expired approval requests count as rejected (budget requests fail the run).
const approvalsService = createApprovalsService(db, { queue, events });
const sweep = setInterval(
  () => {
    approvalsService
      .expireStale()
      .then((n) => n && logger.info({ expired: n }, "Expired stale approval requests"))
      .catch((err) => logger.error({ err }, "Approval expiry sweep failed"));
    failStalledRuns(db)
      .then((ids) => ids.length && logger.warn({ runIds: ids }, "Marked stalled runs as failed"))
      .catch((err) => logger.error({ err }, "Stalled-run sweep failed"));
  },
  5 * 60 * 1000,
);
sweep.unref();
// Trace partitions: create upcoming months, drop expired ones.
setInterval(() => void maintainTracePartitions(maintenanceDb, logger), 6 * 60 * 60 * 1000).unref();

logger.info(
  `VerityAI worker started (LLM: ${llm.provider}, web search: ${providers.web?.name ?? "off"}, academic: ${providers.academic.map((p) => p.name).join(", ") || "off"}, queues: ${RESEARCH_RUN_QUEUE} ×${CONCURRENCY}, ${SOURCE_INGEST_QUEUE} ×2, ${EVAL_RUN_QUEUE} ×1)`,
);

async function shutdown(signal: string) {
  logger.info({ signal }, "Worker shutting down");
  // Let running jobs finish (up to the queue's timeout) before closing connections.
  await queue.stop();
  await tracer.shutdown(); // write any buffered spans
  await events.stop();
  await ownerPool?.end();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
