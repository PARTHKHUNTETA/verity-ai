import { eq } from "drizzle-orm";
import { pino } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  claimEvidence,
  claims,
  evidence,
  reports,
  researchRuns,
} from "../../infrastructure/database/schema/index.js";
import { createInMemoryRunEventBus } from "../../infrastructure/events/run-events.js";
import { createFakeLlmClient, LlmError } from "../../infrastructure/llm/index.js";
import {
  app,
  bearer,
  fakeQueue,
  memoryStorage,
  registerUser,
  resetDatabase,
  testLlm,
} from "../../tests/helpers.js";
import { createIngestionService } from "../retrieval/ingestion.js";
import { createSearchService } from "../retrieval/search.js";
import { createAgentRuntime } from "./agent-runtime.js";

beforeEach(resetDatabase);

const logger = pino({ level: "silent" });

const search = createSearchService(db, testLlm, "fake-embedding");

/** Creates a queued run through the real API (the fake queue just records it). */
async function queuedRun(question = "What are the main approaches to building AI agents?") {
  const owner = await registerUser("owner@example.com");
  return queuedRunFor(owner, question);
}

async function queuedRunFor(owner: Awaited<ReturnType<typeof registerUser>>, question: string) {
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
  const runtime = createAgentRuntime({ db, llm, search, events, logger, publishIntervalMs: 5 });
  return { runtime, events };
}

describe("agent runtime", () => {
  it("streams the answer, saves the report and records usage", async () => {
    const runId = await queuedRun();
    const { runtime, events } = runtimeWith();

    await runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run).toMatchObject({
      status: "completed",
      stage: "synthesizing",
      model: "fake-model",
      stepCount: 2,
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
    expect(steps.map((s) => [s.seq, s.type])).toEqual([
      [1, "tool_call"],
      [2, "llm_call"],
    ]);

    // Events: retrieving → synthesizing → deltas that rebuild the text exactly → completed.
    const statuses = events.published
      .filter((e) => e.type === "status")
      .map((e) => `${e.status}:${e.stage}`);
    expect(statuses).toEqual([
      "running:retrieving",
      "running:synthesizing",
      "completed:synthesizing",
    ]);
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

describe("answering from sources (RAG)", () => {
  it("cites retrieved passages and stores evidence and claims", async () => {
    const owner = await registerUser("owner@example.com");
    const collection = await request(app)
      .post("/api/v1/collections")
      .set("Authorization", bearer(owner))
      .send({ name: "Agents" });
    await request(app)
      .post(`/api/v1/collections/${collection.body.id}/sources`)
      .set("Authorization", bearer(owner))
      .attach(
        "file",
        Buffer.from(
          "# Agent Patterns\n\nReAct agents interleave reasoning with tool calls to adapt their plans.\n\nPlan-and-execute agents write a plan first and then run each step in order.",
        ),
        "patterns.md",
      )
      .expect(201);
    const ingestion = createIngestionService({
      db,
      llm: testLlm,
      storage: memoryStorage,
      embeddingModel: "fake-embedding",
      logger,
    });
    for (const id of fakeQueue.ingests.splice(0)) await ingestion.ingestSource(id);

    const runId = await queuedRunFor(owner, "How do ReAct agents use tool calls?");
    // The default fake answer quotes each passage and cites it.
    const { runtime } = runtimeWith(createFakeLlmClient({ delayMs: 0 }));
    await runtime.runResearch(runId);

    const ev = await db.select().from(evidence).where(eq(evidence.runId, runId));
    expect(ev.map((e) => e.rank)).toEqual([1]);
    expect(ev[0]!.quote).toContain("ReAct agents interleave reasoning");

    const [report] = await db.select().from(reports).where(eq(reports.runId, runId));
    expect(report!.contentMd).toContain("[1]");
    const cl = await db.select().from(claims).where(eq(claims.reportId, report!.id));
    expect(cl.length).toBeGreaterThan(0);
    const links = await db.select().from(claimEvidence);
    expect(links.every((l) => l.evidenceId === ev[0]!.id && l.citationNumber === 1)).toBe(true);

    // The run detail exposes the citable passages for the UI.
    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    expect(detail.body.citations).toEqual([
      expect.objectContaining({ number: 1, sourceTitle: "Agent Patterns" }),
    ]);
  });

  it("answers without sources when the collections are empty", async () => {
    const runId = await queuedRun();
    const { runtime } = runtimeWith(createFakeLlmClient({ delayMs: 0 }));
    await runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run!.status).toBe("completed");
    expect(await db.select().from(evidence).where(eq(evidence.runId, runId))).toHaveLength(0);
  });
});
