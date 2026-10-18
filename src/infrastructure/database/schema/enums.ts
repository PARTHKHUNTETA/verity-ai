import { pgEnum } from "drizzle-orm/pg-core";

/** Roles inside an organization (docs/system-design.md §4.7). Order = most to least powerful. */
export const memberRoles = ["owner", "admin", "researcher", "viewer"] as const;
export type MemberRole = (typeof memberRoles)[number];
export const memberRole = pgEnum("member_role", memberRoles);

/** Why a refresh token stopped working. Only replaying a "rotated" token signals theft. */
export const tokenRevokeReasons = [
  "rotated",
  "logout",
  "reuse_detected",
  "member_removed",
  "session_invalid",
] as const;
export type TokenRevokeReason = (typeof tokenRevokeReasons)[number];
export const tokenRevokeReason = pgEnum("token_revoke_reason", tokenRevokeReasons);

/** Lifecycle of one research run (docs/system-design.md §3). */
export const runStatuses = [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof runStatuses)[number];
export const runStatus = pgEnum("run_status", runStatuses);
export const terminalRunStatuses: readonly RunStatus[] = ["completed", "failed", "cancelled"];

/** Pipeline stages. Phase 4 uses only "synthesizing"; the rest arrive in Phase 7. */
export const runStages = [
  "planning",
  "discovering",
  "acquiring",
  "retrieving",
  "extracting",
  "analyzing",
  "synthesizing",
  "evaluating",
] as const;
export type RunStage = (typeof runStages)[number];
export const runStage = pgEnum("run_stage", runStages);

export const stepTypes = ["llm_call", "tool_call", "observation", "stage_change", "error"] as const;
export type StepType = (typeof stepTypes)[number];
export const stepType = pgEnum("step_type", stepTypes);

export const reportStatuses = ["draft", "final", "superseded"] as const;
export type ReportStatus = (typeof reportStatuses)[number];
export const reportStatus = pgEnum("report_status", reportStatuses);

export const collectionVisibilities = ["private", "organization"] as const;
export type CollectionVisibility = (typeof collectionVisibilities)[number];
export const collectionVisibility = pgEnum("collection_visibility", collectionVisibilities);

export const sourceTypes = ["upload", "web", "paper"] as const;
export type SourceType = (typeof sourceTypes)[number];
export const sourceType = pgEnum("source_type", sourceTypes);

export const sourceStatuses = ["pending", "processing", "ready", "failed"] as const;
export type SourceStatus = (typeof sourceStatuses)[number];
export const sourceStatus = pgEnum("source_status", sourceStatuses);

/** What happened to a candidate source during a run (docs/db-design.md: run_sources). */
export const runSourceStatuses = ["candidate", "acquired", "used", "rejected", "blocked"] as const;
export type RunSourceStatus = (typeof runSourceStatuses)[number];
export const runSourceStatus = pgEnum("run_source_status", runSourceStatuses);
