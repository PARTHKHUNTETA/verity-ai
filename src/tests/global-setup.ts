import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { testEnv } from "./test-env.js";

/**
 * Runs once before all test files: makes sure the test database exists and is migrated.
 * Tests never touch the development database. Requires `npm run db:up`.
 */
export default async function setup() {
  const url = new URL(testEnv.DATABASE_URL);
  const testDb = url.pathname.slice(1);

  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(`Cannot reach Postgres at ${url.host}. Start it with "npm run db:up".`, {
      cause: err,
    });
  }
  const exists = await admin.query("select 1 from pg_database where datname = $1", [testDb]);
  if (exists.rowCount === 0) await admin.query(`create database "${testDb}"`);
  await admin.end();

  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "src/infrastructure/database/migrations" });
  await client.end();
}
