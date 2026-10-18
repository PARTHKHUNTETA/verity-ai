import { LlmError, type LlmClient } from "./types.js";

const FAKE_ANSWER = `## Summary

This answer comes from VerityAI's **fake** LLM provider (\`LLM_PROVIDER=fake\`). It lets you test the
whole pipeline — queue, worker, live streaming, cost tracking — without an API key.

## What a real answer will include

- A direct answer to your question
- Key points, with uncertainty stated honestly
- From Phase 5 on: citations to the exact passages that support each claim

## Next step

Set \`LLM_PROVIDER=openai\` and \`OPENAI_API_KEY\` in \`verity-ai-backend/.env\`, then restart the worker.`;

type FakeOptions = {
  /** Text to stream (defaults to a canned answer that echoes the question). */
  answer?: (input: string) => string;
  /** Delay between chunks in ms (0 in tests). */
  delayMs?: number;
  /** Throw this error after streaming `failAfterChunks` chunks. */
  failWith?: Error;
  failAfterChunks?: number;
};

/** Deterministic stand-in for a real model: streams text word by word. */
export function createFakeLlmClient(options: FakeOptions = {}): LlmClient {
  const { delayMs = 25, failWith, failAfterChunks = 0 } = options;
  const answerFor =
    options.answer ?? ((input: string) => `> ${input.replace(/\s+/g, " ")}\n\n${FAKE_ANSWER}`);

  return {
    provider: "fake",

    async streamText({ input, onDelta, signal }) {
      const text = answerFor(input);
      const chunks = text.match(/\S+\s*/g) ?? [];
      let streamed = "";
      for (const [i, chunk] of chunks.entries()) {
        if (failWith && i === failAfterChunks) throw failWith;
        if (signal?.aborted) throw new LlmError("Request was aborted", "ABORTED", false);
        if (delayMs > 0) await sleep(delayMs, signal);
        streamed += chunk;
        onDelta(chunk);
      }
      return {
        text: streamed,
        model: "fake-model",
        usage: {
          inputTokens: Math.ceil(input.length / 4),
          outputTokens: chunks.length,
          cachedInputTokens: 0,
        },
      };
    },

    async embed(texts) {
      // Not meaningful vectors, just the right shape (1536 dims) for wiring tests.
      return {
        embeddings: texts.map(() => Array.from({ length: 1536 }, () => 0)),
        usage: { inputTokens: texts.join(" ").length / 4, outputTokens: 0, cachedInputTokens: 0 },
      };
    },
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
