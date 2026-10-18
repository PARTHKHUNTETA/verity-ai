import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import {
  agentSteps,
  claimEvidence,
  claims,
  evidence,
  reports,
  researchRuns,
  researchTasks,
  type RunStage,
  type RunStatus,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import { calculateCostUsd, LlmError, type LlmClient } from "../../infrastructure/llm/index.js";
import type { SearchService } from "../retrieval/search.js";
import { extractClaims } from "./citations.js";
import { buildInput, INSTRUCTIONS } from "./prompts/answer-v1.js";

/**
 * Agent runtime v1 (Phase 5): retrieve → answer with citations.
 *   1. retrieving:   hybrid search over the run's collections; passages saved as evidence [1..k]
 *   2. synthesizing: one streamed LLM call that cites passages as [n]
 *   3. afterwards:   cited sentences become claims linked to their evidence
 * Phase 7 replaces this with the full stage machine (plan → … → evaluate), but the lifecycle
 * stays: claim the run → do work while publishing progress → record usage → finish.
 */

type RunConfig = { collectionIds?: string[]; topK?: number };

export type AgentRuntimeDeps = {
  db: Database;
  llm: LlmClient;
  search: SearchService;
  events: RunEventPublisher;
  logger: Logger;
  /** How often streamed text is sent to listeners, and saved to the DB. */
  publishIntervalMs?: number;
  persistIntervalMs?: number;
};

export function createAgentRuntime({
  db,
  llm,
  search,
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

  async function setStage(runId: string, stage: RunStage) {
    await db.update(researchRuns).set({ stage }).where(eq(researchRuns.id, runId));
    await events.publish({ type: "status", runId, status: "running", stage });
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
        .set({ status: "running", stage: "retrieving", startedAt: new Date() })
        .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "queued")))
        .returning();
      if (!run) {
        logger.info({ runId }, "Run is not queued anymore; skipping");
        return;
      }
      await events.publish({ type: "status", runId, status: "running", stage: "retrieving" });

      const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId));
      const config = run.config as RunConfig;

      // --- 1. Retrieve -------------------------------------------------------------------
      const retrievalStarted = Date.now();
      let passages: Awaited<ReturnType<SearchService["search"]>>;
      try {
        passages = await search.search(task!.question, {
          organizationId: run.organizationId,
          collectionIds: config.collectionIds ?? [],
          topK: config.topK ?? 8,
        });
      } catch (err) {
        logger.error({ err, runId }, "Retrieval failed");
        await setStatus(runId, "failed", {
          errorCode: "RETRIEVAL_FAILED",
          errorMessage: "Searching your sources failed",
          completedAt: new Date(),
        });
        return;
      }
      const evidenceRows = passages.length
        ? await db
            .insert(evidence)
            .values(
              passages.map((p, i) => ({
                organizationId: run.organizationId,
                runId,
                chunkId: p.chunkId,
                sourceId: p.sourceId,
                rank: i + 1,
                quote: p.content,
                score: p.score,
              })),
            )
            .returning({ id: evidence.id, rank: evidence.rank })
        : [];
      await db.insert(agentSteps).values({
        organizationId: run.organizationId,
        runId,
        seq: 1,
        stage: "retrieving",
        type: "tool_call",
        input: { tool: "rag", query: task!.question, collectionIds: config.collectionIds ?? [] },
        output: {
          hits: passages.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId, score: p.score })),
        },
        durationMs: Date.now() - retrievalStarted,
      });
      if (signal?.aborted) {
        await db
          .update(researchRuns)
          .set({ completedAt: new Date() })
          .where(eq(researchRuns.id, runId));
        return;
      }
      await setStage(runId, "synthesizing");

      // --- 2. Synthesize ------------------------------------------------------------------
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
          input: buildInput(
            task!.question,
            task!.instructions,
            passages.map((p, i) => ({
              number: i + 1,
              sourceTitle: p.sourceTitle,
              pageStart: p.pageStart,
              pageEnd: p.pageEnd,
              content: p.content,
            })),
          ),
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

        // --- 3. Claims: cited sentences, linked to the passages they cite ------------------
        const evidenceByNumber = new Map(evidenceRows.map((e) => [e.rank, e.id]));
        const { claims: extracted, invalidCitations } = extractClaims(
          result.text,
          new Set(evidenceByNumber.keys()),
        );

        await db.transaction(async (tx) => {
          await tx
            .update(reports)
            .set({ contentMd: result.text, status: "final" })
            .where(eq(reports.id, report!.id));
          if (extracted.length > 0) {
            const inserted = await tx
              .insert(claims)
              .values(
                extracted.map((c) => ({
                  organizationId: run.organizationId,
                  reportId: report!.id,
                  position: c.position,
                  section: c.section,
                  text: c.text,
                })),
              )
              .returning({ id: claims.id, position: claims.position });
            const idByPosition = new Map(inserted.map((c) => [c.position, c.id]));
            await tx.insert(claimEvidence).values(
              extracted.flatMap((c) =>
                c.citations.map((n) => ({
                  claimId: idByPosition.get(c.position)!,
                  evidenceId: evidenceByNumber.get(n)!,
                  citationNumber: n,
                })),
              ),
            );
          }
          await tx.insert(agentSteps).values({
            organizationId: run.organizationId,
            runId,
            seq: 2,
            stage: "synthesizing",
            type: "llm_call",
            input: {
              promptVersion: run.promptVersion,
              question: task!.question,
              passages: passages.length,
            },
            output: {
              characters: result.text.length,
              claims: extracted.length,
              // Numbers the model cited that it was never given: a hallucination signal.
              invalidCitations,
            },
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
              stepCount: 2,
              tokensInput: result.usage.inputTokens,
              tokensOutput: result.usage.outputTokens,
              costUsd,
              status: "completed",
              completedAt: new Date(),
            })
            .where(eq(researchRuns.id, runId));
        });
        await events.publish({ type: "status", runId, status: "completed", stage: "synthesizing" });
        logger.info(
          { runId, durationMs, costUsd, tokens: result.usage, claims: extracted.length },
          "Run completed",
        );
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
