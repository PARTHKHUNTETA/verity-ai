import type { EvalCaseScores, EvalSummary } from "../../../infrastructure/database/schema/index.js";

/**
 * Aggregating an eval run, and comparing two of them. Pure functions: easy to test and the
 * same for the API, the dashboard and the CLI.
 */

/** Metrics averaged into the eval scorecard, and whether higher is better. */
export const SUMMARY_METRICS = [
  { key: "claimSupport", label: "Claim support", higherIsBetter: true },
  { key: "citationAccuracy", label: "Citation accuracy", higherIsBetter: true },
  { key: "citationValidity", label: "Citation validity", higherIsBetter: true },
  { key: "sourceReliability", label: "Source reliability", higherIsBetter: true },
  { key: "coverage", label: "Coverage", higherIsBetter: true },
  { key: "taskCompletion", label: "Task completion", higherIsBetter: true },
  { key: "sourceRecall", label: "Source recall", higherIsBetter: true },
  { key: "requiredPoints", label: "Required points", higherIsBetter: true },
] as const satisfies ReadonlyArray<{
  key: keyof EvalCaseScores;
  label: string;
  higherIsBetter: boolean;
}>;

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Linear interpolation between closest ranks (same as PERCENTILE_CONT).
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function summarize(
  results: Array<{ scores: EvalCaseScores; passed: boolean; category: string }>,
): EvalSummary {
  const means: Record<string, number | null> = {};
  for (const { key } of SUMMARY_METRICS) {
    const values = results.map((r) => r.scores[key]).filter((v): v is number => v !== null);
    means[key] = values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  }
  const latencies = results.map((r) => r.scores.latencyMs).filter((v): v is number => v !== null);
  const costs = results.map((r) => r.scores.costUsd);
  const byCategory: EvalSummary["byCategory"] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { cases: 0, passed: 0 });
    c.cases++;
    if (r.passed) c.passed++;
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    cases: results.length,
    completed: results.filter((r) => r.scores.completed).length,
    passed,
    passRate: results.length ? round(passed / results.length) : 0,
    means,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    totalCostUsd: costs.some((c) => c === null)
      ? null
      : Math.round(costs.reduce<number>((a, b) => a + (b ?? 0), 0) * 1e6) / 1e6,
    byCategory,
  };
}

export type MetricComparison = {
  key: string;
  label: string;
  a: number | null;
  b: number | null;
  delta: number | null;
  /** Which run is better on this metric ("same" within half a percentage point). */
  better: "a" | "b" | "same" | null;
};

/**
 * Side-by-side comparison of two eval runs on the same dataset: every metric, plus the cases
 * whose verdict changed (fixed: failed in A, passed in B; regressed: the other way round).
 */
export function compareRuns(
  a: { summary: EvalSummary; results: Array<{ caseId: string; passed: boolean }> },
  b: { summary: EvalSummary; results: Array<{ caseId: string; passed: boolean }> },
) {
  const metric = (
    key: string,
    label: string,
    va: number | null,
    vb: number | null,
    higherIsBetter: boolean,
  ): MetricComparison => {
    if (va === null || vb === null) return { key, label, a: va, b: vb, delta: null, better: null };
    const delta = round(vb - va);
    const tolerance = Math.max(Math.abs(va), Math.abs(vb)) * 0.005 + 1e-9;
    const better = Math.abs(delta) <= tolerance ? "same" : delta > 0 === higherIsBetter ? "b" : "a";
    return { key, label, a: va, b: vb, delta, better };
  };
  const metrics = [
    metric("passRate", "Pass rate", a.summary.passRate, b.summary.passRate, true),
    ...SUMMARY_METRICS.map((m) =>
      metric(m.key, m.label, a.summary.means[m.key] ?? null, b.summary.means[m.key] ?? null, true),
    ),
    metric(
      "latencyP95",
      "Latency p95 (ms)",
      a.summary.latencyMs.p95,
      b.summary.latencyMs.p95,
      false,
    ),
    metric(
      "totalCostUsd",
      "Total cost (USD)",
      a.summary.totalCostUsd,
      b.summary.totalCostUsd,
      false,
    ),
  ];
  const aByCase = new Map(a.results.map((r) => [r.caseId, r.passed]));
  const cases = b.results.flatMap((r) => {
    const before = aByCase.get(r.caseId);
    if (before === undefined) return [];
    const change = before === r.passed ? "same" : r.passed ? "fixed" : "regressed";
    return [{ caseId: r.caseId, a: before, b: r.passed, change } as const];
  });
  return { metrics, cases };
}
