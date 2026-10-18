/** The scorers behind a run scorecard (docs/system-design.md §6.1). All are pure functions. */
export { claimSupport } from "./claim-support.js";
export { citationAccuracy } from "./citation-accuracy.js";
export { citationValidity } from "./citation-validity.js";
export { contradictionHandling } from "./contradiction-handling.js";
export { coverage } from "./coverage.js";
export { policyCompliance } from "./policy-compliance.js";
export { meanReliability, sourceReliability, type SourceInfo } from "./source-reliability.js";
export {
  taskCompletionSchema,
  taskCompletionScore,
  type TaskCompletionJudgment,
} from "./task-completion.js";
