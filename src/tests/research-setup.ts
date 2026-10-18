import { pino } from "pino";
import request from "supertest";
import { db } from "../infrastructure/database/client.js";
import { createInMemoryRunEventBus } from "../infrastructure/events/run-events.js";
import { createFakeLlmClient, type FakeOptions } from "../infrastructure/llm/index.js";
import { createAgentRuntime } from "../modules/agent/agent-runtime.js";
import { researchFakes } from "../modules/agent/fakes.js";
import { createIngestionService } from "../modules/retrieval/ingestion.js";
import { createSearchService } from "../modules/retrieval/search.js";
import {
  app,
  bearer,
  fakeQueue,
  memoryStorage,
  registerUser,
  testLlm,
  type TestSession,
} from "./helpers.js";

/** Shared setup for pipeline/policy tests: an owner, a collection with notes, a queued run. */

export const silentLogger = pino({ level: "silent" });
export const testSearch = createSearchService(db, testLlm, "fake-embedding");
const ingestion = createIngestionService({
  db,
  llm: testLlm,
  storage: memoryStorage,
  embeddingModel: "fake-embedding",
  logger: silentLogger,
});

export const AGENT_NOTES = `# Notes on AI Agents

ReAct agents interleave reasoning traces with tool calls, which lets them update plans as they observe results.

Plan-and-execute agents first write a complete plan and then run each step; they are cheaper but adapt less when a step fails.

Evaluating agents is still an open problem because benchmarks rarely measure whether cited sources support the claims.`;

export async function ownerWithNotes(email = "owner@example.com"): Promise<TestSession> {
  const owner = await registerUser(email);
  const collection = await request(app)
    .post("/api/v1/collections")
    .set("Authorization", bearer(owner))
    .send({ name: "Agents" });
  await request(app)
    .post(`/api/v1/collections/${collection.body.id}/sources`)
    .set("Authorization", bearer(owner))
    .attach("file", Buffer.from(AGENT_NOTES), "notes.md")
    .expect(201);
  for (const id of fakeQueue.ingests.splice(0)) await ingestion.ingestSource(id);
  return owner;
}

export async function queueRun(
  session: TestSession,
  question = "How do AI agents plan, and what are the open problems?",
): Promise<string> {
  const res = await request(app)
    .post("/api/v1/research/tasks")
    .set("Authorization", bearer(session))
    .send({ question, discover: false });
  return res.body.run.id as string;
}

export function buildRuntime(fakes: FakeOptions = researchFakes) {
  const events = createInMemoryRunEventBus();
  const llm = createFakeLlmClient({ delayMs: 0, ...fakes });
  return {
    runtime: createAgentRuntime({
      db,
      llm,
      search: testSearch,
      events,
      logger: silentLogger,
      publishIntervalMs: 5,
    }),
    events,
  };
}
