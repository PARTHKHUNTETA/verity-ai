import { asc, eq } from "drizzle-orm";
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
  sourceChunks,
  subQuestions,
  toolCalls,
} from "../../infrastructure/database/schema/index.js";
import { createInMemoryRunEventBus } from "../../infrastructure/events/run-events.js";
import { createFakeLlmClient, type FakeOptions } from "../../infrastructure/llm/index.js";
import {
  app,
  bearer,
  fakeQueue,
  memoryStorage,
  registerUser,
  resetDatabase,
  testLlm,
  type TestSession,
} from "../../tests/helpers.js";
import { createIngestionService } from "../retrieval/ingestion.js";
import { createSearchService } from "../retrieval/search.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { researchFakes } from "./fakes.js";
import { loadState } from "./state.js";

beforeEach(resetDatabase);

const logger = pino({ level: "silent" });
const search = createSearchService(db, testLlm, "fake-embedding");
const ingestion = createIngestionService({
  db,
  llm: testLlm,
  storage: memoryStorage,
  embeddingModel: "fake-embedding",
  logger,
});

const NOTES = `# Notes on AI Agents

ReAct agents interleave reasoning traces with tool calls, which lets them update plans as they observe results.

Plan-and-execute agents first write a complete plan and then run each step; they are cheaper but adapt less when a step fails.

Evaluating agents is still an open problem because benchmarks rarely measure whether cited sources support the claims.`;

/** An owner with one collection containing the notes, and a queued run for `question`. */
async function setup(question = "How do AI agents plan, and what are the open problems?") {
  const owner = await registerUser("owner@example.com");
  const collection = await request(app)
    .post("/api/v1/collections")
    .set("Authorization", bearer(owner))
    .send({ name: "Agents" });
  await request(app)
    .post(`/api/v1/collections/${collection.body.id}/sources`)
    .set("Authorization", bearer(owner))
    .attach("file", Buffer.from(NOTES), "notes.md")
    .expect(201);
  for (const id of fakeQueue.ingests.splice(0)) await ingestion.ingestSource(id);
  const res = await request(app)
    .post("/api/v1/research/tasks")
    .set("Authorization", bearer(owner))
    .send({ question, discover: false });
  return { owner, runId: res.body.run.id as string };
}

function runtimeWith(fakes: FakeOptions = researchFakes) {
  const events = createInMemoryRunEventBus();
  const llm = createFakeLlmClient({ delayMs: 0, ...fakes });
  return {
    runtime: createAgentRuntime({ db, llm, search, events, logger, publishIntervalMs: 5 }),
    events,
  };
}

async function runRow(runId: string) {
  const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
  return run!;
}

describe("research pipeline", () => {
  it("plans, retrieves, extracts verbatim evidence, analyzes with code and writes a structured report", async () => {
    const { owner, runId } = await setup();
    const { runtime, events } = runtimeWith();

    await runtime.runResearch(runId);

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: "completed", promptVersion: "pipeline-v1" });
    expect(loadState(run.state).completed).toEqual([
      "planning",
      "retrieving",
      "extracting",
      "analyzing",
      "synthesizing",
    ]);
    // The UI saw every stage in order.
    const stages = events.published
      .filter((e) => e.type === "status")
      .map((e) => e.type === "status" && e.stage);
    expect(stages).toEqual([
      "planning",
      "retrieving",
      "extracting",
      "analyzing",
      "synthesizing",
      "synthesizing",
    ]);

    // Plan: 3 sub-questions, all answered with cited evidence.
    const sqs = await db
      .select()
      .from(subQuestions)
      .where(eq(subQuestions.runId, runId))
      .orderBy(asc(subQuestions.position));
    expect(sqs).toHaveLength(3);
    expect(sqs.map((s) => s.coverage)).toContain("answered");

    // Evidence: numbered quotes that really occur in the chunk they cite, with stance + confidence.
    const ev = await db
      .select({ evidence, content: sourceChunks.content })
      .from(evidence)
      .innerJoin(sourceChunks, eq(sourceChunks.id, evidence.chunkId))
      .where(eq(evidence.runId, runId))
      .orderBy(asc(evidence.rank));
    expect(ev.length).toBeGreaterThan(0);
    ev.forEach((row, i) => {
      expect(row.evidence.rank).toBe(i + 1);
      expect(row.content.replace(/\s+/g, " ")).toContain(row.evidence.quote);
      expect(row.evidence).toMatchObject({ stance: "supports" });
      expect(row.evidence.confidence).toBeGreaterThan(0);
    });

    // Analysis: the tool loop ran code in the sandbox.
    const calls = await db.select().from(toolCalls).where(eq(toolCalls.runId, runId));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "run_code", status: "succeeded" });
    expect((calls[0]!.result as { value: { distinctSources: number } }).value.distinctSources).toBe(
      1,
    );

    // Report: title + required sections + comparison table, with claims linked to evidence.
    const [report] = await db.select().from(reports).where(eq(reports.runId, runId));
    expect(report!.title).toMatch(/^Research brief/);
    for (const heading of [
      "## Summary",
      "## Findings",
      "## Comparison",
      "## Research gaps",
      "## Limitations",
    ]) {
      expect(report!.contentMd).toContain(heading);
    }
    expect(report!.contentMd).toContain("| Source |");
    const cl = await db.select().from(claims).where(eq(claims.reportId, report!.id));
    expect(cl.length).toBeGreaterThan(0);
    expect((await db.select().from(claimEvidence)).length).toBeGreaterThan(0);

    // Steps: one per LLM call / tool call, contiguous.
    const steps = await db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(asc(agentSteps.seq));
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(run.stepCount).toBe(steps.length);

    // The API exposes the plan, timeline and code runs for the UI.
    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner as TestSession));
    expect(detail.body.subQuestions).toHaveLength(3);
    expect(detail.body.steps.length).toBe(steps.length);
    expect(detail.body.toolCalls[0]).toMatchObject({ tool: "run_code", status: "succeeded" });
    expect(detail.body.citations[0]).toMatchObject({ number: 1, stance: "supports" });
  });

  it("discards quotes that don't appear verbatim in the passage", async () => {
    const { runId } = await setup();
    const { runtime } = runtimeWith({
      ...researchFakes,
      objects: {
        ...researchFakes.objects,
        evidence_extraction: (input: string) => ({
          evidence: [
            {
              passage: Number(input.match(/\[P(\d+)\]/)![1]),
              quote: "Agents achieve 97% accuracy on every benchmark.", // fabricated
              stance: "supports",
              confidence: 0.9,
              note: "Made up.",
            },
          ],
        }),
      },
    });

    await runtime.runResearch(runId);

    expect(await db.select().from(evidence).where(eq(evidence.runId, runId))).toHaveLength(0);
    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    const extractOutputs = steps
      .filter((s) => s.stage === "extracting")
      .map((s) => s.output as { rejected: unknown[] });
    expect(extractOutputs.flatMap((o) => o.rejected)).toContainEqual(
      expect.objectContaining({ reason: "quote not found verbatim in the passage" }),
    );
    // Sub-questions without evidence are reported as unanswered, not papered over.
    const sqs = await db.select().from(subQuestions).where(eq(subQuestions.runId, runId));
    expect(sqs.every((s) => s.coverage === "unanswered")).toBe(true);
    expect((await runRow(runId)).status).toBe("completed");
  });

  it("stops a run that exceeds its step budget", async () => {
    const { runId } = await setup();
    await db
      .update(researchRuns)
      .set({
        config: { collectionIds: [], discovery: { enabled: false }, budget: { maxSteps: 2 } },
      })
      .where(eq(researchRuns.id, runId));

    await runtimeWith().runtime.runResearch(runId);

    expect(await runRow(runId)).toMatchObject({ status: "failed", errorCode: "BUDGET_EXCEEDED" });
  });

  it("resumes a crashed run from its last completed stage without redoing earlier work", async () => {
    const { runId } = await setup();
    // First attempt: everything works until the report, where the "worker dies".
    const crashing = runtimeWith({
      ...researchFakes,
      answer: () => {
        throw new Error("worker process killed");
      },
    });
    await crashing.runtime.runResearch(runId);
    const afterCrash = await runRow(runId);
    expect(loadState(afterCrash.state).completed).toEqual([
      "planning",
      "retrieving",
      "extracting",
      "analyzing",
    ]);
    const plannedIds = (
      await db.select().from(subQuestions).where(eq(subQuestions.runId, runId))
    ).map((s) => s.id);
    // A real crash leaves the run "running" (nobody got to record the failure).
    await db
      .update(researchRuns)
      .set({ status: "running", errorCode: null, errorMessage: null })
      .where(eq(researchRuns.id, runId));

    // The retried job resumes: planning must not run again.
    let planCalls = 0;
    const resumed = runtimeWith({
      ...researchFakes,
      objects: {
        ...researchFakes.objects,
        research_plan: (input: string) => {
          planCalls++;
          return researchFakes.objects!.research_plan!(input);
        },
      },
    });
    await resumed.runtime.runResearch(runId, { resume: true });

    const run = await runRow(runId);
    expect(run.status).toBe("completed");
    expect(planCalls).toBe(0);
    expect(
      (await db.select().from(subQuestions).where(eq(subQuestions.runId, runId))).map((s) => s.id),
    ).toEqual(plannedIds);
    const seqs = (await db.select().from(agentSteps).where(eq(agentSteps.runId, runId)))
      .map((s) => s.seq)
      .sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // no duplicate or missing steps
  });

  it("does not resume a run unless it is a retried job", async () => {
    const { runId } = await setup();
    await db.update(researchRuns).set({ status: "running" }).where(eq(researchRuns.id, runId));
    const { runtime, events } = runtimeWith();
    await runtime.runResearch(runId); // a duplicate delivery, not a retry
    expect(events.published).toHaveLength(0);
  });

  it("stops between stages when cancelled", async () => {
    const { runId } = await setup();
    const controller = new AbortController();
    const { runtime } = runtimeWith({
      ...researchFakes,
      objects: {
        ...researchFakes.objects,
        research_plan: (input: string) => {
          // The user cancels while planning: the API sets the status, the worker aborts.
          // (Drizzle queries are lazy: .execute() is what actually sends this one.)
          void db
            .update(researchRuns)
            .set({ status: "cancelled" })
            .where(eq(researchRuns.id, runId))
            .execute();
          controller.abort();
          return researchFakes.objects!.research_plan!(input);
        },
      },
    });

    await runtime.runResearch(runId, { signal: controller.signal });

    const run = await runRow(runId);
    expect(run.status).toBe("cancelled");
    expect(run.completedAt).toBeInstanceOf(Date);
    expect(await db.select().from(evidence).where(eq(evidence.runId, runId))).toHaveLength(0);
  });
});
