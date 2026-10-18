import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { env } from "../config/env.js";
import * as schema from "../infrastructure/database/schema/index.js";
import { createJobQueue } from "../infrastructure/queue/queue.js";
import { maintainTracePartitions } from "../modules/observability/maintenance.js";
import { logger } from "../shared/logger.js";

/**
 * The release step of a deployment (`npm run db:setup`), run before the API and worker start:
 *
 *   1. applies database migrations;
 *   2. installs the job queue schema and queues (pg-boss);
 *   3. creates the trace partitions for this month and the next two;
 *   4. grants the app role (DATABASE_URL's user) access to anything that existed before the
 *      default privileges were set up.
 *
 * Runs as MIGRATION_DATABASE_URL (the schema owner) when set, otherwise DATABASE_URL.
 */
const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
const pool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool, { schema, casing: "snake_case" });

try {
  logger.info("Applying migrations…");
  await migrate(db, { migrationsFolder: "src/infrastructure/database/migrations" });

  logger.info("Installing the job queue…");
  const queue = await createJobQueue({ connectionString: url, logger, role: "api" });
  await queue.stop();

  const { created } = await maintainTracePartitions(db, logger);
  logger.info({ created }, "Trace partitions ready");

  const appUser = new URL(env.DATABASE_URL).username;
  const owner = new URL(url).username;
  if (env.MIGRATION_DATABASE_URL && appUser && appUser !== owner) {
    for (const schemaName of ["public", "pgboss"]) {
      await pool.query(`grant usage on schema ${schemaName} to "${appUser}"`);
      await pool.query(
        `grant select, insert, update, delete on all tables in schema ${schemaName} to "${appUser}"`,
      );
      await pool.query(
        `grant usage, select on all sequences in schema ${schemaName} to "${appUser}"`,
      );
      await pool.query(`grant execute on all functions in schema ${schemaName} to "${appUser}"`);
    }
    logger.info({ appUser }, "Granted row access to the app role");
  }
  logger.info("Database ready");
} catch (err) {
  logger.error({ err }, "Database setup failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
