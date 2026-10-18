import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase, db, pingDatabase, pool } from "./infrastructure/database/client.js";
import { createPgRunEventBus } from "./infrastructure/events/run-events.js";
import { chatModelFor, createLlmClient, embeddingModelFor } from "./infrastructure/llm/index.js";
import { createJobQueue } from "./infrastructure/queue/queue.js";
import { createLocalFileStorage } from "./infrastructure/storage/file-storage.js";
import { logger } from "./shared/logger.js";

const queue = await createJobQueue({ connectionString: env.DATABASE_URL, logger, role: "api" });
const events = createPgRunEventBus({ pool, connectionString: env.DATABASE_URL, logger });
await events.start();

const app = createApp({
  db,
  pingDatabase,
  research: { queue, events, model: chatModelFor(env) },
  knowledge: {
    storage: createLocalFileStorage(env.STORAGE_DIR),
    queue,
    // The API embeds search queries; documents are embedded by the worker.
    llm: createLlmClient(env),
    embeddingModel: embeddingModelFor(env),
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
  },
});

const server = app.listen(env.PORT, () => {
  logger.info(`VerityAI API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/** Stop accepting requests, let in-flight ones finish, then close connections. */
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  // Open SSE streams would keep server.close() waiting forever; end them.
  server.closeAllConnections();
  server.close(async () => {
    await queue.stop();
    await events.stop();
    await closeDatabase();
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("Forced shutdown after 10s");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});
