import type { LlmUsage } from "./types.js";

/**
 * USD per 1M tokens.
 *
 * ⚠️ Prices change. These were taken from third-party rate cards (2026) that partly disagree;
 * verify against https://openai.com/api/pricing before relying on cost numbers.
 * A model missing from this table gets cost = null ("unknown") rather than a wrong number.
 */
type Price = { input: number; cachedInput?: number; output: number };

const PRICES: Record<string, Price> = {
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  "fake-model": { input: 0, output: 0 },
  "fake-embedding": { input: 0, output: 0 },
};

/**
 * Finds the price for a model. Providers often return dated versions
 * (e.g. "gpt-5-mini-2025-08-07"), so the longest matching prefix wins.
 */
function findPrice(model: string): Price | undefined {
  const match = Object.keys(PRICES)
    .filter((name) => model === name || model.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match] : undefined;
}

export function calculateCostUsd(model: string, usage: LlmUsage): number | null {
  const price = findPrice(model);
  if (!price) return null;
  const uncached = usage.inputTokens - usage.cachedInputTokens;
  const cachedRate = price.cachedInput ?? price.input;
  const cost =
    (uncached * price.input +
      usage.cachedInputTokens * cachedRate +
      usage.outputTokens * price.output) /
    1_000_000;
  return Math.round(cost * 1e6) / 1e6; // matches the DB column's 6 decimal places
}
