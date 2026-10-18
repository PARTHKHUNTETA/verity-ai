import { eq } from "drizzle-orm";
import { pino } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { agentSteps, reports, researchRuns } from "../../infrastructure/database/schema/index.js";
import { createInMemoryRunEventBus } from "../../infrastructure/events/run-events.js";
import { createFakeLlmClient, LlmError } from "../../infrastructure/llm/index.js";
import { app, bearer, registerUser, resetDatabase } from "../../tests/helpers.js";
import { createAgentRuntime } from "./agent-runtime.js";

beforeEach(resetDatabase);

const logger = pino({ level: "silent" });

/** Creates a queued run through the real API (the fake queue just records it). */
async function queuedRun(question = "What are the main approaches to building AI agents?") {
  const owner = await registerUser("owner@example.com");
  const res = await request(app)
    .post("/api/v1/research/tasks")
    .set("Authorization", bearer(owner))
    .send({ question });
  expect(res.status).toBe(201);
  return res.body.run.id as string;
}

function runtimeWith(
  llm = createFakeLlmClient({ delayMs: 0, answer: () => "Hello research world." }),
) {
  const events = createInMemoryRunEventBus();
  const runtime = createAgentRuntime({ db, llm, events, logger, publishIntervalMs: 5 });
  return { runtime, events };
}

describe("agent runtime v0", () => {
  it("streams the answer, saves the report and records usage", async () => {
    const runId = await queuedRun();
    const { runtime, events } = runtimeWith();

    await runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run).toMatchObject({
      status: "completed",
      stage: "synthesizing",
      model: "fake-model",
      stepCount: 1,
      costUsd: 0,
    });
    expect(run!.tokensInput).toBeGreaterThan(0);
    expect(run!.tokensOutput).toBe(3); // "Hello ", "research ", "world."
    expect(run!.startedAt).toBeInstanceOf(Date);
    expect(run!.completedAt).toBeInstanceOf(Date);

    const [report] = await db.select().from(reports).where(eq(reports.runId, runId));
    expect(report).toMatchObject({
      status: "final",
      contentMd: "Hello research world.",
      version: 1,
    });

    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ seq: 1, type: "llm_call", model: "fake-model" });

    // Events: running → deltas that rebuild the text exactly → completed.
    const statuses = events.published.filter((e) => e.type === "status").map((e) => e.status);
    expect(statuses).toEqual(["running", "completed"]);
    let rebuilt = "";
    for (const e of events.published) {
      if (e.type !== "delta") continue;
      expect(e.offset).toBe(rebuilt.length);
      rebuilt += e.text;
    }
    expect(rebuilt).toBe("Hello research world.");
  });

  it("marks the run failed with the provider's error", async () => {
    const runId = await queuedRun();
    const llm = createFakeLlmClient({
      delayMs: 0,
      failWith: new LlmError("Rate limit reached", "rate_limit_exceeded", true),
      failAfterChunks: 2,
    });
    const { runtime, events } = runtimeWith(llm);

    await runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run).toMatchObject({
      status: "failed",
      errorCode: "LLM_RATE_LIMIT_EXCEEDED",
      errorMessage: "Rate limit reached",
    });
    expect(events.published.at(-1)).toMatchObject({ type: "status", status: "failed" });
  });

  it("stops when cancelled and keeps the partial answer", async () => {
    const runId = await queuedRun();
    const controller = new AbortController();
    const llm = createFakeLlmClient({
      delayMs: 5,
      answer: () => "one two three four five six seven",
    });
    const { runtime } = runtimeWith(llm);

    const running = runtime.runResearch(runId, controller.signal);
    await new Promise((r) => setTimeout(r, 12));
    // What the API does on cancel: set status, then the worker aborts.
    await db.update(researchRuns).set({ status: "cancelled" }).where(eq(researchRuns.id, runId));
    controller.abort();
    await running;

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run!.status).toBe("cancelled");
    expect(run!.completedAt).toBeInstanceOf(Date);
    const [report] = await db.select().from(reports).where(eq(reports.runId, runId));
    expect(report!.contentMd.length).toBeGreaterThan(0);
    expect(report!.contentMd).not.toBe("one two three four five six seven");
  });

  it("skips runs that are no longer queued (cancelled before a worker picked them up)", async () => {
    const runId = await queuedRun();
    await db.update(researchRuns).set({ status: "cancelled" }).where(eq(researchRuns.id, runId));
    const { runtime, events } = runtimeWith();

    await runtime.runResearch(runId);

    expect(events.published).toHaveLength(0);
    const rows = await db.select().from(reports).where(eq(reports.runId, runId));
    expect(rows).toHaveLength(0);
  });
});
