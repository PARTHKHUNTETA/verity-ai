import "dotenv/config";
import { z } from "zod";

/**
 * Every environment variable the app reads is declared here.
 * The app validates them once at startup, so a missing or malformed
 * value crashes immediately with a clear message instead of failing later.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: "DATABASE_URL is required" })
      .refine((value) => /^postgres(ql)?:\/\//.test(value), {
        message: "DATABASE_URL must start with postgres:// or postgresql://",
      }),
  ),

  // --- Auth (Phase 2) ---
  JWT_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: "JWT_SECRET is required" })
      .min(32, "JWT_SECRET must be at least 32 characters"),
  ),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // --- Knowledge base (Phase 5) ---
  /** Where uploaded files are kept (local disk for now; object storage later). */
  STORAGE_DIR: z.string().min(1).default("storage"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(25),

  // --- Discovery: web & academic search, fetching (Phase 6) ---
  /** "none" disables web search (academic search still works without any key). */
  WEB_SEARCH_PROVIDER: z.enum(["none", "tavily"]).default("none"),
  TAVILY_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Comma-separated: arxiv, semantic_scholar (the latter works best with an API key). */
  ACADEMIC_SEARCH: z
    .string()
    .default("arxiv")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(["arxiv", "semantic_scholar"]))),
  SEMANTIC_SCHOLAR_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Domains the agent must never fetch (comma-separated; subdomains included). */
  BLOCKED_DOMAINS: z.string().default(""),
  /** If set, the agent may only fetch these domains (comma-separated). */
  ALLOWED_DOMAINS: z.string().default(""),
  FETCH_MAX_MB: z.coerce.number().positive().max(50).default(10),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  MAX_SOURCES_PER_RUN: z.coerce.number().int().min(1).max(20).default(5),

  // --- LLM (Phase 4) ---
  /** "fake" streams a canned answer: no API key or cost, used for tests and local development. */
  LLM_PROVIDER: z.enum(["openai", "fake"]).default("openai"),
  // Required when LLM_PROVIDER=openai (checked when the worker creates the client).
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
});

export type Env = z.infer<typeof envSchema>;

function emptyToUndefined(value: unknown) {
  return value === "" ? undefined : value;
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

export const env = parseEnv(process.env);
