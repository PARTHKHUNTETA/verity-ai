CREATE TYPE "public"."approval_kind" AS ENUM('tool_call', 'budget');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."policy_decision" AS ENUM('allow', 'deny', 'require_approval');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"tool_call_id" uuid,
	"policy_decision_id" uuid,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" uuid,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"rules" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_org_name_version_unique" UNIQUE("organization_id","name","version")
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_call_id" uuid,
	"policy_id" uuid,
	"policy_version" integer,
	"decision" "policy_decision" NOT NULL,
	"matched_rule" text NOT NULL,
	"reason" text NOT NULL,
	"checks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "stage" "run_stage";--> statement-breakpoint
-- Hand-edited: existing tool_calls rows (from Phase 7 runs) need a value before NOT NULL.
ALTER TABLE "tool_calls" ADD COLUMN "args_hash" text;--> statement-breakpoint
UPDATE "tool_calls" SET "args_hash" = md5("tool" || ':' || "args"::text) WHERE "args_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_calls" ALTER COLUMN "args_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_policy_decision_id_policy_decisions_id_fk" FOREIGN KEY ("policy_decision_id") REFERENCES "public"."policy_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_tool_call_id_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_org_status_idx" ON "approvals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "approvals_run_idx" ON "approvals" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_one_active_per_org" ON "policies" USING btree ("organization_id") WHERE "policies"."is_active";--> statement-breakpoint
CREATE INDEX "policy_decisions_run_idx" ON "policy_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "policy_decisions_org_decision_idx" ON "policy_decisions" USING btree ("organization_id","decision","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_run_hash_idx" ON "tool_calls" USING btree ("run_id","args_hash");