/**
 * Rough token estimate: ~4 characters per token for English text with OpenAI tokenizers.
 * Good enough for sizing chunks (the embedding model accepts up to ~8k tokens per input);
 * exact counts come back from the API in `usage` where billing matters.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const CHARS_PER_TOKEN = 4;
