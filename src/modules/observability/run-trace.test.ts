import { and, eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { traceSpans } from "../../infrastructure/database/schema/index.js";
import { app, bearer, registerUser, resetDatabase } from "../../tests/helpers.js";
import { buildRuntime, ownerWithNotes, queueRun } from "../../tests/research-setup.js";
import { saveNewVersion } from "../policies/policies.repository.js";
import { DEFAULT_POLICY_RULES } from "../policies/policy-rules.js";

beforeEach(resetDatabase);

describe("run traces", () => {
  it("records a span tree for a run and serves it with a time/cost summary", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    const spans = await db.select().from(traceSpans).where(eq(traceSpans.traceId, runId));
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const parentName = (name: string) => {
      const span = spans.find((s) => s.name === name)!;
      return span.parentSpanId ? byId.get(span.parentSpanId)!.name : null;
    };

    // Shape: run → stage.* → llm.* / tool.* → policy.check / rag.search → llm.embed
    expect(parentName("run")).toBeNull();
    expect(parentName("stage.planning")).toBe("run");
    expect(parentName("llm.generateObject")).toBe("stage.planning");
    expect(parentName("tool.rag")).toBe("stage.retrieving");
    expect(parentName("policy.check")).toMatch(/^tool\./);
    expect(parentName("rag.search")).toBe("tool.rag");
    expect(parentName("llm.embed")).toBe("rag.search");
    expect(parentName("llm.streamText")).toBe("stage.synthesizing");

    const root = spans.find((s) => s.name === "run")!;
    expect(root).toMatchObject({
      status: "ok",
      attributes: expect.objectContaining({ outcome: "completed" }),
    });
    const plan = spans.find((s) => s.name === "llm.generateObject")!;
    expect(plan.attributes).toMatchObject({
      model: "fake-model",
      schema: "research_plan",
      costUsd: 0,
    });
    expect(Number(plan.attributes.tokensInput)).toBeGreaterThan(0);
    const check = spans.find((s) => s.name === "policy.check")!;
    expect(check.attributes).toMatchObject({ decision: "allow", rule: "allowed" });

    const res = await request(app)
      .get(`/api/v1/research/runs/${runId}/trace`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.spans).toHaveLength(spans.length);
    const { summary } = res.body;
    expect(summary.stages.map((s: { stage: string }) => s.stage)).toEqual([
      "planning",
      "retrieving",
      "extracting",
      "analyzing",
      "synthesizing",
    ]);
    expect(summary.llm.calls).toBeGreaterThanOrEqual(5);
    expect(summary.llm.costUsd).toBe(0);
    expect(summary.tools.calls).toBeGreaterThanOrEqual(4); // 3 × rag + run_code
    expect(summary.slowest.length).toBeGreaterThan(0);
    expect(summary.totalMs).toBeGreaterThanOrEqual(summary.stages[0].ms);
  });

  it("traces a run paused for approval as an interruption, not an error", async () => {
    const owner = await ownerWithNotes();
    const rules = structuredClone(DEFAULT_POLICY_RULES);
    rules.tools.run_code.requireApproval = true;
    await saveNewVersion(db, owner.organizationId, rules, owner.userId);
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    const [root] = await db
      .select()
      .from(traceSpans)
      .where(and(eq(traceSpans.traceId, runId), eq(traceSpans.name, "run")));
    expect(root).toMatchObject({
      status: "ok",
      attributes: expect.objectContaining({ outcome: "awaiting_approval" }),
    });
    const [check] = await db
      .select()
      .from(traceSpans)
      .where(and(eq(traceSpans.traceId, runId), eq(traceSpans.name, "tool.run_code")));
    expect(check).toMatchObject({
      status: "ok",
      attributes: expect.objectContaining({ interrupted: "ApprovalRequiredError" }),
    });
  });

  it("hides other organizations' traces", async () => {
    const owner = await ownerWithNotes();
    const other = await registerUser("other@example.com");
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    const res = await request(app)
      .get(`/api/v1/research/runs/${runId}/trace`)
      .set("Authorization", bearer(other));
    expect(res.status).toBe(404);
  });
});

describe("metrics", () => {
  it("summarizes runs, LLM latency, tools and denials for the organization", async () => {
    const owner = await ownerWithNotes();
    await buildRuntime().runtime.runResearch(await queueRun(owner));

    const res = await request(app)
      .get("/api/v1/observability/metrics?days=7")
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(200);
    expect(res.body.runs).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(res.body.runs.p50Ms).toBeGreaterThanOrEqual(0);
    expect(res.body.llm.map((l: { name: string }) => l.name)).toEqual(
      expect.arrayContaining(["llm.generateObject", "llm.streamText"]),
    );
    expect(res.body.stages.map((s: { name: string }) => s.name)).toContain("synthesizing");
    expect(res.body.tools).toContainEqual(expect.objectContaining({ tool: "rag", failed: 0 }));
    expect(res.body.daily).toHaveLength(1);

    // Another organization sees none of it.
    const other = await registerUser("other@example.com");
    const theirs = await request(app)
      .get("/api/v1/observability/metrics")
      .set("Authorization", bearer(other));
    expect(theirs.body.runs.total).toBe(0);
  });
});
