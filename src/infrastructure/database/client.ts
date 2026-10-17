import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import * as schema from "./schema/index.js";

/**
 * One connection pool for the whole process. The pool connects lazily,
 * so importing this file does not open a connection by itself.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

// Fired when an idle connection dies (e.g. the database restarts). The pool replaces it on next use.
pool.on("error", (err) => logger.error({ error: err.message }, "Idle Postgres client error"));

export const db = drizzle(pool, { schema, casing: "snake_case" });
export type Database = typeof db;

/** Cheap round trip used by the health check. Throws when the database is unreachable. */
export async function pingDatabase(): Promise<void> {
  await db.execute(sql`select 1`);
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
