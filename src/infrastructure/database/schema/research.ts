import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import { reportStatus, runStage, runStatus, stepType } from "./enums.js";
import { organizations, users } from "./identity.js";

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

export type ResearchTask = typeof researchTasks.$inferSelect;
export type ResearchRun = typeof researchRuns.$inferSelect;
export type AgentStep = typeof agentSteps.$inferSelect;
export type NewAgentStep = typeof agentSteps.$inferInsert;
export type Report = typeof reports.$inferSelect;
