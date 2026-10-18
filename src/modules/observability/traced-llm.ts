import { calculateCostUsd, type LlmClient, type LlmUsage } from "../../infrastructure/llm/index.js";
import { withSpan, type Span } from "./tracer.js";

/**
 * Wraps an LLM client so every call becomes a "client" span with model, token counts, cost and
 * (for streaming) time to first token: the numbers you need to answer "why was this slow?" and
 * "what did it cost?". Outside a trace the wrapper adds nothing.
 */
export function traceLlm(llm: LlmClient): LlmClient {
  const recordUsage = (span: Span, model: string, usage: LlmUsage) =>
    span.setAttributes({
      model,
      tokensInput: usage.inputTokens,
      tokensOutput: usage.outputTokens,
      tokensCached: usage.cachedInputTokens,
      costUsd: calculateCostUsd(model, usage),
    });

  return {
    provider: llm.provider,

    streamText: (request) =>
      withSpan(
        "llm.streamText",
        { requestedModel: request.model },
        async (span) => {
          const started = Date.now();
          let firstTokenAt: number | null = null;
          const result = await llm.streamText({
            ...request,
            onDelta: (text) => {
              firstTokenAt ??= Date.now();
              request.onDelta(text);
            },
          });
          recordUsage(span, result.model, result.usage);
          span.setAttributes({
            timeToFirstTokenMs: firstTokenAt === null ? null : firstTokenAt - started,
            characters: result.text.length,
          });
          return result;
        },
        "client",
      ),

    generateObject: (request) =>
      withSpan(
        "llm.generateObject",
        { requestedModel: request.model, schema: request.schemaName },
        async (span) => {
          const result = await llm.generateObject(request);
          recordUsage(span, result.model, result.usage);
          return result;
        },
        "client",
      ),

    chatWithTools: (request) =>
      withSpan(
        "llm.chatWithTools",
        {
          requestedModel: request.model,
          turn: request.items.length,
          tools: request.tools.map((t) => t.name),
        },
        async (span) => {
          const result = await llm.chatWithTools(request);
          recordUsage(span, result.model, result.usage);
          span.setAttributes({ toolCalls: result.toolCalls.map((c) => c.name) });
          return result;
        },
        "client",
      ),

    embed: (texts, model) =>
      withSpan(
        "llm.embed",
        { model, inputs: texts.length },
        async (span) => {
          const result = await llm.embed(texts, model);
          recordUsage(span, model, result.usage);
          return result;
        },
        "client",
      ),
  };
}
