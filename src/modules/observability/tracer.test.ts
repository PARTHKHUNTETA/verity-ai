import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { traceSpans } from "../../infrastructure/database/schema/index.js";
import { resetDatabase } from "../../tests/helpers.js";
import { silentLogger } from "../../tests/research-setup.js";
import { dropExpiredPartitions, ensureMonthlyPartitions } from "./partitions.js";
import { createTracer, withSpan } from "./tracer.js";

beforeEach(resetDatabase);

const org = uuidv7();
const spansOf = (traceId: string) =>
  db.select().from(traceSpans).where(eq(traceSpans.traceId, traceId));

describe("tracer", () => {
  it("links nested spans to their parents through async calls", async () => {
    const tracer = createTracer({ db, logger: silentLogger });
    const traceId = uuidv7();

    await tracer.inSpan("run", { traceId, organizationId: org }, async () => {
      await withSpan("stage.retrieving", { stage: "retrieving" }, async () => {
        // Parallel children of the same parent keep their own context.
        await Promise.all([
          withSpan("tool.rag", {}, async (span) => {
            await new Promise((r) => setTimeout(r, 5));
            span.setAttributes({ hits: 3 });
          }),
          withSpan("llm.embed", {}, async () => {}, "client"),
        ]);
      });
    });
    await tracer.flush();

    const spans = await spansOf(traceId);
    const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
    expect(byName.run!.parentSpanId).toBeNull();
    expect(byName["stage.retrieving"]!.parentSpanId).toBe(byName.run!.spanId);
    expect(byName["tool.rag"]!.parentSpanId).toBe(byName["stage.retrieving"]!.spanId);
    expect(byName["llm.embed"]!.parentSpanId).toBe(byName["stage.retrieving"]!.spanId);
    expect(byName["llm.embed"]!.kind).toBe("client");
    expect(byName["tool.rag"]!.attributes).toEqual({ hits: 3 });
    expect(byName["tool.rag"]!.durationMs).toBeGreaterThanOrEqual(4);
  });

  it("records errors, but treats intentional interruptions as ok", async () => {
    const tracer = createTracer({ db, logger: silentLogger });
    const traceId = uuidv7();
    const paused = Object.assign(new Error("waiting for approval"), {
      name: "ApprovalRequiredError",
      traceAsOk: true,
    });

    await tracer
      .inSpan("run", { traceId, organizationId: org }, async () => {
        await withSpan("tool.fetch", {}, async () => {
          throw new Error("HTTP 500");
        }).catch(() => {});
        await withSpan("tool.run_code", {}, async () => {
          throw paused;
        });
      })
      .catch(() => {});
    await tracer.flush();

    const byName = Object.fromEntries((await spansOf(traceId)).map((s) => [s.name, s]));
    expect(byName["tool.fetch"]).toMatchObject({ status: "error", errorMessage: "HTTP 500" });
    expect(byName["tool.run_code"]).toMatchObject({
      status: "ok",
      attributes: { interrupted: "ApprovalRequiredError" },
    });
  });

  it("does nothing outside a trace", async () => {
    const result = await withSpan("orphan", {}, async (span) => {
      span.setAttributes({ x: 1 });
      return 42;
    });
    expect(result).toBe(42);
    expect(await db.select().from(traceSpans)).toHaveLength(0);
  });
});

describe("trace partitions", () => {
  it("stores spans in monthly partitions and drops expired months", async () => {
    await ensureMonthlyPartitions(db);
    const tracer = createTracer({ db, logger: silentLogger });
    const traceId = uuidv7();
    await tracer.inSpan("run", { traceId, organizationId: org }, async () => {});
    await tracer.flush();

    const now = new Date();
    const expected = `trace_spans_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const where = await db.execute<{ partition: string }>(
      sql`SELECT tableoid::regclass::text AS partition FROM trace_spans WHERE trace_id = ${traceId}`,
    );
    expect(where.rows[0]!.partition).toBe(expected);

    // An old month's partition is dropped; the current one is kept.
    await ensureMonthlyPartitions(db, { now: new Date("2020-01-15T00:00:00Z"), monthsAhead: 0 });
    const dropped = await dropExpiredPartitions(db, { retentionDays: 30 });
    expect(dropped).toContain("trace_spans_2020_01");
    expect(dropped).not.toContain(expected);
  });
});
