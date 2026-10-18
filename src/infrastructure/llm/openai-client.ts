import OpenAI, { APIError, APIUserAbortError } from "openai";
import { LlmError, type LlmClient, type LlmResult, type LlmUsage } from "./types.js";

/** OpenAI implementation using the Responses API with streaming. */
export function createOpenAiClient(apiKey: string): LlmClient {
  const client = new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });

  return {
    provider: "openai",

    async streamText({ model, instructions, input, onDelta, signal }): Promise<LlmResult> {
      let text = "";
      try {
        const stream = await client.responses.create(
          // store: false — don't keep conversation state on OpenAI's side; we store what we need.
          { model, instructions, input, stream: true, store: false },
          { signal },
        );
        for await (const event of stream) {
          switch (event.type) {
            case "response.output_text.delta":
              text += event.delta;
              onDelta(event.delta);
              break;
            case "response.completed":
              return {
                text,
                model: event.response.model,
                usage: toUsage(event.response.usage),
              };
            case "response.incomplete":
              throw new LlmError(
                `Response incomplete: ${event.response.incomplete_details?.reason ?? "unknown reason"}`,
                "INCOMPLETE",
                false,
              );
            case "response.failed":
              throw new LlmError(
                event.response.error?.message ?? "The model failed to respond",
                event.response.error?.code ?? "FAILED",
                false,
              );
            case "error":
              throw new LlmError(event.message, event.code ?? "STREAM_ERROR", true);
          }
        }
        throw new LlmError("Stream ended without a completed response", "STREAM_ENDED", true);
      } catch (err) {
        throw toLlmError(err);
      }
    },

    async embed(texts, model) {
      try {
        const res = await client.embeddings.create({ model, input: texts });
        return {
          embeddings: res.data.map((d) => d.embedding),
          usage: { inputTokens: res.usage.prompt_tokens, outputTokens: 0, cachedInputTokens: 0 },
        };
      } catch (err) {
        throw toLlmError(err);
      }
    },
  };
}

function toUsage(usage: OpenAI.Responses.ResponseUsage | null | undefined): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

function toLlmError(err: unknown): unknown {
  if (err instanceof LlmError || err instanceof APIUserAbortError) return err;
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const retryable = status === 429 || status >= 500 || status === 0;
    return new LlmError(err.message, err.code ?? `HTTP_${status}`, retryable, { cause: err });
  }
  return err;
}
