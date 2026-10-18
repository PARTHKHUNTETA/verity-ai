import { and, count, eq, gt, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  approvals,
  researchRuns,
  researchTasks,
  toolCalls,
  type RunStage,
  type RunStatus,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import { calculateCostUsd, LlmError, type LlmClient } from "../../infrastructure/llm/index.js";
import { traceLlm } from "../observability/traced-llm.js";
import { createTracer, withSpan, type Tracer } from "../observability/tracer.js";
import { ApprovalRequiredError, createToolExecutor } from "../policies/executor.js";
import { getActivePolicy } from "../policies/policies.repository.js";
import { parseRules, type ToolName } from "../policies/policy-rules.js";
import type { SearchService } from "../retrieval/search.js";
import type { DomainPolicy } from "../retrieval/urls.js";
import { createCodeSandbox, type CodeSandbox } from "../tools/code.tool.js";
import { BudgetExceededError, checkBudget, DEFAULT_BUDGET, type Budget } from "./budget.js";
import { DISCOVERY_STAGES, PIPELINE_STAGES } from "./pipeline.js";
import { acquireStage } from "./stages/acquire.js";
import { analyzeStage } from "./stages/analyze.js";
import type { DiscoveryDeps, RunConfig, StageContext } from "./stages/context.js";
import { discoverStage } from "./stages/discover.js";
import { extractStage } from "./stages/extract.js";
import { planStage } from "./stages/plan.js";
import { retrieveStage } from "./stages/retrieve.js";
import { synthesizeStage } from "./stages/synthesize.js";
import { loadState, saveState } from "./state.js";

/**
 * Agent runtime v3 (Phase 7): runs the research pipeline as a stage machine.
 *
 *   planning → discovering → acquiring → retrieving → extracting → analyzing → synthesizing
 *
 * After every stage the run state is saved. If the worker dies, pg-boss notices the missing
 * heartbeat and retries the job; the retry resumes here, skipping completed stages.
 * Budgets (steps, tokens, cost, time) stop runaway runs.
 *
 * Phase 8: every tool call goes through the policy gateway (ctx.tools). When a call needs
 * approval, or a budget runs out under an "ask for approval" policy, the run pauses in
 * `awaiting_approval`; once a reviewer decides, the API re-queues it and it continues here.
 */

export type { DiscoveryDeps } from "./stages/context.js";

export type AgentRuntimeDeps = {
  db: Database;
  llm: LlmClient;
  search: SearchService;
  events: RunEventPublisher;
  logger: Logger;
  discovery?: DiscoveryDeps;
  sandbox?: CodeSandbox;
  /** Platform-wide domain rules (env), applied by the gateway on top of org policies. */
  platformDomains?: DomainPolicy;
  /** Records the run's trace (Phase 9). Defaults to a tracer writing to this database. */
  tracer?: Tracer;
  publishIntervalMs?: number;
  persistIntervalMs?: number;
};

const BUDGET_LABELS = { maxSteps: "steps", maxTokens: "tokens", maxCostUsd: "cost (USD)" } as const;

export type RunOptions = {
  /** Aborted when the user cancels (the API has already set status = cancelled). */
  signal?: AbortSignal;
  /** True when this is a retry of a job whose worker died: continue from the saved state. */
  resume?: boolean;
};

class RunCancelled extends Error {
  /** Cancelling is intentional: traces show it as an interruption, not an error. */
  readonly traceAsOk = true;
}
class RunTimedOut extends Error {}

type StageFn = (ctx: StageContext) => Promise<void>;

export function createAgentRuntime({
  db,
  llm,
  search,
  events,
  logger,
  discovery,
  sandbox = createCodeSandbox(),
  platformDomains = { blocked: [], allowed: [] },
  publishIntervalMs = 100,
  persistIntervalMs = 1000,
  tracer = createTracer({ db, logger }),
}: AgentRuntimeDeps) {
  const executor = createToolExecutor({ db, logger });
  // Every LLM call becomes a span with model, tokens and cost.
  const tracedLlm = traceLlm(llm);
  const stageFns: Record<RunStage, StageFn | null> = {
    planning: planStage,
    discovering: discovery ? (ctx) => discoverStage(ctx, discovery) : null,
    acquiring: discovery ? (ctx) => acquireStage(ctx, discovery) : null,
    retrieving: retrieveStage,
    extracting: extractStage,
    analyzing: analyzeStage,
    synthesizing: synthesizeStage,
    evaluating: null, // Phase 10
  };

  async function publishStatus(runId: string, status: RunStatus, stage: RunStage | null) {
    await events.publish({ type: "status", runId, status, stage });
  }

  return {
    async runResearch(runId: string, { signal: cancelSignal, resume = false }: RunOptions = {}) {
      const [existing] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
      if (!existing) return;
      const config = (existing.config ?? {}) as RunConfig;
      const discoveryOn = Boolean(discovery && config.discovery?.enabled);
      const stages = PIPELINE_STAGES.filter((s) => discoveryOn || !DISCOVERY_STAGES.includes(s));

      // Claim: a queued run starts; a running run continues only when resuming a retried job.
      let run = existing;
      if (existing.status === "queued") {
        const [claimed] = await db
          .update(researchRuns)
          .set({ status: "running", stage: stages[0]!, startedAt: new Date() })
          .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "queued")))
          .returning();
        if (!claimed) return;
        run = claimed;
      } else if (!(resume && existing.status === "running")) {
        logger.info({ runId, status: existing.status }, "Run is not runnable; skipping");
        return;
      } else {
        logger.info({ runId, completed: loadState(existing.state).completed }, "Resuming run");
      }

      const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId));
      const state = loadState(run.state);
      // Limits: platform defaults < the org's policy < this run's own config (e.g. an approved increase).
      const policy = await getActivePolicy(db, run.organizationId);
      const rules = parseRules(policy.rules);
      const budget: Budget = {
        ...DEFAULT_BUDGET,
        maxSteps: rules.budget.maxSteps,
        maxTokens: rules.budget.maxTokens,
        maxCostUsd: rules.budget.maxCostUsd,
        ...config.budget,
      };
      // Tool calls already executed in this run count towards per-run limits.
      const executed = await db
        .select({ tool: toolCalls.tool, n: count() })
        .from(toolCalls)
        .where(and(eq(toolCalls.runId, runId), inArray(toolCalls.status, ["succeeded", "running"])))
        .groupBy(toolCalls.tool);
      const toolCounts: Partial<Record<ToolName, number>> = Object.fromEntries(
        executed.map((r) => [r.tool, r.n]),
      );

      // Steps recorded after the last checkpoint belong to an interrupted stage: drop them.
      await db
        .delete(agentSteps)
        .where(and(eq(agentSteps.runId, runId), gt(agentSteps.seq, state.steps)));

      // The time budget counts from the original start, also across a resume.
      const elapsed = Date.now() - (run.startedAt?.getTime() ?? Date.now());
      const timeout = AbortSignal.timeout(Math.max(1, budget.timeoutMs - elapsed));
      const signal = cancelSignal ? AbortSignal.any([cancelSignal, timeout]) : timeout;
      const checkCancelled = () => {
        if (cancelSignal?.aborted) throw new RunCancelled();
        if (timeout.aborted) throw new RunTimedOut();
      };

      const ctx: StageContext = {
        db,
        llm: tracedLlm,
        search,
        events,
        logger,
        sandbox,
        discovery,
        run,
        task: task!,
        config,
        state,
        signal,
        publishIntervalMs,
        persistIntervalMs,
        async recordStep(step) {
          state.steps++;
          checkBudget(budget, { steps: state.steps, tokens: 0, costUsd: null });
          const [row] = await db
            .insert(agentSteps)
            .values({ organizationId: run.organizationId, runId, seq: state.steps, ...step })
            .returning({ id: agentSteps.id });
          return row!.id;
        },
        trackUsage(model, usage) {
          const cost = calculateCostUsd(model, usage);
          state.usage.inputTokens += usage.inputTokens;
          state.usage.outputTokens += usage.outputTokens;
          // Unknown price for any call makes the total unknown.
          state.usage.costUsd =
            cost === null || state.usage.costUsd === null ? null : state.usage.costUsd + cost;
          checkBudget(budget, {
            steps: state.steps,
            tokens: state.usage.inputTokens + state.usage.outputTokens,
            costUsd: state.usage.costUsd,
          });
          return cost;
        },
        checkCancelled,
        tools: {
          call: (tool, args, fn, options) =>
            executor.execute(
              {
                db,
                runId,
                organizationId: run.organizationId,
                startedBy: run.startedBy,
                policy,
                rules,
                platformDomains,
                budget,
                usage: {
                  steps: state.steps,
                  tokens: state.usage.inputTokens + state.usage.outputTokens,
                  costUsd: state.usage.costUsd,
                },
                toolCounts,
                signal,
              },
              tool,
              args,
              fn,
              options,
            ),
        },
      };

      /** Pauses the run until a reviewer decides; the API re-queues it afterwards. */
      const pauseForApproval = async (summary: string) => {
        const [paused] = await db
          .update(researchRuns)
          .set({ status: "awaiting_approval" })
          .where(eq(researchRuns.id, runId))
          .returning({ stage: researchRuns.stage });
        await publishStatus(runId, "awaiting_approval", paused?.stage ?? null);
        logger.info({ runId, summary }, "Run paused for approval");
      };

      // One trace per run (trace id = run id); each attempt (first try, resume) is a root "run" span.
      await tracer.inSpan(
        "run",
        {
          traceId: runId,
          organizationId: run.organizationId,
          attributes: {
            resumed: state.completed.length > 0,
            model: run.model,
            promptVersion: run.promptVersion,
            policyVersion: policy.version,
          },
        },
        async (root) => {
          const started = Date.now();
          try {
            for (const stage of stages) {
              if (state.completed.includes(stage)) continue;
              checkCancelled();
              await db.update(researchRuns).set({ stage }).where(eq(researchRuns.id, runId));
              await publishStatus(runId, "running", stage);
              await withSpan(`stage.${stage}`, { stage }, () => stageFns[stage]!(ctx));
              checkCancelled();
              state.completed.push(stage);
              await saveState(db, runId, state);
            }
            await db
              .update(researchRuns)
              .set({ status: "completed", completedAt: new Date() })
              .where(eq(researchRuns.id, runId));
            await publishStatus(runId, "completed", "synthesizing");
            root.setAttributes({ outcome: "completed", steps: state.steps, ...state.usage });
            logger.info(
              { runId, ms: Date.now() - started, usage: state.usage, steps: state.steps },
              "Run completed",
            );
          } catch (err) {
            await saveState(db, runId, state).catch(() => {});
            if (cancelSignal?.aborted || err instanceof RunCancelled) {
              await db
                .update(researchRuns)
                .set({ completedAt: new Date() })
                .where(eq(researchRuns.id, runId));
              root.setAttributes({ outcome: "cancelled" });
              logger.info({ runId }, "Run cancelled");
              return;
            }
            if (err instanceof ApprovalRequiredError) {
              root.setAttributes({ outcome: "awaiting_approval", approval: err.summary });
              await pauseForApproval(err.summary);
              return;
            }
            // Out of budget, and the policy says "ask": request more budget instead of failing.
            if (
              err instanceof BudgetExceededError &&
              err.limit !== "timeoutMs" &&
              rules.budget.onExceed === "require_approval"
            ) {
              const used =
                err.limit === "maxSteps"
                  ? state.steps
                  : err.limit === "maxTokens"
                    ? state.usage.inputTokens + state.usage.outputTokens
                    : (state.usage.costUsd ?? 0);
              const summary = `Allow more ${BUDGET_LABELS[err.limit]}: used ${used} of ${budget[err.limit]}`;
              await db.insert(approvals).values({
                organizationId: run.organizationId,
                runId,
                kind: "budget",
                summary,
                details: { limit: err.limit, max: budget[err.limit], used },
                requestedBy: run.startedBy,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              });
              root.setAttributes({ outcome: "awaiting_approval", approval: summary });
              await pauseForApproval(summary);
              return;
            }
            const [code, message] =
              err instanceof BudgetExceededError
                ? ["BUDGET_EXCEEDED", err.message]
                : timeout.aborted || err instanceof RunTimedOut
                  ? [
                      "TIMEOUT",
                      `The run took longer than ${Math.round(budget.timeoutMs / 60000)} minutes`,
                    ]
                  : err instanceof LlmError
                    ? [`LLM_${err.code}`.toUpperCase(), err.message]
                    : ["INTERNAL_ERROR", "The research run failed unexpectedly"];
            if (code === "INTERNAL_ERROR") logger.error({ err, runId }, "Run failed");
            else logger.warn({ runId, code, message }, "Run failed");
            const [failed] = await db
              .update(researchRuns)
              .set({
                status: "failed",
                errorCode: code,
                errorMessage: message,
                completedAt: new Date(),
              })
              .where(eq(researchRuns.id, runId))
              .returning({ stage: researchRuns.stage });
            await publishStatus(runId, "failed", failed?.stage ?? null);
            root.setAttributes({ outcome: "failed", errorCode: code });
            root.recordError(new Error(`${code}: ${message}`));
          }
        },
      );
      // Make the trace visible as soon as the attempt ends.
      await tracer.flush();
    },
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
