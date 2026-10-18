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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import { claimVerdict } from "./enums.js";
import { organizations, users } from "./identity.js";
import { claims, reports, researchRuns } from "./research.js";

/** Evaluation (docs/db-design.md §5.7): online evaluation of every run (Phase 10). */

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

export type ClaimJudgment = typeof claimJudgments.$inferSelect;
export type RunScorecard = typeof runScorecards.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
