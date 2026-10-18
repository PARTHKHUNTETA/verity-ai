CREATE TYPE "public"."eval_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_origin" AS ENUM('user', 'eval');--> statement-breakpoint
CREATE TABLE "eval_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question" text NOT NULL,
	"instructions" text,
	"reference_answer" text,
	"required_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text DEFAULT 'normal' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"collection_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_datasets_org_name_unique" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"research_run_id" uuid,
	"scores" jsonb NOT NULL,
	"passed" boolean NOT NULL,
	"failures" text[] DEFAULT '{}' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_results_run_case_unique" UNIQUE("eval_run_id","case_id")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" "eval_run_status" DEFAULT 'queued' NOT NULL,
	"summary" jsonb,
	"error" text,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_tasks" ADD COLUMN "origin" "task_origin" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD CONSTRAINT "eval_cases_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_eval_run_id_eval_runs_id_fk" FOREIGN KEY ("eval_run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_case_id_eval_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."eval_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_research_run_id_research_runs_id_fk" FOREIGN KEY ("research_run_id") REFERENCES "public"."research_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_cases_dataset_idx" ON "eval_cases" USING btree ("dataset_id","position");--> statement-breakpoint
CREATE INDEX "eval_runs_dataset_idx" ON "eval_runs" USING btree ("dataset_id","created_at" DESC NULLS LAST);