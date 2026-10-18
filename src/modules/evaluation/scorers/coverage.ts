import type { CoverageStatus } from "../../../infrastructure/database/schema/index.js";

/**
 * Coverage: how many planned sub-questions the report answers with cited evidence.
 * Answered counts 1, partial (evidence found but not cited) counts 0.5, unanswered 0.
 */
export function coverage(statuses: CoverageStatus[]) {
  if (!statuses.length) return null;
  const score = statuses.reduce(
    (sum, s) => sum + (s === "answered" ? 1 : s === "partial" ? 0.5 : 0),
    0,
  );
  return score / statuses.length;
}
