CREATE TYPE "public"."claim_verdict" AS ENUM('supported', 'partial', 'unsupported');--> statement-breakpoint
CREATE TABLE "claim_judgments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"verdict" "claim_verdict" NOT NULL,
	"citation_accurate" boolean NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text,
	"judge_model" text NOT NULL,
	"judge_prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"claim_id" uuid,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_user_target_unique" UNIQUE NULLS NOT DISTINCT("user_id","report_id","claim_id")
);
--> statement-breakpoint
CREATE TABLE "run_scorecards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"claim_support_rate" real,
	"citation_accuracy" real,
	"citation_validity" real,
	"source_reliability" real,
	"coverage" real,
	"task_completion" real,
	"policy_compliant" boolean NOT NULL,
	"passed" boolean NOT NULL,
	"latency_ms" integer,
	"cost_usd" numeric(12, 6),
	"extra" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_scorecards_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "claim_judgments" ADD CONSTRAINT "claim_judgments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_judgments" ADD CONSTRAINT "claim_judgments_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_scorecards" ADD CONSTRAINT "run_scorecards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_scorecards" ADD CONSTRAINT "run_scorecards_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_scorecards" ADD CONSTRAINT "run_scorecards_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_judgments_claim_idx" ON "claim_judgments" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "feedback_report_idx" ON "feedback" USING btree ("report_id");