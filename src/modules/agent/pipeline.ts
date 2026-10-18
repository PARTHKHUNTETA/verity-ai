import type { RunStage } from "../../infrastructure/database/schema/index.js";

/**
 * The research pipeline (docs/system-design.md §3). Each stage has its own versioned prompt;
 * PIPELINE_VERSION is stored on every run so evaluations can compare pipeline versions.
 */
export const PIPELINE_VERSION = "pipeline-v1";

/** Stage order. Discovery stages are skipped when a run has discovery turned off. */
export const PIPELINE_STAGES: readonly RunStage[] = [
  "planning",
  "discovering",
  "acquiring",
  "retrieving",
  "extracting",
  "analyzing",
  "synthesizing",
];

export const DISCOVERY_STAGES: readonly RunStage[] = ["discovering", "acquiring"];
