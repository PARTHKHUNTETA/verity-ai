import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import {
  approvals,
  policyDecisions,
  toolCalls,
  type Policy,
  type RunStage,
} from "../../infrastructure/database/schema/index.js";
import { short, withSpan } from "../observability/tracer.js";
import { evaluateToolCall, type GatewayContext } from "./policy-gateway.js";
import type { ToolName } from "./policy-rules.js";

/**
 * Approved execution (docs/system-design.md §4.8). The ONLY way agent tools run:
 *
 *   hash the call → seen before in this run? → ask the gateway → record tool call + decision →
 *   allow: run it (timeout, retries) · deny: return the reason · require_approval: pause the run
 *
 * "Seen before" makes resumed runs idempotent: a call that already succeeded returns its stored
 * result, and a call that was waiting for approval runs (approved) or is denied (rejected).
 */

export type ToolOutcome<T> =
  | { status: "succeeded"; result: T; cached: boolean; toolCallId: string }
  | { status: "denied"; reason: string; toolCallId: string }
  | { status: "failed"; error: string; toolCallId: string };

/** Thrown when a call needs a human decision; the runtime pauses the run. */
export class ApprovalRequiredError extends Error {
  /** Pausing for a human is intentional: traces show it as an interruption, not an error. */
  readonly traceAsOk = true;

  constructor(
    public readonly approvalId: string,
    public readonly summary: string,
  ) {
    super(`Waiting for approval: ${summary}`);
    this.name = "ApprovalRequiredError";
  }
}

export type ExecutionContext = GatewayContext & {
  runId: string;
  policy: Policy;
  signal?: AbortSignal;
  /** No person can approve (offline evaluation): "require approval" becomes "deny". */
  unattended?: boolean;
};

export type ExecuteOptions<T> = {
  stage: RunStage;
  /** One sentence for an approver ("Run code: count evidence per stance"). */
  summary?: string;
  timeoutMs?: number;
  /** Retries for transient failures. Only for idempotent tools. */
  retries?: number;
  /** What to store as the call's result (defaults to the full result, needed for reuse). */
  store?: (result: T) => unknown;
};

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Deterministic JSON (sorted keys), so the same arguments always hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashToolCall(tool: string, args: unknown): string {
  return createHash("sha256")
    .update(`${tool}:${stableStringify(args)}`)
    .digest("hex");
}

export function createToolExecutor({ db, logger }: { db: Database; logger: Logger }) {
  async function recordDecision(
    ctx: ExecutionContext,
    toolCallId: string,
    decision: {
      decision: "allow" | "deny" | "require_approval";
      matchedRule: string;
      reason: string;
      checks: unknown[];
    },
  ) {
    const [row] = await db
      .insert(policyDecisions)
      .values({
        organizationId: ctx.organizationId,
        runId: ctx.runId,
        toolCallId,
        policyId: ctx.policy.id,
        policyVersion: ctx.policy.version,
        decision: decision.decision,
        matchedRule: decision.matchedRule,
        reason: decision.reason,
        checks: decision.checks as Array<{ check: string; ok: boolean; detail?: string }>,
      })
      .returning({ id: policyDecisions.id });
    return row!.id;
  }

  async function run<T>(
    ctx: ExecutionContext,
    tool: ToolName,
    toolCallId: string,
    fn: () => Promise<T>,
    options: ExecuteOptions<T>,
  ): Promise<ToolOutcome<T>> {
    ctx.toolCounts[tool] = (ctx.toolCounts[tool] ?? 0) + 1;
    const started = Date.now();
    const attempts = 1 + (options.retries ?? 0);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await withTimeout(fn(), options.timeoutMs);
        await db
          .update(toolCalls)
          .set({
            status: "succeeded",
            result: (options.store ? options.store(result) : result) as never,
            error: null,
            durationMs: Date.now() - started,
          })
          .where(eq(toolCalls.id, toolCallId));
        return { status: "succeeded", result, cached: false, toolCallId };
      } catch (err) {
        lastError = err;
        if (ctx.signal?.aborted) break;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
    }
    if (ctx.signal?.aborted) throw lastError;
    const error = lastError instanceof Error ? lastError.message : String(lastError);
    await db
      .update(toolCalls)
      .set({ status: "failed", error, durationMs: Date.now() - started })
      .where(eq(toolCalls.id, toolCallId));
    logger.warn({ runId: ctx.runId, tool, error }, "Tool call failed");
    return { status: "failed", error, toolCallId };
  }

  async function executeInner<T>(
    ctx: ExecutionContext,
    tool: ToolName,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
    options: ExecuteOptions<T>,
  ): Promise<ToolOutcome<T>> {
    const argsHash = hashToolCall(tool, args);

    // Seen before in this run (a resumed run repeating its steps)?
    const [previous] = await db
      .select()
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, ctx.runId),
          eq(toolCalls.argsHash, argsHash),
          inArray(toolCalls.status, ["succeeded", "awaiting_approval"]),
        ),
      )
      .orderBy(desc(toolCalls.createdAt))
      .limit(1);
    if (previous?.status === "succeeded") {
      return {
        status: "succeeded",
        result: previous.result as T,
        cached: true,
        toolCallId: previous.id,
      };
    }
    if (previous?.status === "awaiting_approval") {
      const [approval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.toolCallId, previous.id))
        .orderBy(desc(approvals.createdAt))
        .limit(1);
      if (approval?.status === "pending")
        throw new ApprovalRequiredError(approval.id, approval.summary);
      if (approval?.status === "approved") {
        await recordDecision(ctx, previous.id, {
          decision: "allow",
          matchedRule: "approved_by_reviewer",
          reason: approval.comment ? `Approved: ${approval.comment}` : "Approved by a reviewer",
          checks: [{ check: "approval", ok: true }],
        });
        await db.update(toolCalls).set({ status: "running" }).where(eq(toolCalls.id, previous.id));
        return run(ctx, tool, previous.id, fn, options);
      }
      const reason =
        approval?.status === "rejected"
          ? `Rejected by a reviewer${approval.comment ? `: ${approval.comment}` : ""}`
          : "The approval request expired";
      await recordDecision(ctx, previous.id, {
        decision: "deny",
        matchedRule: approval?.status === "rejected" ? "rejected_by_reviewer" : "approval_expired",
        reason,
        checks: [{ check: "approval", ok: false }],
      });
      await db
        .update(toolCalls)
        .set({ status: "denied", error: reason })
        .where(eq(toolCalls.id, previous.id));
      return { status: "denied", reason, toolCallId: previous.id };
    }

    // New call: ask the gateway, and record the call and the decision either way.
    const evaluation = await withSpan("policy.check", { tool }, async (span) => {
      const checked = await evaluateToolCall(ctx, tool, args);
      const result =
        ctx.unattended && checked.decision === "require_approval"
          ? {
              ...checked,
              decision: "deny" as const,
              matchedRule: `${checked.matchedRule} (unattended run)`,
              reason: `${checked.reason}. Nobody can approve it during an unattended run, so it is denied.`,
            }
          : checked;
      span.setAttributes({
        decision: result.decision,
        rule: result.matchedRule,
        reason: short(result.reason),
      });
      return result;
    });
    const status =
      evaluation.decision === "allow"
        ? ("running" as const)
        : evaluation.decision === "deny"
          ? ("denied" as const)
          : ("awaiting_approval" as const);
    const [call] = await db
      .insert(toolCalls)
      .values({
        organizationId: ctx.organizationId,
        runId: ctx.runId,
        stage: options.stage,
        tool,
        args,
        argsHash,
        status,
        error: evaluation.decision === "deny" ? evaluation.reason : null,
      })
      .returning({ id: toolCalls.id });
    const decisionId = await recordDecision(ctx, call!.id, evaluation);

    if (evaluation.decision === "deny") {
      return { status: "denied", reason: evaluation.reason, toolCallId: call!.id };
    }
    if (evaluation.decision === "require_approval") {
      const summary = options.summary ?? `Run the ${tool} tool`;
      const [approval] = await db
        .insert(approvals)
        .values({
          organizationId: ctx.organizationId,
          runId: ctx.runId,
          kind: "tool_call",
          toolCallId: call!.id,
          policyDecisionId: decisionId,
          summary,
          details: { tool, args, reason: evaluation.reason },
          requestedBy: ctx.startedBy,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        })
        .returning({ id: approvals.id });
      throw new ApprovalRequiredError(approval!.id, summary);
    }
    return run(ctx, tool, call!.id, fn, options);
  }

  return {
    /** Runs one tool call through the gateway, as a "tool.<name>" span in the run's trace. */
    execute<T>(
      ctx: ExecutionContext,
      tool: ToolName,
      args: Record<string, unknown>,
      fn: () => Promise<T>,
      options: ExecuteOptions<T>,
    ): Promise<ToolOutcome<T>> {
      return withSpan(
        `tool.${tool}`,
        {
          tool,
          stage: options.stage,
          target: short(String(args.url ?? args.query ?? args.purpose ?? ""), 120),
        },
        async (span) => {
          const outcome = await executeInner(ctx, tool, args, fn, options);
          span.setAttributes({
            outcome: outcome.status,
            cached: outcome.status === "succeeded" ? outcome.cached : false,
            reason: outcome.status === "denied" ? short(outcome.reason) : undefined,
          });
          if (outcome.status === "failed") span.recordError(outcome.error);
          return outcome;
        },
      );
    },
  };
}

export type ToolExecutor = ReturnType<typeof createToolExecutor>;

async function withTimeout<T>(promise: Promise<T>, ms?: number): Promise<T> {
  if (!ms) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
