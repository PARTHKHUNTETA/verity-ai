import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  reports,
  researchRuns,
  researchTasks,
  type RunStatus,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import { calculateCostUsd, LlmError, type LlmClient } from "../../infrastructure/llm/index.js";
import { buildInput, INSTRUCTIONS } from "./prompts/answer-v0.js";

/**
 * Agent runtime v0 (Phase 4): one streamed LLM call per run.
 * Phase 7 replaces the single call with the full stage machine (plan → … → evaluate),
 * but the lifecycle here stays: claim the run → do work while publishing progress →
 * record usage → finish as completed / failed / cancelled.
 */

export type AgentRuntimeDeps = {
  db: Database;
  llm: LlmClient;
  events: RunEventPublisher;
  logger: Logger;
  /** How often streamed text is sent to listeners, and saved to the DB. */
  publishIntervalMs?: number;
  persistIntervalMs?: number;
};

export function createAgentRuntime({
  db,
  llm,
  events,
  logger,
  publishIntervalMs = 100,
  persistIntervalMs = 1000,
}: AgentRuntimeDeps) {
  async function setStatus(
    runId: string,
    status: RunStatus,
    extra: Partial<typeof researchRuns.$inferInsert> = {},
  ) {
    const [run] = await db
      .update(researchRuns)
      .set({ status, ...extra })
      .where(eq(researchRuns.id, runId))
      .returning({ stage: researchRuns.stage });
    await events.publish({ type: "status", runId, status, stage: run?.stage ?? null });
  }

  return {
    /**
     * Executes one run. `signal` is aborted when the user cancels (the API has already set
     * status = cancelled in that case, so we must not overwrite it).
     */
    async runResearch(runId: string, signal?: AbortSignal): Promise<void> {
      // Claim the run atomically: only a queued run starts. A run cancelled while still in the
      // queue (or a duplicate job) is skipped.
      const [run] = await db
        .update(researchRuns)
        .set({ status: "running", stage: "synthesizing", startedAt: new Date() })
        .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "queued")))
        .returning();
      if (!run) {
        logger.info({ runId }, "Run is not queued anymore; skipping");
        return;
      }
      await events.publish({ type: "status", runId, status: "running", stage: "synthesizing" });

      const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId));
      const [report] = await db
        .insert(reports)
        .values({ organizationId: run.organizationId, runId, version: 1 })
        .returning();

      // Streamed text is buffered and flushed on a timer: one event per ~100 ms instead of
      // one per token keeps NOTIFY traffic and React re-renders reasonable.
      let content = "";
      let published = 0;
      let persisted = 0;
      const flush = async () => {
        if (content.length > published) {
          const text = content.slice(published);
          const offset = published;
          published = content.length;
          await events.publish({ type: "delta", runId, offset, text });
        }
      };
      const persist = async () => {
        if (content.length > persisted) {
          persisted = content.length;
          await db.update(reports).set({ contentMd: content }).where(eq(reports.id, report!.id));
        }
      };
      const publishTimer = setInterval(() => void flush().catch(logError), publishIntervalMs);
      const persistTimer = setInterval(() => void persist().catch(logError), persistIntervalMs);
      function logError(err: unknown) {
        logger.warn({ err, runId }, "Progress update failed");
      }

      const started = Date.now();
      try {
        const result = await llm.streamText({
          model: run.model,
          instructions: INSTRUCTIONS,
          input: buildInput(task!.question, task!.instructions),
          onDelta: (text) => {
            content += text;
          },
          signal,
        });
        clearInterval(publishTimer);
        clearInterval(persistTimer);
        await flush();

        const costUsd = calculateCostUsd(result.model, result.usage);
        const durationMs = Date.now() - started;
        await db.transaction(async (tx) => {
          await tx
            .update(reports)
            .set({ contentMd: result.text, status: "final" })
            .where(eq(reports.id, report!.id));
          await tx.insert(agentSteps).values({
            organizationId: run.organizationId,
            runId,
            seq: 1,
            stage: "synthesizing",
            type: "llm_call",
            input: { promptVersion: run.promptVersion, question: task!.question },
            output: { characters: result.text.length },
            model: result.model,
            tokensInput: result.usage.inputTokens,
            tokensOutput: result.usage.outputTokens,
            costUsd,
            durationMs,
          });
          await tx
            .update(researchRuns)
            .set({
              model: result.model,
              stepCount: 1,
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              costUsd,
              status: "completed",
              completedAt: new Date(),
            })
            .where(eq(researchRuns.id, runId));
        });
        await events.publish({ type: "status", runId, status: "completed", stage: "synthesizing" });
        logger.info({ runId, durationMs, costUsd, tokens: result.usage }, "Run completed");
      } catch (err) {
        clearInterval(publishTimer);
        clearInterval(persistTimer);
        await flush().catch(logError);
        await persist().catch(logError);

        if (signal?.aborted) {
          // The API already marked the run cancelled; just record when it actually stopped.
          await db
            .update(researchRuns)
            .set({ completedAt: new Date() })
            .where(eq(researchRuns.id, runId));
          logger.info({ runId }, "Run cancelled");
          return;
        }
        const code = err instanceof LlmError ? `LLM_${err.code}`.toUpperCase() : "INTERNAL_ERROR";
        const message =
          err instanceof LlmError ? err.message : "The research run failed unexpectedly";
        logger.error({ err, runId }, "Run failed");
        await setStatus(runId, "failed", {
          errorCode: code,
          errorMessage: message,
          completedAt: new Date(),
        });
      }
    },
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
