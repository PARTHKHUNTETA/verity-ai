import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { researchRuns } from "../../infrastructure/database/schema/index.js";
import {
  app,
  bearer,
  fakeQueue,
  login,
  registerUser,
  resetDatabase,
  testEvents,
  type TestSession,
} from "../../tests/helpers.js";

beforeEach(resetDatabase);

const QUESTION = "What are the main approaches to building AI agents?";

async function createTask(session: TestSession, question = QUESTION) {
  return request(app)
    .post("/api/v1/research/tasks")
    .set("Authorization", bearer(session))
    .send({ question });
}

describe("POST /research/tasks", () => {
  it("creates a task and a queued run, and enqueues the run", async () => {
    const owner = await registerUser("owner@example.com");
    const res = await createTask(owner);

    expect(res.status).toBe(201);
    expect(res.body.task.question).toBe(QUESTION);
    expect(res.body.run).toMatchObject({
      status: "queued",
      model: "fake-model",
      promptVersion: "pipeline-v1",
    });
    expect(fakeQueue.enqueued).toEqual([res.body.run.id]);
  });

  it("validates the question", async () => {
    const owner = await registerUser("owner@example.com");
    const res = await createTask(owner, "short");
    expect(res.status).toBe(400);
    expect(fakeQueue.enqueued).toHaveLength(0);
  });

  it("does not let viewers start research", async () => {
    const owner = await registerUser("owner@example.com");
    await registerUser("viewer@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "viewer@example.com", role: "viewer" })
      .expect(201);
    const viewer = await login("viewer@example.com", owner.organizationId);

    expect((await createTask(viewer)).status).toBe(403);
  });
});

describe("reading tasks and runs", () => {
  it("lists tasks with their latest run, newest first", async () => {
    const owner = await registerUser("owner@example.com");
    await createTask(owner, "First research question here");
    const second = await createTask(owner, "Second research question here");
    await request(app)
      .post(`/api/v1/research/tasks/${second.body.task.id}/runs`)
      .set("Authorization", bearer(owner))
      .expect(201);

    const res = await request(app)
      .get("/api/v1/research/tasks")
      .set("Authorization", bearer(owner));
    expect(res.body.tasks.map((t: { question: string }) => t.question)).toEqual([
      "Second research question here",
      "First research question here",
    ]);
    expect(res.body.tasks[0].latestRun.id).not.toBe(second.body.run.id); // the re-run is latest
  });

  it("returns run detail with task and report", async () => {
    const owner = await registerUser("owner@example.com");
    const created = await createTask(owner);
    const res = await request(app)
      .get(`/api/v1/research/runs/${created.body.run.id}`)
      .set("Authorization", bearer(owner));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      run: { id: created.body.run.id, status: "queued" },
      task: { question: QUESTION },
      report: null,
    });
  });

  it("hides other organizations' runs (404)", async () => {
    const ownerA = await registerUser("a@example.com");
    const ownerB = await registerUser("b@example.com");
    const created = await createTask(ownerA);

    const res = await request(app)
      .get(`/api/v1/research/runs/${created.body.run.id}`)
      .set("Authorization", bearer(ownerB));
    expect(res.status).toBe(404);
  });
});

describe("POST /research/runs/:id/cancel", () => {
  it("cancels a queued run and tells the worker", async () => {
    const owner = await registerUser("owner@example.com");
    const created = await createTask(owner);
    const runId = created.body.run.id;

    const res = await request(app)
      .post(`/api/v1/research/runs/${runId}/cancel`)
      .set("Authorization", bearer(owner));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(testEvents.published).toContainEqual(
      expect.objectContaining({ type: "status", runId, status: "cancelled" }),
    );
  });

  it("refuses to cancel a finished run", async () => {
    const owner = await registerUser("owner@example.com");
    const created = await createTask(owner);
    await db
      .update(researchRuns)
      .set({ status: "completed" })
      .where(eq(researchRuns.id, created.body.run.id));

    const res = await request(app)
      .post(`/api/v1/research/runs/${created.body.run.id}/cancel`)
      .set("Authorization", bearer(owner));
    expect(res.status).toBe(409);
  });

  it("lets researchers cancel only their own runs", async () => {
    const owner = await registerUser("owner@example.com");
    await registerUser("res@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "researcher" })
      .expect(201);
    const researcher = await login("res@example.com", owner.organizationId);
    const ownersRun = await createTask(owner);

    const res = await request(app)
      .post(`/api/v1/research/runs/${ownersRun.body.run.id}/cancel`)
      .set("Authorization", bearer(researcher));
    expect(res.status).toBe(403);
  });
});

describe("GET /research/runs/:id/stream (SSE)", () => {
  it("sends a snapshot then done for a finished run", async () => {
    const owner = await registerUser("owner@example.com");
    const created = await createTask(owner);
    await db
      .update(researchRuns)
      .set({ status: "completed" })
      .where(eq(researchRuns.id, created.body.run.id));

    const res = await request(app)
      .get(`/api/v1/research/runs/${created.body.run.id}/stream`)
      .set("Authorization", bearer(owner));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toMatch(/^event: snapshot\ndata: \{.*"status":"completed"/);
    expect(res.text).toMatch(/event: done\ndata: \{\}\n\n$/);
  });

  it("streams live events until the run finishes", async () => {
    const owner = await registerUser("owner@example.com");
    const created = await createTask(owner);
    const runId = created.body.run.id;

    const pending = request(app)
      .get(`/api/v1/research/runs/${runId}/stream`)
      .set("Authorization", bearer(owner))
      .buffer(true)
      .parse((res, done) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => done(null, body));
      });

    // Simulate the worker once the stream is open.
    setTimeout(async () => {
      await testEvents.publish({ type: "status", runId, status: "running", stage: "synthesizing" });
      await testEvents.publish({ type: "delta", runId, offset: 0, text: "Hello " });
      await testEvents.publish({ type: "delta", runId, offset: 6, text: "world" });
      await db.update(researchRuns).set({ status: "completed" }).where(eq(researchRuns.id, runId));
      await testEvents.publish({
        type: "status",
        runId,
        status: "completed",
        stage: "synthesizing",
      });
    }, 50);

    const res = await pending;
    const events = (res.body as string)
      .trim()
      .split("\n\n")
      .map((block) => block.split("\n")[0]!.replace("event: ", ""));
    // A snapshot comes first, after each status change, and at the end, followed by done.
    // (The mid-run snapshot is async, so its exact position among the deltas may vary.)
    expect(events[0]).toBe("snapshot");
    expect(events.slice(-2)).toEqual(["snapshot", "done"]);
    expect(events.filter((e) => e === "delta")).toHaveLength(2);
    expect(events.filter((e) => e === "status")).toHaveLength(2);
    expect(res.body).toContain('"text":"Hello "');
  });

  it("returns a normal JSON 404 for runs in other organizations", async () => {
    const ownerA = await registerUser("a@example.com");
    const ownerB = await registerUser("b@example.com");
    const created = await createTask(ownerA);

    const res = await request(app)
      .get(`/api/v1/research/runs/${created.body.run.id}/stream`)
      .set("Authorization", bearer(ownerB));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
