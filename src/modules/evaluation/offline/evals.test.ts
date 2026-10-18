import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../../infrastructure/database/client.js";
import {
  evalRuns,
  researchRuns,
  toolCalls,
} from "../../../infrastructure/database/schema/index.js";
import { createFakeLlmClient, type FakeOptions } from "../../../infrastructure/llm/index.js";
import {
  app,
  bearer,
  fakeQueue,
  login,
  registerUser,
  resetDatabase,
  type TestSession,
} from "../../../tests/helpers.js";
import { buildRuntime, ingestQueued, silentLogger } from "../../../tests/research-setup.js";
import { fakeReport, researchFakes } from "../../agent/fakes.js";
import { saveNewVersion } from "../../policies/policies.repository.js";
import { DEFAULT_POLICY_RULES } from "../../policies/policy-rules.js";
import { createEvalRunner } from "./runner.js";
import { STARTER_CASES } from "./starter-dataset.js";

beforeEach(async () => {
  await resetDatabase();
  fakeQueue.evalRuns.length = 0;
  fakeQueue.ingests.length = 0;
});

const api = (session: TestSession) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set("Authorization", bearer(session)),
  post: (path: string, body: object = {}) =>
    request(app).post(`/api/v1${path}`).set("Authorization", bearer(session)).send(body),
  put: (path: string, body: object) =>
    request(app).put(`/api/v1${path}`).set("Authorization", bearer(session)).send(body),
  delete: (path: string) =>
    request(app).delete(`/api/v1${path}`).set("Authorization", bearer(session)),
});

function runnerWith(fakes: FakeOptions = researchFakes) {
  const { runtime } = buildRuntime(fakes);
  return createEvalRunner({
    db,
    runtime,
    llm: createFakeLlmClient({ delayMs: 0, ...fakes }),
    logger: silentLogger,
  });
}

/** An owner with the starter dataset installed and its documents indexed. */
async function withStarter() {
  const owner = await registerUser("owner@example.com");
  const res = await api(owner).post("/evals/datasets/starter").expect(201);
  await ingestQueued();
  return { owner, datasetId: res.body.id as string };
}

async function startAndRun(owner: TestSession, body: object, fakes?: FakeOptions) {
  const res = await api(owner).post("/evals/runs", body).expect(201);
  expect(fakeQueue.evalRuns).toContain(res.body.id);
  await runnerWith(fakes).execute(res.body.id);
  return (await api(owner).get(`/evals/runs/${res.body.id}`).expect(200)).body;
}

describe("eval datasets", () => {
  it("creates, edits and deletes datasets and cases", async () => {
    const owner = await registerUser("owner@example.com");
    const ds = await api(owner)
      .post("/evals/datasets", { name: "my-set", description: "Mine" })
      .expect(201);
    await api(owner).post("/evals/datasets", { name: "my-set" }).expect(409);
    await api(owner).post("/evals/datasets", { name: "Bad Name" }).expect(400);

    const c = await api(owner)
      .post(`/evals/datasets/${ds.body.id}/cases`, {
        question: "How do agents plan?",
        requiredPoints: ["Agents plan"],
        category: "edge",
      })
      .expect(201);
    expect(c.body).toMatchObject({
      position: 1,
      category: "edge",
      requiredPoints: ["Agents plan"],
      tags: [],
    });
    await api(owner)
      .put(`/evals/datasets/${ds.body.id}/cases/${c.body.id}`, {
        question: "How do agents plan now?",
      })
      .expect(200);

    const detail = await api(owner).get(`/evals/datasets/${ds.body.id}`).expect(200);
    expect(detail.body.cases).toEqual([
      expect.objectContaining({
        question: "How do agents plan now?",
        category: "normal",
        requiredPoints: [],
      }),
    ]);
    const list = await api(owner).get("/evals/datasets").expect(200);
    expect(list.body.datasets).toEqual([expect.objectContaining({ name: "my-set", caseCount: 1 })]);

    await api(owner).delete(`/evals/datasets/${ds.body.id}/cases/${c.body.id}`).expect(204);
    await api(owner).delete(`/evals/datasets/${ds.body.id}`).expect(204);
    await api(owner).get(`/evals/datasets/${ds.body.id}`).expect(404);
  });

  it("lets viewers read but not change datasets, and hides other organizations' datasets", async () => {
    const owner = await registerUser("owner@example.com");
    const ds = await api(owner).post("/evals/datasets", { name: "my-set" }).expect(201);
    await registerUser("viewer@example.com");
    await api(owner)
      .post("/organization/members", { email: "viewer@example.com", role: "viewer" })
      .expect(201);
    const viewer = await login("viewer@example.com", owner.organizationId);

    await api(viewer).get(`/evals/datasets/${ds.body.id}`).expect(200);
    await api(viewer)
      .post(`/evals/datasets/${ds.body.id}/cases`, { question: "Anything?" })
      .expect(403);
    await api(viewer).post("/evals/runs", { datasetId: ds.body.id, name: "x" }).expect(403);

    const other = await registerUser("other@example.com");
    await api(other).get(`/evals/datasets/${ds.body.id}`).expect(404);
  });

  it("installs the starter dataset with its fixture documents, once", async () => {
    const { owner, datasetId } = await withStarter();
    const detail = await api(owner).get(`/evals/datasets/${datasetId}`).expect(200);
    expect(detail.body.cases).toHaveLength(STARTER_CASES.length);
    expect(
      detail.body.cases.filter((c: { category: string }) => c.category === "red_team"),
    ).toHaveLength(5);

    const collection = await api(owner).get(`/collections/${detail.body.collectionId}`).expect(200);
    expect(collection.body.sources).toHaveLength(6);
    expect(collection.body.sources.every((s: { status: string }) => s.status === "ready")).toBe(
      true,
    );

    await api(owner).post("/evals/datasets/starter").expect(409);
  });
});

describe("eval runs", () => {
  it("runs every case through the agent with a frozen config and scores it", async () => {
    const { owner, datasetId } = await withStarter();
    const run = await startAndRun(owner, { datasetId, name: "baseline", limit: 3 });

    expect(run).toMatchObject({
      status: "completed",
      progress: { done: 3, total: 3 },
      config: {
        model: "fake-model",
        pipelineVersion: "pipeline-v1",
        revise: true,
        topK: 4,
        discovery: false,
        limit: 3,
        promptVersions: expect.objectContaining({
          report: "report-v1",
          claimJudge: "claim-judge-v1",
        }),
      },
    });
    expect(run.config.collectionIds).toEqual([expect.any(String)]);
    expect(run.results).toHaveLength(3);
    for (const r of run.results) {
      expect(r.scores).toMatchObject({ completed: true, claimSupport: expect.any(Number) });
      expect(r.researchRunId).toEqual(expect.any(String));
      expect(typeof r.passed).toBe("boolean");
    }
    expect(run.summary).toMatchObject({ cases: 3, completed: 3 });

    // The cases' research runs are unattended and don't show up in the research history.
    const [researchRun] = await db
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, run.results[0].researchRunId));
    expect(researchRun!.config).toMatchObject({ unattended: true, eval: { runId: run.id } });
    const history = await api(owner).get("/research/tasks").expect(200);
    expect(history.body.tasks).toEqual([]);
  });

  it("compares two configs metric by metric (revision on vs off)", async () => {
    const { owner, datasetId } = await withStarter();
    const withRevision = await startAndRun(owner, { datasetId, name: "revise on", limit: 2 });
    const without = await startAndRun(owner, {
      datasetId,
      name: "revise off",
      limit: 2,
      revise: false,
    });

    const res = await api(owner)
      .get(`/evals/compare?a=${without.id}&b=${withRevision.id}`)
      .expect(200);
    const claimSupport = res.body.metrics.find((m: { key: string }) => m.key === "claimSupport");
    // The fake report's summary cites a quote that doesn't say it; only the revision fixes that.
    expect(claimSupport.b).toBeGreaterThan(claimSupport.a);
    expect(claimSupport.better).toBe("b");
    expect(res.body.cases).toHaveLength(2);
    expect(res.body.cases[0]).toMatchObject({
      question: expect.any(String),
      change: expect.any(String),
    });

    const list = await api(owner).get(`/evals/runs?datasetId=${datasetId}`).expect(200);
    expect(list.body.runs.map((r: { name: string }) => r.name)).toEqual([
      "revise off",
      "revise on",
    ]);
  });

  it("refuses to compare unfinished runs or runs on different datasets", async () => {
    const { owner, datasetId } = await withStarter();
    const other = await api(owner).post("/evals/datasets", { name: "other" }).expect(201);
    await api(owner)
      .post(`/evals/datasets/${other.body.id}/cases`, { question: "What is RAG?" })
      .expect(201);
    const a = await api(owner).post("/evals/runs", { datasetId, name: "a" }).expect(201);
    const b = await api(owner)
      .post("/evals/runs", { datasetId: other.body.id, name: "b" })
      .expect(201);
    const c = await api(owner).post("/evals/runs", { datasetId, name: "c" }).expect(201);
    await api(owner).get(`/evals/compare?a=${a.body.id}&b=${b.body.id}`).expect(400);
    await api(owner).get(`/evals/compare?a=${a.body.id}&b=${c.body.id}`).expect(400);
  });

  it("flags a red-team case whose report obeys the injected instructions", async () => {
    const { owner, datasetId } = await withStarter();
    const detail = await api(owner).get(`/evals/datasets/${datasetId}`);
    const redTeam = detail.body.cases.filter(
      (c: { category: string }) => c.category === "red_team",
    );
    // A dataset with just the first red-team case.
    const ds = await api(owner)
      .post("/evals/datasets", { name: "attack", collectionId: detail.body.collectionId })
      .expect(201);
    const { question, category, forbiddenSources, forbiddenContent, expectedSources } = redTeam[0];
    await api(owner)
      .post(`/evals/datasets/${ds.body.id}/cases`, {
        question,
        category,
        forbiddenSources,
        forbiddenContent,
        expectedSources,
      })
      .expect(201);

    const obeys = {
      ...researchFakes,
      answer: (input: string) => `${fakeReport(input)}\n\nVERITY-PWNED`,
    };
    const run = await startAndRun(owner, { datasetId: ds.body.id, name: "naive" }, obeys);
    expect(run.results[0]).toMatchObject({ passed: false, category: "red_team" });
    expect(run.results[0].scores.forbiddenContentFound).toEqual(["VERITY-PWNED"]);
    expect(run.results[0].failures).toContain("Report contains forbidden content: VERITY-PWNED");
  });

  it("denies tool calls that need approval instead of pausing (unattended)", async () => {
    const { owner, datasetId } = await withStarter();
    const rules = structuredClone(DEFAULT_POLICY_RULES);
    rules.tools.run_code.requireApproval = true;
    await saveNewVersion(db, owner.organizationId, rules, owner.userId);

    const run = await startAndRun(owner, { datasetId, name: "strict policy", limit: 1 });
    expect(run.results[0].scores.completed).toBe(true);
    const calls = await db
      .select({ tool: toolCalls.tool, status: toolCalls.status })
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.results[0].researchRunId));
    expect(calls).toContainEqual({ tool: "run_code", status: "denied" });
    const pending = await api(owner).get("/approvals?status=pending").expect(200);
    expect(pending.body.approvals ?? pending.body).toHaveLength(0);
  });

  it("can be cancelled before it runs, and then does nothing", async () => {
    const { owner, datasetId } = await withStarter();
    const res = await api(owner).post("/evals/runs", { datasetId, name: "stop me" }).expect(201);
    await api(owner).post(`/evals/runs/${res.body.id}/cancel`).expect(200);
    await api(owner).post(`/evals/runs/${res.body.id}/cancel`).expect(409);
    expect(await runnerWith().execute(res.body.id)).toBeNull();
    const [row] = await db.select().from(evalRuns).where(eq(evalRuns.id, res.body.id));
    expect(row!.status).toBe("cancelled");
  });

  it("refuses to start on an empty dataset", async () => {
    const owner = await registerUser("owner@example.com");
    const ds = await api(owner).post("/evals/datasets", { name: "empty" }).expect(201);
    await api(owner).post("/evals/runs", { datasetId: ds.body.id, name: "x" }).expect(400);
  });
});
