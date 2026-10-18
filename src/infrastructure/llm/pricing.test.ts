import { describe, expect, it } from "vitest";
import { calculateCostUsd } from "./pricing.js";

describe("calculateCostUsd", () => {
  it("prices input, cached input and output tokens separately", () => {
    // gpt-5-mini: $0.25 in, $0.025 cached, $2.00 out per 1M tokens
    const cost = calculateCostUsd("gpt-5-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    });
    expect(cost).toBeCloseTo(0.8 * 0.25 + 0.2 * 0.025 + 0.1 * 2.0, 6);
  });

  it("matches dated model versions to their base model", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
    expect(calculateCostUsd("gpt-5-mini-2025-08-07", usage)).toBe(0.25);
  });

  it("returns null for unknown models instead of guessing", () => {
    expect(
      calculateCostUsd("some-new-model", {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
      }),
    ).toBeNull();
  });
});
