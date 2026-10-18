import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import {
  coverageStatus,
  evidenceStance,
  reportStatus,
  runSourceStatus,
  runStage,
  runStatus,
  stepType,
  toolCallStatus,
} from "./enums.js";
import { organizations, users } from "./identity.js";
import { sourceChunks, sources } from "./knowledge.js";

/** Research domain (docs/db-design.md §5.3–5.4). */

const organizationId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

/** USD with 6 decimals. Null means "unknown" (e.g. a model missing from the price table). */
const costUsd = () => numeric("cost_usd", { precision: 12, scale: 6, mode: "number" });

/** The question as the user asked it. One task can have many runs. */
export const researchTasks = pgTable(
  "research_tasks",
  {
    id: id(),
    organizationId: organizationId(),
    question: text("question").notNull(),
    instructions: text("instructions"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("research_tasks_org_created_idx").on(t.organizationId, t.createdAt.desc())],
);

/** One execution of the agent on a task. The run id is also its trace id (Phase 9). */
export const researchRuns = pgTable(
  "research_runs",
  {
    id: id(),
    organizationId: organizationId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    status: runStatus("status").notNull().default("queued"),
    stage: runStage("stage"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    /** Saved after every stage so a crashed run can resume (modules/agent/state.ts). */
    state: jsonb("state").$type<Record<string, unknown>>(),
    stepCount: integer("step_count").notNull().default(0),
    tokensInput: integer("tokens_input").notNull().default(0),
    tokensOutput: integer("tokens_output").notNull().default(0),
    costUsd: costUsd().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("research_runs_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("research_runs_task_idx").on(t.taskId),
  ],
);

/** Every LLM call / tool call / observation of a run, in order. */
export const agentSteps = pgTable(
  "agent_steps",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    stage: runStage("stage"),
    type: stepType("type").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    model: text("model"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    costUsd: costUsd(),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [unique("agent_steps_run_seq_unique").on(t.runId, t.seq)],
);

/** The answer a run produces. Phase 4: plain Markdown. Claims and citations arrive in Phase 5/7. */
export const reports = pgTable(
  "reports",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    title: text("title"),
    contentMd: text("content_md").notNull().default(""),
    status: reportStatus("status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("reports_run_version_unique").on(t.runId, t.version)],
);

/** The plan: a research question broken into 2–5 sub-questions (Phase 7). */
export const subQuestions = pgTable(
  "sub_questions",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    rationale: text("rationale"),
    searchQueries: text("search_queries").array().notNull().default([]),
    coverage: coverageStatus("coverage").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [unique("sub_questions_run_position_unique").on(t.runId, t.position)],
);

/**
 * Every source a run discovered (web or academic search) and what happened to it:
 * candidate → acquired (fetched + indexed) → used (cited), or rejected / blocked with a reason.
 * `source_id` is set once the document has been acquired.
 */
export const runSources = pgTable(
  "run_sources",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    subQuestionId: uuid("sub_question_id").references(() => subQuestions.id, {
      onDelete: "set null",
    }),
    url: text("url").notNull(),
    /** Direct PDF link from the provider (arXiv, Semantic Scholar open access), if any. */
    pdfUrl: text("pdf_url"),
    title: text("title"),
    snippet: text("snippet"),
    /** Bibliographic details from the search result, kept until the document is acquired. */
    metadata: jsonb("metadata")
      .$type<{ authors?: string[]; publishedAt?: string; doi?: string }>()
      .notNull()
      .default({}),
    provider: text("provider").notNull(),
    discoveredVia: text("discovered_via").notNull(),
    query: text("query"),
    rank: integer("rank").notNull(),
    status: runSourceStatus("status").notNull().default("candidate"),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("run_sources_run_url_unique").on(t.runId, t.url)],
);

/**
 * An exact quote the agent extracted from a passage as evidence for a sub-question (Phase 7),
 * numbered by `rank`: the report cites it as [rank]. The quote is checked to really occur in
 * the passage before it is stored.
 */
export const evidence = pgTable(
  "evidence",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").references(() => sourceChunks.id, { onDelete: "set null" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    subQuestionId: uuid("sub_question_id").references(() => subQuestions.id, {
      onDelete: "set null",
    }),
    /** The [n] the report cites (1-based, unique per run). */
    rank: integer("rank").notNull(),
    quote: text("quote").notNull(),
    stance: evidenceStance("stance"),
    /** The model's confidence that the quote answers the sub-question, 0–1. */
    confidence: real("confidence"),
    /** A one-line explanation of what the quote shows. */
    note: text("note"),
    /** Retrieval score (reciprocal rank fusion) of the passage it came from. */
    score: real("score"),
    createdAt: createdAt(),
  },
  (t) => [unique("evidence_run_rank_unique").on(t.runId, t.rank)],
);

/** Tools the agent called (Phase 7: run_code), with arguments and results. */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(),
    organizationId: organizationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => agentSteps.id, { onDelete: "set null" }),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<Record<string, unknown>>().notNull(),
    status: toolCallStatus("status").notNull().default("proposed"),
    result: jsonb("result").$type<unknown>(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_calls_run_idx").on(t.runId, t.createdAt)],
);

/** A factual statement in a report. Phase 5: every sentence that carries a citation. */
export const claims = pgTable(
  "claims",
  {
    id: id(),
    organizationId: organizationId(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    section: text("section"),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("claims_report_position_unique").on(t.reportId, t.position)],
);

/** The citation link: claim ↔ evidence, with the number shown in the report. */
export const claimEvidence = pgTable(
  "claim_evidence",
  {
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    evidenceId: uuid("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
    citationNumber: integer("citation_number").notNull(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.evidenceId] })],
);

export type ResearchTask = typeof researchTasks.$inferSelect;
export type ResearchRun = typeof researchRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type NewAgentStep = typeof agentSteps.$inferInsert;
export type Report = typeof reports.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type RunSource = typeof runSources.$inferSelect;
export type SubQuestion = typeof subQuestions.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;
export type Claim = typeof claims.$inferSelect;
