/**
 * Runtime controls (docs/system-design.md §3): every run stops when it hits a limit, so a
 * confused model can't loop forever or spend unlimited money. Phase 8 turns "stop" into
 * "ask an admin for approval".
 */
export type Budget = {
  maxSteps: number;
  maxTokens: number;
  maxCostUsd: number;
  timeoutMs: number;
};

export const DEFAULT_BUDGET: Budget = {
  maxSteps: 60,
  maxTokens: 400_000,
  maxCostUsd: 1,
  timeoutMs: 10 * 60 * 1000,
};

export class BudgetExceededError extends Error {
  constructor(
    public readonly limit: keyof Budget,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function checkBudget(
  budget: Budget,
  used: { steps: number; tokens: number; costUsd: number | null },
): void {
  if (used.steps > budget.maxSteps) {
    throw new BudgetExceededError("maxSteps", `Step limit reached (${budget.maxSteps} steps)`);
  }
  if (used.tokens > budget.maxTokens) {
    throw new BudgetExceededError(
      "maxTokens",
      `Token budget exceeded (${budget.maxTokens} tokens)`,
    );
  }
  if (used.costUsd !== null && used.costUsd > budget.maxCostUsd) {
    throw new BudgetExceededError("maxCostUsd", `Cost budget exceeded ($${budget.maxCostUsd})`);
  }
}
