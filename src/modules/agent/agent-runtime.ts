import { and, eq, gt } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  researchRuns,
  researchTasks,
  type RunStage,
  type RunStatus,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import { calculateCostUsd, LlmError, type LlmClient } from "../../infrastructure/llm/index.js";
import type { SearchService } from "../retrieval/search.js";
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
  publishIntervalMs?: number;
  persistIntervalMs?: number;
};

export type RunOptions = {
  /** Aborted when the user cancels (the API has already set status = cancelled). */
  signal?: AbortSignal;
  /** True when this is a retry of a job whose worker died: continue from the saved state. */
  resume?: boolean;
};

class RunCancelled extends Error {}
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
  publishIntervalMs = 100,
  persistIntervalMs = 1000,
}: AgentRuntimeDeps) {
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
      const budget: Budget = { ...DEFAULT_BUDGET, ...config.budget };

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
        llm,
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
      };

      const started = Date.now();
      try {
        for (const stage of stages) {
          if (state.completed.includes(stage)) continue;
          checkCancelled();
          await db.update(researchRuns).set({ stage }).where(eq(researchRuns.id, runId));
          await publishStatus(runId, "running", stage);
          await stageFns[stage]!(ctx);
          checkCancelled();
          state.completed.push(stage);
          await saveState(db, runId, state);
        }
        await db
          .update(researchRuns)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(researchRuns.id, runId));
        await publishStatus(runId, "completed", "synthesizing");
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
          logger.info({ runId }, "Run cancelled");
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
      }
    },
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
