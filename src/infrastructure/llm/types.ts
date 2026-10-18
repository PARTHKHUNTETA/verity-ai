import type { ZodType } from "zod";

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

/** Structured output: the model must return JSON matching `schema` (validated with zod). */
export type GenerateObjectRequest<T> = {
  model: string;
  instructions: string;
  input: string;
  schema: ZodType<T>;
  /** Short identifier for the schema (also used by the fake provider to pick a behavior). */
  schemaName: string;
  signal?: AbortSignal;
};

export type ObjectResult<T> = { object: T; model: string; usage: LlmUsage };

/** A tool the model may call. `parameters` describes the arguments (a zod object). */
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: ZodType;
};

/**
 * The conversation of a tool loop, in provider-neutral form. "assistant" items carry the
 * provider's raw output so it can be sent back unchanged on the next turn.
 */
export type ToolLoopItem =
  | { type: "user"; content: string }
  | { type: "assistant"; raw: unknown }
  | { type: "tool_result"; callId: string; output: string };

export type ToolCall = { callId: string; name: string; arguments: unknown };

export type ToolTurnResult = {
  /** The model's text (its final answer when it made no tool calls). */
  text: string;
  toolCalls: ToolCall[];
  /** Append this to the conversation before adding tool results. */
  assistant: ToolLoopItem;
  model: string;
  usage: LlmUsage;
};

export type ToolTurnRequest = {
  model: string;
  instructions: string;
  items: ToolLoopItem[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
};

export interface LlmClient {
  readonly provider: "openai" | "fake";
  streamText(request: StreamTextRequest): Promise<LlmResult>;
  generateObject<T>(request: GenerateObjectRequest<T>): Promise<ObjectResult<T>>;
  /** One turn of a tool loop: the model either calls tools or answers. */
  chatWithTools(request: ToolTurnRequest): Promise<ToolTurnResult>;
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
