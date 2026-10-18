import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { spanStatus } from "./enums.js";

/**
 * Execution traces (docs/db-design.md §5.6), shaped like OpenTelemetry spans: a trace is a tree
 * of timed spans; for research runs the trace id is the run id.
 *
 * The table is PARTITIONED BY RANGE (start_time), one partition per month (see the hand-edited
 * migration 0008 and modules/observability/partitions.ts). Old months are dropped whole, which is
 * how 30-day retention stays cheap. Postgres requires the partition key in the primary key, hence
 * (span_id, start_time). No foreign keys: spans are append-only telemetry and outlive nothing.
 */
export const traceSpans = pgTable(
  "trace_spans",
  {
    spanId: uuid("span_id").notNull(),
    traceId: uuid("trace_id").notNull(),
    parentSpanId: uuid("parent_span_id"),
    organizationId: uuid("organization_id").notNull(),
    /** e.g. "run", "stage.retrieving", "llm.generateObject", "tool.fetch", "policy.check". */
    name: text("name").notNull(),
    /** "internal" (our code) or "client" (a call to an external service: LLM, search, HTTP). */
    kind: text("kind").notNull().default("internal"),
    status: spanStatus("status").notNull().default("ok"),
    attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
    errorMessage: text("error_message"),
    startTime: timestamp("start_time", { withTimezone: true, precision: 3 }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true, precision: 3 }),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    primaryKey({ columns: [t.spanId, t.startTime] }),
    index("trace_spans_trace_idx").on(t.traceId, t.startTime),
    index("trace_spans_org_name_idx").on(t.organizationId, t.name, t.startTime),
  ],
);

export type TraceSpan = typeof traceSpans.$inferSelect;
export type NewTraceSpan = typeof traceSpans.$inferInsert;
