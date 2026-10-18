/**
 * The app's own LLM interface. Everything outside this folder depends on these types,
 * not on the OpenAI SDK, so providers can be swapped (or faked in tests).
 */

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache (billed at a lower rate). */
  cachedInputTokens: number;
};

export type StreamTextRequest = {
  model: string;
  /** System-level instructions (the "system prompt"). */
  instructions: string;
  /** The user's message. */
  input: string;
  /** Called with each new piece of text as it is generated. */
  onDelta: (text: string) => void;
  /** Aborting stops generation (e.g. the user cancelled the run). */
  signal?: AbortSignal;
};

export type LlmResult = {
  text: string;
  /** The exact model version the provider used (may be more specific than requested). */
  model: string;
  usage: LlmUsage;
};

export interface LlmClient {
  readonly provider: "openai" | "fake";
  streamText(request: StreamTextRequest): Promise<LlmResult>;
  embed(texts: string[], model: string): Promise<{ embeddings: number[][]; usage: LlmUsage }>;
}

/** Thrown for provider failures; `retryable` marks transient ones (rate limits, timeouts, 5xx). */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}
