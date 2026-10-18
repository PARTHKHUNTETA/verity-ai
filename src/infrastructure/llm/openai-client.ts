import OpenAI, { APIError, APIUserAbortError } from "openai";
import { toStrictJsonSchema } from "./json-schema.js";
import {
  LlmError,
  type LlmClient,
  type LlmResult,
  type LlmUsage,
  type ToolCall,
  type ToolLoopItem,
} from "./types.js";

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

    async generateObject({ model, instructions, input, schema, schemaName, signal }) {
      try {
        const res = await client.responses.create(
          {
            model,
            instructions,
            input,
            store: false,
            text: {
              format: {
                type: "json_schema",
                name: schemaName,
                schema: toStrictJsonSchema(schema),
                strict: true,
              },
            },
          },
          { signal },
        );
        if (res.status === "incomplete") {
          throw new LlmError(
            `Response incomplete: ${res.incomplete_details?.reason ?? "unknown reason"}`,
            "INCOMPLETE",
            false,
          );
        }
        const refusal = res.output
          .flatMap((item) => (item.type === "message" ? item.content : []))
          .find((c) => c.type === "refusal");
        if (refusal && refusal.type === "refusal") {
          throw new LlmError(`The model refused: ${refusal.refusal}`, "REFUSED", false);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.output_text);
        } catch {
          throw new LlmError("The model returned invalid JSON", "INVALID_JSON", true);
        }
        const result = schema.safeParse(parsed);
        if (!result.success) {
          throw new LlmError(
            `The model's output didn't match the schema: ${result.error.issues[0]?.message ?? ""}`,
            "SCHEMA_MISMATCH",
            true,
          );
        }
        return { object: result.data, model: res.model, usage: toUsage(res.usage) };
      } catch (err) {
        throw toLlmError(err);
      }
    },

    async chatWithTools({ model, instructions, items, tools, signal }) {
      try {
        const res = await client.responses.create(
          {
            model,
            instructions,
            input: items.flatMap(toInputItems) as OpenAI.Responses.ResponseInput,
            tools: tools.map((t) => ({
              type: "function" as const,
              name: t.name,
              description: t.description,
              parameters: toStrictJsonSchema(t.parameters),
              strict: true,
            })),
            store: false,
            // Without server-side storage, reasoning models need their (encrypted) reasoning
            // sent back on the next turn to keep thinking where they left off.
            include: ["reasoning.encrypted_content"],
          },
          { signal },
        );
        const toolCalls: ToolCall[] = [];
        for (const item of res.output) {
          if (item.type !== "function_call") continue;
          let args: unknown;
          try {
            args = JSON.parse(item.arguments);
          } catch {
            args = null;
          }
          toolCalls.push({ callId: item.call_id, name: item.name, arguments: args });
        }
        return {
          text: res.output_text,
          toolCalls,
          assistant: { type: "assistant", raw: res.output },
          model: res.model,
          usage: toUsage(res.usage),
        };
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

/** Provider-neutral conversation items → Responses API input items. */
function toInputItems(item: ToolLoopItem): unknown[] {
  switch (item.type) {
    case "user":
      return [{ role: "user", content: item.content }];
    case "assistant":
      return item.raw as unknown[];
    case "tool_result":
      return [{ type: "function_call_output", call_id: item.callId, output: item.output }];
  }
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
