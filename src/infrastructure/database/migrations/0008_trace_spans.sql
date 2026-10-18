-- Hand-edited migration (see the partitioning note below).
CREATE TYPE "public"."span_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TABLE "trace_spans" (
	"span_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'internal' NOT NULL,
	"status" "span_status" DEFAULT 'ok' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"start_time" timestamp (3) with time zone NOT NULL,
	"end_time" timestamp (3) with time zone,
	"duration_ms" integer,
	CONSTRAINT "trace_spans_span_id_start_time_pk" PRIMARY KEY("span_id","start_time")
) PARTITION BY RANGE ("start_time");
--> statement-breakpoint
-- Hand-edited: trace_spans is partitioned by month. Monthly partitions are created ahead of time
-- by modules/observability/partitions.ts (at startup and daily); old ones are dropped there too.
-- The DEFAULT partition catches rows whose month has no partition yet, so inserts never fail.
CREATE TABLE "trace_spans_default" PARTITION OF "trace_spans" DEFAULT;
--> statement-breakpoint
CREATE INDEX "trace_spans_trace_idx" ON "trace_spans" USING btree ("trace_id","start_time");--> statement-breakpoint
CREATE INDEX "trace_spans_org_name_idx" ON "trace_spans" USING btree ("organization_id","name","start_time");