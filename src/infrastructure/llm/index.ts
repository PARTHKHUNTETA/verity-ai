import type { Env } from "../../config/env.js";
import { createFakeLlmClient, type FakeOptions } from "./fake-client.js";
import { createOpenAiClient } from "./openai-client.js";
import type { LlmClient } from "./types.js";

export * from "./types.js";
export { calculateCostUsd } from "./pricing.js";
export { createFakeLlmClient, type FakeOptions, type FakeToolTurn } from "./fake-client.js";
export { toStrictJsonSchema } from "./json-schema.js";

/** The model name runs will record. Known without creating a client (the API needs it too). */
export function chatModelFor(env: Pick<Env, "LLM_PROVIDER" | "OPENAI_MODEL">): string {
  return env.LLM_PROVIDER === "fake" ? "fake-model" : env.OPENAI_MODEL;
}

/**
 * Embedding model recorded on every chunk. Fake and real vectors must never be mixed in one
 * index (they aren't comparable), so the fake provider records its own name.
 */
export function embeddingModelFor(
  env: Pick<Env, "LLM_PROVIDER" | "OPENAI_EMBEDDING_MODEL">,
): string {
  return env.LLM_PROVIDER === "fake" ? "fake-embedding" : env.OPENAI_EMBEDDING_MODEL;
}

export function createLlmClient(
  env: Pick<Env, "LLM_PROVIDER" | "OPENAI_API_KEY">,
  /** Behaviors for the fake provider (the worker passes the research pipeline's fakes). */
  fake?: FakeOptions,
): LlmClient {
  if (env.LLM_PROVIDER === "fake") return createFakeLlmClient(fake);
  if (!env.OPENAI_API_KEY) {
    throw new Error(
      'LLM_PROVIDER is "openai" but OPENAI_API_KEY is not set. Add it to .env, or set LLM_PROVIDER=fake.',
    );
  }
  return createOpenAiClient(env.OPENAI_API_KEY);
}
