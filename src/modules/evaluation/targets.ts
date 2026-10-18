/**
 * Scorecard targets (docs/system-design.md §6.1). A metric below its target is flagged on the
 * scorecard; a claim-support rate below its target triggers one revision of the report.
 * Starting points: tune them once there is real data.
 */
export const TARGETS = {
  claimSupportRate: 0.9,
  citationAccuracy: 0.9,
  citationValidity: 1,
  sourceReliability: 0.7,
  coverage: 0.8,
  taskCompletion: 0.8,
} as const;

export type TargetMetric = keyof typeof TARGETS;

/** The threshold that triggers the revision loop. */
export const REVISION_THRESHOLD = TARGETS.claimSupportRate;

/** What an offline eval case needs to pass (Phase 11). */
export const CASE_PASS = {
  claimSupport: 0.9,
  requiredPoints: 0.8,
  sourceRecall: 0.5,
} as const;
