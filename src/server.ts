import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase, pingDatabase } from "./infrastructure/database/client.js";
import { logger } from "./shared/logger.js";

const app = createApp({ pingDatabase });

const server = app.listen(env.PORT, () => {
  logger.info(`VerityAI API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/** Stop accepting requests, let in-flight ones finish, then close the DB pool. */
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
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
