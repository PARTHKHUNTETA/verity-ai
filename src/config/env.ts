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

  // Required from later phases; optional until then. Empty strings count as "not set".
  JWT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  OPENAI_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
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
