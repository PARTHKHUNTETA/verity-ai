CREATE TYPE "public"."coverage_status" AS ENUM('pending', 'answered', 'partial', 'unanswered');--> statement-breakpoint
CREATE TYPE "public"."evidence_stance" AS ENUM('supports', 'contradicts', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."tool_call_status" AS ENUM('proposed', 'denied', 'awaiting_approval', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "sub_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"rationale" text,
	"search_queries" text[] DEFAULT '{}' NOT NULL,
	"coverage" "coverage_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sub_questions_run_position_unique" UNIQUE("run_id","position")
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" "tool_call_status" DEFAULT 'proposed' NOT NULL,
	"result" jsonb,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "sub_question_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "stance" "evidence_stance";--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "state" jsonb;--> statement-breakpoint
ALTER TABLE "run_sources" ADD COLUMN "sub_question_id" uuid;--> statement-breakpoint
ALTER TABLE "run_sources" ADD COLUMN "pdf_url" text;--> statement-breakpoint
ALTER TABLE "run_sources" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sub_questions" ADD CONSTRAINT "sub_questions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sub_questions" ADD CONSTRAINT "sub_questions_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_step_id_agent_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."agent_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_sub_question_id_sub_questions_id_fk" FOREIGN KEY ("sub_question_id") REFERENCES "public"."sub_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_sub_question_id_sub_questions_id_fk" FOREIGN KEY ("sub_question_id") REFERENCES "public"."sub_questions"("id") ON DELETE set null ON UPDATE no action;