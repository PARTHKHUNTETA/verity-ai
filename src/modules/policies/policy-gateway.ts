import type { DbExecutor } from "../../infrastructure/database/client.js";
import type {
  MemberRole,
  PolicyDecisionValue,
} from "../../infrastructure/database/schema/index.js";
import type { Budget } from "../agent/budget.js";
import { findMembership } from "../organizations/members.repository.js";
import { checkDomain, type DomainPolicy } from "../retrieval/urls.js";
import { filterReadable } from "../sources/sources.repository.js";
import { can } from "./permissions.js";
import { toolArgumentSchemas, type PolicyRules, type ToolName } from "./policy-rules.js";

/**
 * The policy gateway (docs/system-design.md §4.7): decides whether ONE proposed tool call may
 * run. The model only proposes; this trusted code decides. Checks run in order and the first
 * failing one decides:
 *
 *   1. tool        is the tool enabled in the org's policy?
 *   2. arguments   do the arguments match the tool's schema?
 *   3. permission  does the user who started the run (still) have the right to do this?
 *   4. rules       domain allow/blocklists, per-run limits, "code needs approval"
 *   5. budget      is the run within its step/token/cost budget?
 */

export type GatewayContext = {
  db: DbExecutor;
  organizationId: string;
  /** The user who started the run: the agent acts with their permissions. */
  startedBy: string | null;
  rules: PolicyRules;
  /** Platform-wide domain rules (env), applied on top of the org's policy. */
  platformDomains: DomainPolicy;
  budget: Budget;
  usage: { steps: number; tokens: number; costUsd: number | null };
  /** How many times each tool has already run in this run. */
  toolCounts: Partial<Record<ToolName, number>>;
};

export type Check = { check: string; ok: boolean; detail?: string };

export type Evaluation = {
  decision: PolicyDecisionValue;
  matchedRule: string;
  reason: string;
  checks: Check[];
};

export async function evaluateToolCall(
  ctx: GatewayContext,
  tool: string,
  args: unknown,
): Promise<Evaluation> {
  const checks: Check[] = [];
  const decide = (
    decision: PolicyDecisionValue,
    matchedRule: string,
    reason: string,
  ): Evaluation => ({
    decision,
    matchedRule,
    reason,
    checks,
  });

  // 1. Tool enabled?
  const schema = toolArgumentSchemas[tool as ToolName];
  const toolRules = ctx.rules.tools[tool as ToolName];
  if (!schema || !toolRules) {
    checks.push({ check: "tool", ok: false, detail: "unknown tool" });
    return decide("deny", "unknown_tool", `Unknown tool "${tool}"`);
  }
  if (!toolRules.enabled) {
    checks.push({ check: "tool", ok: false, detail: "disabled by policy" });
    return decide(
      "deny",
      "tool_disabled",
      `The ${tool} tool is disabled by your organization's policy`,
    );
  }
  checks.push({ check: "tool", ok: true });

  // 2. Arguments valid?
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "invalid";
    checks.push({ check: "arguments", ok: false, detail });
    return decide("deny", "invalid_arguments", `Invalid arguments for ${tool}: ${detail}`);
  }
  checks.push({ check: "arguments", ok: true });

  // 3. Permission: the agent acts as the user who started the run, with their current role.
  const membership = ctx.startedBy
    ? await findMembership(ctx.db, ctx.organizationId, ctx.startedBy)
    : undefined;
  if (!membership || !can(membership.role, "run:create")) {
    checks.push({
      check: "permission",
      ok: false,
      detail: membership ? `role ${membership.role}` : "not a member",
    });
    return decide(
      "deny",
      "permission",
      "The user who started this run is no longer allowed to run research",
    );
  }
  if (tool === "rag") {
    const { collectionIds } = parsed.data as { collectionIds: string[] };
    const actor = {
      userId: ctx.startedBy!,
      organizationId: ctx.organizationId,
      role: membership.role as MemberRole,
    };
    const readable = await filterReadable(ctx.db, actor, collectionIds);
    if (readable.length < collectionIds.length) {
      checks.push({ check: "permission", ok: false, detail: "collection access" });
      return decide(
        "deny",
        "collection_access",
        "The run may only search collections its user can read",
      );
    }
  }
  checks.push({ check: "permission", ok: true });

  // 4. Rules
  const count = ctx.toolCounts[tool as ToolName] ?? 0;
  if (tool === "fetch") {
    const { url, pdfUrl } = parsed.data as { url: string; pdfUrl: string | null };
    for (const [scope, policy] of [
      ["platform", ctx.platformDomains],
      ["organization", ctx.rules.domains],
    ] as const) {
      const reason = checkDomain(url, policy) ?? (pdfUrl ? checkDomain(pdfUrl, policy) : null);
      if (reason) {
        checks.push({ check: "rules", ok: false, detail: `${scope} domain rule` });
        return decide(
          "deny",
          scope === "platform" ? "platform_domain_rule" : "domain_rule",
          reason,
        );
      }
    }
    if (count >= ctx.rules.tools.fetch.maxPerRun) {
      checks.push({ check: "rules", ok: false, detail: "fetch limit" });
      return decide(
        "deny",
        "fetch_limit",
        `Fetch limit reached (${ctx.rules.tools.fetch.maxPerRun} per run)`,
      );
    }
  }
  if (tool === "run_code") {
    if (count >= ctx.rules.tools.run_code.maxPerRun) {
      checks.push({ check: "rules", ok: false, detail: "code run limit" });
      return decide(
        "deny",
        "code_limit",
        `Code run limit reached (${ctx.rules.tools.run_code.maxPerRun} per run)`,
      );
    }
    if (ctx.rules.tools.run_code.requireApproval) {
      checks.push({ check: "rules", ok: false, detail: "code requires approval" });
      return decide(
        "require_approval",
        "code_requires_approval",
        "Your organization requires approval before the agent runs code",
      );
    }
  }
  checks.push({ check: "rules", ok: true });

  // 5. Budget
  const { budget, usage } = ctx;
  const over =
    usage.steps >= budget.maxSteps
      ? `step limit (${budget.maxSteps})`
      : usage.tokens >= budget.maxTokens
        ? `token budget (${budget.maxTokens})`
        : usage.costUsd !== null && usage.costUsd >= budget.maxCostUsd
          ? `cost budget ($${budget.maxCostUsd})`
          : null;
  if (over) {
    checks.push({ check: "budget", ok: false, detail: over });
    return ctx.rules.budget.onExceed === "require_approval"
      ? decide("require_approval", "budget", `The run reached its ${over}`)
      : decide("deny", "budget", `The run reached its ${over}`);
  }
  checks.push({ check: "budget", ok: true });

  return decide("allow", "allowed", "All checks passed");
}
