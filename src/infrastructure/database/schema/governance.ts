import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.js";
import { approvalKind, approvalStatus, policyDecision } from "./enums.js";
import { organizations, users } from "./identity.js";
import { researchRuns, toolCalls } from "./research.js";

/** Governance (docs/db-design.md §5.5): audit log (Phase 2), policies and approvals (Phase 8). */

/**
 * Append-only record of security-relevant actions. organization_id is nullable because some
 * events (e.g. a failed login for an unknown email) don't belong to any organization.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt.desc())],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * An organization's rules for what the agent may do (modules/policies/policy-rules.ts).
 * Every edit creates a new version; exactly one version is active. Decisions record which
 * version they were made under, so old decisions stay explainable after a policy change.
 */
export const policies = pgTable(
  "policies",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("default"),
    version: integer("version").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("policies_org_name_version_unique").on(t.organizationId, t.name, t.version),
    uniqueIndex("policies_one_active_per_org")
      .on(t.organizationId)
      .where(sql`${t.isActive}`),
  ],
);

/** One row per tool call the gateway evaluated: the verdict, the rule that decided it, and why. */
export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => policies.id, { onDelete: "set null" }),
    policyVersion: integer("policy_version"),
    decision: policyDecision("decision").notNull(),
    matchedRule: text("matched_rule").notNull(),
    reason: text("reason").notNull(),
    /** The outcome of each check, in order (tool, arguments, permission, rules, budget). */
    checks: jsonb("checks")
      .$type<Array<{ check: string; ok: boolean; detail?: string }>>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("policy_decisions_run_idx").on(t.runId),
    index("policy_decisions_org_decision_idx").on(t.organizationId, t.decision, t.createdAt),
  ],
);

/** A human decision the agent is waiting for: a sensitive tool call, or more budget. */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => researchRuns.id, { onDelete: "cascade" }),
    kind: approvalKind("kind").notNull(),
    toolCallId: uuid("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    policyDecisionId: uuid("policy_decision_id").references(() => policyDecisions.id, {
      onDelete: "set null",
    }),
    /** One sentence for the approver: what exactly is being asked. */
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    status: approvalStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("approvals_org_status_idx").on(t.organizationId, t.status),
    index("approvals_run_idx").on(t.runId),
  ],
);

export type Policy = typeof policies.$inferSelect;
export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
