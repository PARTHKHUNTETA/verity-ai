import { and, eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import {
  approvals,
  auditLogs,
  policyDecisions,
  researchRuns,
  toolCalls,
} from "../../infrastructure/database/schema/index.js";
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
import { buildRuntime, ownerWithNotes, queueRun } from "../../tests/research-setup.js";
import { loadState } from "../agent/state.js";
import { saveNewVersion } from "./policies.repository.js";
import { DEFAULT_POLICY_RULES, type PolicyRules } from "./policy-rules.js";

beforeEach(resetDatabase);

async function setPolicy(owner: TestSession, patch: (r: PolicyRules) => void) {
  const rules = structuredClone(DEFAULT_POLICY_RULES);
  patch(rules);
  await saveNewVersion(db, owner.organizationId, rules, owner.userId);
}

async function run(runId: string) {
  const [row] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
  return row!;
}

async function pendingApproval(runId: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
  return row;
}

function decide(session: TestSession, approvalId: string, body: object) {
  return request(app)
    .post(`/api/v1/approvals/${approvalId}/decision`)
    .set("Authorization", bearer(session))
    .send(body);
}

describe("approval of a sensitive tool call", () => {
  it("pauses the run, lets an admin approve, and continues where it stopped", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.tools.run_code.requireApproval = true));
    const runId = await queueRun(owner);

    await buildRuntime().runtime.runResearch(runId);

    // Paused at analysis, with everything before it done.
    const paused = await run(runId);
    expect(paused).toMatchObject({ status: "awaiting_approval", stage: "analyzing" });
    expect(loadState(paused.state).completed).toEqual(["planning", "retrieving", "extracting"]);
    const approval = await pendingApproval(runId);
    expect(approval).toMatchObject({ kind: "tool_call" });
    expect(approval!.summary).toMatch(/^Run code:/);
    const [call] = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, runId), eq(toolCalls.tool, "run_code")));
    expect(call!.status).toBe("awaiting_approval");

    // The inbox shows it; the owner approves.
    const inbox = await request(app).get("/api/v1/approvals").set("Authorization", bearer(owner));
    expect(inbox.body.approvals[0]).toMatchObject({
      id: approval!.id,
      question: expect.any(String),
    });
    const res = await decide(owner, approval!.id, { decision: "approve", comment: "fine" });
    expect(res.status).toBe(200);

    // The run is queued again and announced.
    expect(await run(runId)).toMatchObject({ status: "queued" });
    expect(fakeQueue.enqueued.at(-1)).toBe(runId);
    expect(testEvents.published.at(-1)).toMatchObject({ type: "status", runId, status: "queued" });

    // The worker picks it up: the approved code runs, and the run completes.
    await buildRuntime().runtime.runResearch(runId);
    expect(await run(runId)).toMatchObject({ status: "completed" });
    const [executed] = await db.select().from(toolCalls).where(eq(toolCalls.id, call!.id));
    expect(executed!.status).toBe("succeeded");
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "approval.decide"));
    expect(audit).toHaveLength(1);
  });

  it("continues without the tool when the call is rejected", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.tools.run_code.requireApproval = true));
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);
    const approval = await pendingApproval(runId);

    await decide(owner, approval!.id, { decision: "reject", comment: "no code please" }).expect(
      200,
    );
    await buildRuntime().runtime.runResearch(runId);

    expect(await run(runId)).toMatchObject({ status: "completed" });
    const [call] = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, runId), eq(toolCalls.tool, "run_code")));
    expect(call).toMatchObject({
      status: "denied",
      error: "Rejected by a reviewer: no code please",
    });
  });

  it("only lets owners and admins decide, and only once", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.tools.run_code.requireApproval = true));
    await registerUser("res@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "researcher" })
      .expect(201);
    const researcher = await login("res@example.com", owner.organizationId);
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);
    const approval = await pendingApproval(runId);

    expect(
      (await request(app).get("/api/v1/approvals").set("Authorization", bearer(researcher))).status,
    ).toBe(403);
    expect((await decide(researcher, approval!.id, { decision: "approve" })).status).toBe(403);

    await decide(owner, approval!.id, { decision: "approve" }).expect(200);
    expect((await decide(owner, approval!.id, { decision: "reject" })).status).toBe(409);
  });

  it("withdraws pending approvals when the run is cancelled", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.tools.run_code.requireApproval = true));
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    await request(app)
      .post(`/api/v1/research/runs/${runId}/cancel`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(await pendingApproval(runId)).toBeUndefined();
  });
});

describe("budget approval", () => {
  it("pauses an over-budget run until an admin raises its limit", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.budget.maxSteps = 3));
    const runId = await queueRun(owner);

    await buildRuntime().runtime.runResearch(runId);

    expect(await run(runId)).toMatchObject({ status: "awaiting_approval" });
    const approval = await pendingApproval(runId);
    expect(approval).toMatchObject({ kind: "budget", details: { limit: "maxSteps", max: 3 } });

    await decide(owner, approval!.id, { decision: "approve", newLimit: 100 }).expect(200);
    const queued = await run(runId);
    expect((queued.config as { budget: { maxSteps: number } }).budget.maxSteps).toBe(100);

    await buildRuntime().runtime.runResearch(runId);
    expect(await run(runId)).toMatchObject({ status: "completed" });
  });

  it("fails the run when more budget is declined", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.budget.maxSteps = 3));
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    await decide(owner, (await pendingApproval(runId))!.id, { decision: "reject" }).expect(200);
    expect(await run(runId)).toMatchObject({ status: "failed", errorCode: "BUDGET_REJECTED" });
  });

  it("fails immediately when the policy says not to ask", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => {
      r.budget.maxSteps = 3;
      r.budget.onExceed = "fail";
    });
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);
    expect(await run(runId)).toMatchObject({ status: "failed", errorCode: "BUDGET_EXCEEDED" });
  });
});

describe("policy API", () => {
  it("lets admins read and version the policy, normalizing domains", async () => {
    const owner = await registerUser("owner@example.com");
    const active = await request(app)
      .get("/api/v1/policies/active")
      .set("Authorization", bearer(owner));
    expect(active.body).toMatchObject({ version: 1, rules: DEFAULT_POLICY_RULES });

    const rules = structuredClone(DEFAULT_POLICY_RULES);
    rules.domains.blocked = ["WWW.Spam.Example"];
    const saved = await request(app)
      .put("/api/v1/policies/active")
      .set("Authorization", bearer(owner))
      .send({ rules });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      version: 2,
      rules: { domains: { blocked: ["spam.example"] } },
    });

    const versions = await request(app)
      .get("/api/v1/policies/versions")
      .set("Authorization", bearer(owner));
    expect(
      versions.body.versions.map((v: { version: number; isActive: boolean }) => [
        v.version,
        v.isActive,
      ]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, "policy.update")),
    ).toHaveLength(1);
  });

  it("rejects invalid rules and non-admins", async () => {
    const owner = await registerUser("owner@example.com");
    const bad = structuredClone(DEFAULT_POLICY_RULES) as unknown as {
      domains: { blocked: string[] };
    };
    bad.domains.blocked = ["not a domain"];
    expect(
      (
        await request(app)
          .put("/api/v1/policies/active")
          .set("Authorization", bearer(owner))
          .send({ rules: bad })
      ).status,
    ).toBe(400);

    await registerUser("res@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "researcher" })
      .expect(201);
    const researcher = await login("res@example.com", owner.organizationId);
    expect(
      (await request(app).get("/api/v1/policies/active").set("Authorization", bearer(researcher)))
        .status,
    ).toBe(403);
  });

  it("shows a run's denials and approval requests in its detail", async () => {
    const owner = await ownerWithNotes();
    await setPolicy(owner, (r) => (r.tools.run_code.requireApproval = true));
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    expect(detail.body.approvals).toEqual([
      expect.objectContaining({ kind: "tool_call", status: "pending" }),
    ]);
    expect(detail.body.decisions).toEqual([
      expect.objectContaining({
        tool: "run_code",
        decision: "require_approval",
        matchedRule: "code_requires_approval",
      }),
    ]);
    expect(
      (await db.select().from(policyDecisions).where(eq(policyDecisions.runId, runId))).length,
    ).toBeGreaterThan(1);
  });
});
