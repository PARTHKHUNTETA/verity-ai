import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations run as the schema owner when a separate migration URL is configured.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema/index.ts",
  out: "./src/infrastructure/database/migrations",
  dbCredentials: { url },
  casing: "snake_case",
  strict: true,
  verbose: true,
});
