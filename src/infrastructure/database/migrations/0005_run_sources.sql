CREATE TYPE "public"."run_source_status" AS ENUM('candidate', 'acquired', 'used', 'rejected', 'blocked');--> statement-breakpoint
CREATE TABLE "run_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid,
	"url" text NOT NULL,
	"title" text,
	"snippet" text,
	"provider" text NOT NULL,
	"discovered_via" text NOT NULL,
	"query" text,
	"rank" integer NOT NULL,
	"status" "run_source_status" DEFAULT 'candidate' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_sources_run_url_unique" UNIQUE("run_id","url")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_run_id_research_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_org_canonical_url_unique" ON "sources" USING btree ("organization_id","canonical_url") WHERE "sources"."canonical_url" is not null;