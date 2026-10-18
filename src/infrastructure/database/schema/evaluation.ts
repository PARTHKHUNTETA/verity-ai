import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import { claimVerdict, evalRunStatus } from "./enums.js";
import { organizations, users } from "./identity.js";
import { collections } from "./knowledge.js";
import { claims, reports, researchRuns } from "./research.js";

/**
 * Evaluation (docs/db-design.md §5.7): online evaluation of every run (Phase 10) and offline
 * evaluation on fixed datasets (Phase 11).
 */

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

/** The judge model's verdict on one claim and on each of its citations. */
export const claimJudgments = pgTable(
  "claim_judgments",
  {
    id: id(),
    organizationId: organizationId(),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    verdict: claimVerdict("verdict").notNull(),
    /** True when every cited passage supports the claim. */
    citationAccurate: boolean("citation_accurate").notNull(),
    /** Per citation: does that passage support the claim? */
    citations: jsonb("citations")
      .$type<Array<{ number: number; supports: boolean }>>()
      .notNull()
      .default([]),
    rationale: text("rationale"),
    judgeModel: text("judge_model").notNull(),
    judgePromptVersion: text("judge_prompt_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("claim_judgments_claim_idx").on(t.claimId)],
);

/** Metrics computed for one report of one run. Rates are 0–1; null means "not measurable". */
export type ScorecardExtra = {
  claims: { total: number; supported: number; partial: number; unsupported: number };
  citations: { total: number; supporting: number; invalidNumbers: number[]; unresolvable: number };
  /** Share of contradicting evidence the report cites; null when there was none. */
  contradictionHandling: number | null;
  taskCompletion: { missing: string[]; rationale: string | null } | null;
  policy: { violations: string[] };
  sources: Array<{ sourceId: string; title: string; score: number; reason: string }>;
  /** Metrics below their target (docs/system-design.md §6.1). */
  flags: string[];
  /** Set when the evaluation stage revised the report. */
  revision?: {
    fromReportId: string;
    before: { claimSupportRate: number | null; citationAccuracy: number | null };
    kept: "revised" | "original";
  };
  judgeError?: string;
};

/** One row per evaluated run: the trust scorecard shown next to the report. */
export const runScorecards = pgTable("run_scorecards", {
  id: id(),
  organizationId: organizationId(),
  runId: uuid("run_id")
    .notNull()
    .unique()
    .references(() => researchRuns.id, { onDelete: "cascade" }),
  /** The report version that was scored (the one shown to the user). */
  reportId: uuid("report_id")
    .notNull()
    .references(() => reports.id, { onDelete: "cascade" }),
  claimSupportRate: real("claim_support_rate"),
  citationAccuracy: real("citation_accuracy"),
  citationValidity: real("citation_validity"),
  sourceReliability: real("source_reliability"),
  coverage: real("coverage"),
  taskCompletion: real("task_completion"),
  policyCompliant: boolean("policy_compliant").notNull(),
  /** True when every metric meets its target. */
  passed: boolean("passed").notNull(),
  latencyMs: integer("latency_ms"),
  costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }),
  extra: jsonb("extra").$type<ScorecardExtra>().notNull(),
  createdAt: createdAt(),
});

/** A user's thumbs up/down on a report, or on one claim of it. One per user and target. */
export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    organizationId: organizationId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id").references(() => claims.id, { onDelete: "cascade" }),
    /** −1 or +1. */
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("feedback_user_target_unique").on(t.userId, t.reportId, t.claimId).nullsNotDistinct(),
    index("feedback_report_idx").on(t.reportId),
  ],
);

// --- Offline evaluation (Phase 11) -----------------------------------------------------

/** A fixed set of research questions with reference expectations: the agent's benchmark. */
export const evalDatasets = pgTable(
  "eval_datasets",
  {
    id: id(),
    organizationId: organizationId(),
    /** Short unique name, used by the CLI (`npm run eval -- --dataset ai-agents`). */
    name: text("name").notNull(),
    description: text("description"),
    /** The documents the cases are written against (searched by default in eval runs). */
    collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("eval_datasets_org_name_unique").on(t.organizationId, t.name)],
);

/** Case categories: ordinary questions, edge cases, questions with no answer, attacks. */
export const evalCaseCategories = ["normal", "edge", "no_answer", "red_team"] as const;
export type EvalCaseCategory = (typeof evalCaseCategories)[number];

export const evalCases = pgTable(
  "eval_cases",
  {
    id: id(),
    organizationId: organizationId(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    question: text("question").notNull(),
    instructions: text("instructions"),
    referenceAnswer: text("reference_answer"),
    /** Points the report must cover (checked by a judge). */
    requiredPoints: jsonb("required_points").$type<string[]>().notNull().default([]),
    /** URLs, DOIs, domains or titles the agent should find. */
    expectedSources: jsonb("expected_sources").$type<string[]>().notNull().default([]),
    /** Domains or URLs that must never be cited. */
    forbiddenSources: jsonb("forbidden_sources").$type<string[]>().notNull().default([]),
    /** Text that must never appear in the report (e.g. a prompt-injection payload). */
    forbiddenContent: jsonb("forbidden_content").$type<string[]>().notNull().default([]),
    category: text("category").$type<EvalCaseCategory>().notNull().default("normal"),
    tags: text("tags").array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("eval_cases_dataset_idx").on(t.datasetId, t.position)],
);

/** What an eval run executes with, frozen when it starts so results stay reproducible. */
export type EvalConfig = {
  model: string;
  pipelineVersion: string;
  promptVersions: Record<string, string>;
  policyVersion: number | null;
  topK: number;
  discovery: boolean;
  /** Whether the evaluation stage may revise a weak report (Phase 10's loop). */
  revise: boolean;
  collectionIds: string[];
  /** Only cases of these categories (null = all), e.g. just the red-team cases. */
  categories?: EvalCaseCategory[] | null;
  /** Only the first N cases (quick smoke runs). */
  limit: number | null;
};

/** Aggregate scorecard of an eval run. Means skip cases where a metric couldn't be measured. */
export type EvalSummary = {
  cases: number;
  completed: number;
  passed: number;
  passRate: number;
  means: Record<string, number | null>;
  latencyMs: { p50: number | null; p95: number | null };
  totalCostUsd: number | null;
  byCategory: Record<string, { cases: number; passed: number }>;
};

export const evalRuns = pgTable(
  "eval_runs",
  {
    id: id(),
    organizationId: organizationId(),
    datasetId: uuid("dataset_id")
      .notNull()
      .references(() => evalDatasets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    config: jsonb("config").$type<EvalConfig>().notNull(),
    status: evalRunStatus("status").notNull().default("queued"),
    summary: jsonb("summary").$type<EvalSummary>(),
    error: text("error"),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("eval_runs_dataset_idx").on(t.datasetId, t.createdAt.desc())],
);

/** Per-case scores, from the online scorecard plus the reference-based checks. */
export type EvalCaseScores = {
  completed: boolean;
  claimSupport: number | null;
  citationAccuracy: number | null;
  citationValidity: number | null;
  sourceReliability: number | null;
  coverage: number | null;
  taskCompletion: number | null;
  policyCompliant: boolean | null;
  sourceRecall: number | null;
  requiredPoints: number | null;
  forbiddenSourcesCited: string[];
  forbiddenContentFound: string[];
  latencyMs: number | null;
  costUsd: number | null;
};

export const evalResults = pgTable(
  "eval_results",
  {
    id: id(),
    organizationId: organizationId(),
    evalRunId: uuid("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => evalCases.id, { onDelete: "cascade" }),
    researchRunId: uuid("research_run_id").references(() => researchRuns.id, {
      onDelete: "set null",
    }),
    scores: jsonb("scores").$type<EvalCaseScores>().notNull(),
    passed: boolean("passed").notNull(),
    /** Why the case failed (empty when it passed). */
    failures: text("failures").array().notNull().default([]),
    /** Per-point verdicts of the required-points judge, and other details. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [unique("eval_results_run_case_unique").on(t.evalRunId, t.caseId)],
);

export type EvalDataset = typeof evalDatasets.$inferSelect;
export type EvalCase = typeof evalCases.$inferSelect;
export type EvalRun = typeof evalRuns.$inferSelect;
export type EvalResult = typeof evalResults.$inferSelect;
export type ClaimJudgment = typeof claimJudgments.$inferSelect;
export type RunScorecard = typeof runScorecards.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
