import { and, eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import {
  approvals,
  policyDecisions,
  toolCalls,
} from "../../infrastructure/database/schema/index.js";
import {
  app,
  bearer,
  login,
  registerUser,
  resetDatabase,
  type TestSession,
} from "../../tests/helpers.js";
import { queueRun, silentLogger } from "../../tests/research-setup.js";
import { DEFAULT_BUDGET } from "../agent/budget.js";
import { ApprovalRequiredError, createToolExecutor, type ExecutionContext } from "./executor.js";
import { getActivePolicy } from "./policies.repository.js";
import { evaluateToolCall, type GatewayContext } from "./policy-gateway.js";
import { DEFAULT_POLICY_RULES, type PolicyRules } from "./policy-rules.js";

beforeEach(resetDatabase);

let owner: TestSession;

function rules(patch: (r: PolicyRules) => void = () => {}): PolicyRules {
  const copy = structuredClone(DEFAULT_POLICY_RULES);
  patch(copy);
  return copy;
}

function gatewayCtx(overrides: Partial<GatewayContext> = {}): GatewayContext {
  return {
    db,
    organizationId: owner.organizationId,
    startedBy: owner.userId,
    rules: rules(),
    platformDomains: { blocked: [], allowed: [] },
    budget: DEFAULT_BUDGET,
    usage: { steps: 0, tokens: 0, costUsd: 0 },
    toolCounts: {},
    ...overrides,
  };
}

const fetchArgs = (url: string) => ({ url, pdfUrl: null });

describe("policy gateway", () => {
  beforeEach(async () => {
    owner = await registerUser("owner@example.com");
  });

  it("allows a well-formed call when every check passes", async () => {
    const result = await evaluateToolCall(
      gatewayCtx(),
      "fetch",
      fetchArgs("https://arxiv.org/abs/1"),
    );
    expect(result).toMatchObject({ decision: "allow", matchedRule: "allowed" });
    expect(result.checks.map((c) => c.check)).toEqual([
      "tool",
      "arguments",
      "permission",
      "rules",
      "budget",
    ]);
  });

  it("denies disabled and unknown tools", async () => {
    const disabled = gatewayCtx({ rules: rules((r) => (r.tools.run_code.enabled = false)) });
    expect(await evaluateToolCall(disabled, "run_code", { purpose: "x", code: "1" })).toMatchObject(
      {
        decision: "deny",
        matchedRule: "tool_disabled",
      },
    );
    expect(await evaluateToolCall(gatewayCtx(), "delete_everything", {})).toMatchObject({
      decision: "deny",
      matchedRule: "unknown_tool",
    });
  });

  it("denies invalid arguments", async () => {
    expect(
      await evaluateToolCall(gatewayCtx(), "fetch", { url: "not a url", pdfUrl: null }),
    ).toMatchObject({
      decision: "deny",
      matchedRule: "invalid_arguments",
    });
  });

  it("acts with the current role of the user who started the run", async () => {
    await registerUser("res@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "researcher" })
      .expect(201);
    const researcher = await login("res@example.com", owner.organizationId);
    const ctx = gatewayCtx({ startedBy: researcher.userId });
    expect((await evaluateToolCall(ctx, "fetch", fetchArgs("https://a.org/x"))).decision).toBe(
      "allow",
    );

    // Demoted to viewer mid-run: the agent loses the right to act for them.
    await request(app)
      .patch(`/api/v1/organization/members/${researcher.userId}`)
      .set("Authorization", bearer(owner))
      .send({ role: "viewer" })
      .expect(204);
    expect(await evaluateToolCall(ctx, "fetch", fetchArgs("https://a.org/x"))).toMatchObject({
      decision: "deny",
      matchedRule: "permission",
    });
  });

  it("only lets retrieval search collections the user can read", async () => {
    await registerUser("res@example.com");
    await request(app)
      .post("/api/v1/organization/members")
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "researcher" })
      .expect(201);
    const researcher = await login("res@example.com", owner.organizationId);
    const ownersPrivate = await request(app)
      .post("/api/v1/collections")
      .set("Authorization", bearer(owner))
      .send({ name: "Owner only", visibility: "private" });

    const result = await evaluateToolCall(gatewayCtx({ startedBy: researcher.userId }), "rag", {
      query: "agents",
      collectionIds: [ownersPrivate.body.id],
      sourceIds: [],
    });
    expect(result).toMatchObject({ decision: "deny", matchedRule: "collection_access" });
  });

  it("applies organization and platform domain rules, and allow lists", async () => {
    const orgBlocked = gatewayCtx({ rules: rules((r) => (r.domains.blocked = ["spam.example"])) });
    expect(
      await evaluateToolCall(orgBlocked, "fetch", fetchArgs("https://news.spam.example/a")),
    ).toMatchObject({
      decision: "deny",
      matchedRule: "domain_rule",
    });
    // The PDF link is checked too.
    expect(
      await evaluateToolCall(orgBlocked, "fetch", {
        url: "https://ok.org/a",
        pdfUrl: "https://spam.example/a.pdf",
      }),
    ).toMatchObject({ decision: "deny" });

    const platform = gatewayCtx({ platformDomains: { blocked: ["evil.example"], allowed: [] } });
    expect(
      await evaluateToolCall(platform, "fetch", fetchArgs("https://evil.example/")),
    ).toMatchObject({
      matchedRule: "platform_domain_rule",
    });

    const allowOnly = gatewayCtx({ rules: rules((r) => (r.domains.allowed = ["arxiv.org"])) });
    expect(
      (await evaluateToolCall(allowOnly, "fetch", fetchArgs("https://arxiv.org/abs/1"))).decision,
    ).toBe("allow");
    expect(
      (await evaluateToolCall(allowOnly, "fetch", fetchArgs("https://blog.example/"))).decision,
    ).toBe("deny");
  });

  it("enforces per-run limits and code approval", async () => {
    const fetchLimit = gatewayCtx({ toolCounts: { fetch: 10 } });
    expect(await evaluateToolCall(fetchLimit, "fetch", fetchArgs("https://a.org/"))).toMatchObject({
      matchedRule: "fetch_limit",
    });
    const codeLimit = gatewayCtx({ toolCounts: { run_code: 3 } });
    expect(
      await evaluateToolCall(codeLimit, "run_code", { purpose: "x", code: "1" }),
    ).toMatchObject({
      matchedRule: "code_limit",
    });
    const needsApproval = gatewayCtx({
      rules: rules((r) => (r.tools.run_code.requireApproval = true)),
    });
    expect(
      await evaluateToolCall(needsApproval, "run_code", { purpose: "x", code: "1" }),
    ).toMatchObject({
      decision: "require_approval",
      matchedRule: "code_requires_approval",
    });
  });

  it("asks for approval or denies when the run is out of budget, as the policy says", async () => {
    const spent = { steps: 60, tokens: 0, costUsd: 0 };
    expect(
      await evaluateToolCall(gatewayCtx({ usage: spent }), "search", {
        provider: "arxiv",
        query: "x",
        limit: 3,
      }),
    ).toMatchObject({
      decision: "require_approval",
      matchedRule: "budget",
    });
    const strict = gatewayCtx({ usage: spent, rules: rules((r) => (r.budget.onExceed = "fail")) });
    expect(
      await evaluateToolCall(strict, "search", { provider: "arxiv", query: "x", limit: 3 }),
    ).toMatchObject({
      decision: "deny",
      matchedRule: "budget",
    });
  });
});

describe("tool executor", () => {
  const executor = createToolExecutor({ db, logger: silentLogger });
  let runId: string;
  let execCtx: ExecutionContext;

  beforeEach(async () => {
    owner = await registerUser("owner@example.com");
    runId = await queueRun(owner);
    execCtx = {
      ...gatewayCtx(),
      runId,
      policy: await getActivePolicy(db, owner.organizationId),
    };
  });

  it("never runs a denied call, and records the call and the decision", async () => {
    const fn = vi.fn(async () => "fetched");
    const ctx = { ...execCtx, rules: rules((r) => (r.domains.blocked = ["spam.example"])) };
    const outcome = await executor.execute(ctx, "fetch", fetchArgs("https://spam.example/x"), fn, {
      stage: "acquiring",
    });

    expect(outcome).toMatchObject({ status: "denied", reason: "Domain spam.example is blocked" });
    expect(fn).not.toHaveBeenCalled();
    const [call] = await db.select().from(toolCalls).where(eq(toolCalls.runId, runId));
    expect(call).toMatchObject({ tool: "fetch", status: "denied", stage: "acquiring" });
    const [decision] = await db
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.toolCallId, call!.id));
    expect(decision).toMatchObject({
      decision: "deny",
      matchedRule: "domain_rule",
      policyVersion: 1,
    });
  });

  it("runs allowed calls once and returns the stored result when the same call repeats", async () => {
    const fn = vi.fn(async () => ({ hits: 3 }));
    const args = { provider: "arxiv", query: "agents", limit: 3 };
    const first = await executor.execute(execCtx, "search", args, fn, { stage: "discovering" });
    const again = await executor.execute(execCtx, "search", args, fn, { stage: "discovering" });

    expect(first).toMatchObject({ status: "succeeded", result: { hits: 3 }, cached: false });
    expect(again).toMatchObject({ status: "succeeded", result: { hits: 3 }, cached: true });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries transient failures, then records the failure", async () => {
    const fn = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const outcome = await executor.execute(
      execCtx,
      "search",
      { provider: "arxiv", query: "x", limit: 3 },
      fn,
      {
        stage: "discovering",
        retries: 2,
      },
    );
    expect(outcome).toMatchObject({ status: "failed", error: "HTTP 503" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("pauses for approval, then runs the call once approved (or denies it once rejected)", async () => {
    const ctx = { ...execCtx, rules: rules((r) => (r.tools.run_code.requireApproval = true)) };
    const fn = vi.fn(async () => ({ ok: true, result: 42 }));
    const args = { purpose: "Count sources", code: "42" };

    const error = await executor
      .execute(ctx, "run_code", args, fn, {
        stage: "analyzing",
        summary: "Run code: Count sources",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect(fn).not.toHaveBeenCalled();
    const [approval] = await db.select().from(approvals).where(eq(approvals.runId, runId));
    expect(approval).toMatchObject({
      kind: "tool_call",
      status: "pending",
      summary: "Run code: Count sources",
    });

    // Still pending: asking again keeps waiting.
    await expect(
      executor.execute(ctx, "run_code", args, fn, { stage: "analyzing" }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);

    await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval!.id));
    const outcome = await executor.execute(ctx, "run_code", args, fn, { stage: "analyzing" });
    expect(outcome).toMatchObject({ status: "succeeded", result: { ok: true, result: 42 } });
    expect(fn).toHaveBeenCalledOnce();
    const decisions = await db
      .select()
      .from(policyDecisions)
      .where(
        and(
          eq(policyDecisions.runId, runId),
          eq(policyDecisions.matchedRule, "approved_by_reviewer"),
        ),
      );
    expect(decisions).toHaveLength(1);

    // A different call that gets rejected comes back as denied.
    const other = { purpose: "Other", code: "1" };
    await executor.execute(ctx, "run_code", other, fn, { stage: "analyzing" }).catch(() => {});
    await db
      .update(approvals)
      .set({ status: "rejected", comment: "not needed" })
      .where(eq(approvals.status, "pending"));
    expect(
      await executor.execute(ctx, "run_code", other, fn, { stage: "analyzing" }),
    ).toMatchObject({
      status: "denied",
      reason: "Rejected by a reviewer: not needed",
    });
    expect(fn).toHaveBeenCalledOnce();
  });
});
