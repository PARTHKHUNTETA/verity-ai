import { and, eq, inArray } from "drizzle-orm";
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
  runSources,
  type NewAgentStep,
  type ResearchRun,
  type ResearchTask,
  type RunStage,
  type RunStatus,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import { calculateCostUsd, LlmError, type LlmClient } from "../../infrastructure/llm/index.js";
import type { AcquisitionService } from "../retrieval/acquisition.js";
import type { SearchHit, SearchService } from "../retrieval/search.js";
import { canonicalizeUrl } from "../retrieval/urls.js";
import type { DiscoveryProviders, SearchResult } from "../tools/search.tool.js";
import { extractClaims } from "./citations.js";
import { buildInput, INSTRUCTIONS } from "./prompts/answer.js";

/**
 * Agent runtime v2 (Phase 6). A run moves through explicit stages:
 *
 *   discovering  web + academic search → candidates (run_sources)
 *   acquiring    fetch, parse and index the best candidates (safe fetcher)
 *   retrieving   hybrid search over the user's collections + acquired sources → evidence [1..k]
 *   synthesizing one streamed LLM call that cites passages; cited sentences become claims
 *
 * Discovery is skipped when the run has it turned off. Phase 7 replaces this fixed sequence
 * with an LLM-driven plan (sub-questions, tool calls), keeping the same lifecycle:
 * claim the run → work while publishing progress → record usage → finish.
 */

type RunConfig = { collectionIds?: string[]; topK?: number; discovery?: { enabled?: boolean } };

export type DiscoveryDeps = {
  providers: DiscoveryProviders;
  acquisition: AcquisitionService;
  /** How many documents to fetch and index per run. */
  maxSources: number;
};

export type AgentRuntimeDeps = {
  db: Database;
  llm: LlmClient;
  search: SearchService;
  events: RunEventPublisher;
  logger: Logger;
  discovery?: DiscoveryDeps;
  publishIntervalMs?: number;
  persistIntervalMs?: number;
};

const ACQUIRE_CONCURRENCY = 3;

/** Thrown between stages when the user cancelled; the API already set status = cancelled. */
class RunCancelled extends Error {}

export function createAgentRuntime({
  db,
  llm,
  search,
  events,
  logger,
  discovery,
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

  /** Per-run context shared by the stage functions. */
  type Ctx = {
    run: ResearchRun;
    task: ResearchTask;
    config: RunConfig;
    signal?: AbortSignal;
    nextSeq: () => number;
  };

  function checkCancelled(ctx: Ctx) {
    if (ctx.signal?.aborted) throw new RunCancelled();
  }

  async function recordStep(
    ctx: Ctx,
    step: Omit<NewAgentStep, "organizationId" | "runId" | "seq">,
  ) {
    await db.insert(agentSteps).values({
      organizationId: ctx.run.organizationId,
      runId: ctx.run.id,
      seq: ctx.nextSeq(),
      ...step,
    });
  }

  // --- Stage: discovering --------------------------------------------------------------
  async function discover(ctx: Ctx, deps: DiscoveryDeps) {
    const started = Date.now();
    const query = ctx.task.question;
    const providers = [
      ...(deps.providers.web ? [{ provider: deps.providers.web, limit: 5 }] : []),
      ...deps.providers.academic.map((provider) => ({ provider, limit: 4 })),
    ];
    const settled = await Promise.allSettled(
      providers.map(({ provider, limit }) => provider.search(query, { limit, signal: ctx.signal })),
    );
    checkCancelled(ctx);

    const errors: Array<{ provider: string; error: string }> = [];
    const lists: SearchResult[][] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") lists.push(result.value);
      else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ provider: providers[i]!.provider.name, error: reason });
        logger.warn(
          { runId: ctx.run.id, provider: providers[i]!.provider.name, reason },
          "Search provider failed",
        );
      }
    });

    // Interleave providers (web #1, arXiv #1, web #2, …) so no single source type dominates,
    // and drop duplicates (same canonical URL from two providers).
    const seen = new Set<string>();
    const candidates: SearchResult[] = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const list of lists) {
        const result = list[i];
        if (!result) continue;
        let key: string;
        try {
          key = canonicalizeUrl(result.url);
        } catch {
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(result);
      }
    }

    const rows = candidates.length
      ? await db
          .insert(runSources)
          .values(
            candidates.map((c, i) => ({
              organizationId: ctx.run.organizationId,
              runId: ctx.run.id,
              url: c.url,
              title: c.title.slice(0, 500),
              snippet: c.snippet.slice(0, 2000),
              provider: c.provider,
              discoveredVia: c.kind === "paper" ? "academic_search" : "web_search",
              query,
              rank: i + 1,
            })),
          )
          .returning({ id: runSources.id })
      : [];

    await recordStep(ctx, {
      stage: "discovering",
      type: "tool_call",
      input: { tool: "search", query, providers: providers.map((p) => p.provider.name) },
      output: { candidates: candidates.length, errors },
      durationMs: Date.now() - started,
    });
    return candidates.map((candidate, i) => ({ candidate, rowId: rows[i]!.id }));
  }

  // --- Stage: acquiring ----------------------------------------------------------------
  async function acquire(
    ctx: Ctx,
    deps: DiscoveryDeps,
    candidates: Array<{ candidate: SearchResult; rowId: string }>,
  ): Promise<string[]> {
    const started = Date.now();
    const acquired = new Set<string>();
    const counts = { acquired: 0, reused: 0, rejected: 0, blocked: 0 };
    let next = 0;

    // A small worker pool: up to 3 downloads at a time, stop once enough are indexed.
    const worker = async () => {
      while (next < candidates.length && acquired.size < deps.maxSources && !ctx.signal?.aborted) {
        const { candidate, rowId } = candidates[next++]!;
        const result = await deps.acquisition.acquire(
          ctx.run.organizationId,
          candidate,
          ctx.signal,
        );
        if (result.status === "acquired") {
          if (acquired.size >= deps.maxSources) continue; // another worker filled the quota
          acquired.add(result.sourceId);
          counts[result.reused ? "reused" : "acquired"]++;
        } else {
          counts[result.status]++;
        }
        await db
          .update(runSources)
          .set(
            result.status === "acquired"
              ? {
                  status: "acquired",
                  sourceId: result.sourceId,
                  reason: result.note ?? (result.reused ? "Already indexed (cached)" : null),
                }
              : { status: result.status, reason: result.reason },
          )
          .where(eq(runSources.id, rowId));
      }
    };
    await Promise.all(Array.from({ length: ACQUIRE_CONCURRENCY }, worker));
    checkCancelled(ctx);

    await recordStep(ctx, {
      stage: "acquiring",
      type: "tool_call",
      input: { tool: "fetch", candidates: candidates.length, maxSources: deps.maxSources },
      output: counts,
      durationMs: Date.now() - started,
    });
    return [...acquired];
  }

  // --- Stage: retrieving ---------------------------------------------------------------
  async function retrieve(ctx: Ctx, acquiredSourceIds: string[]) {
    const started = Date.now();
    const passages = await search.search(ctx.task.question, {
      organizationId: ctx.run.organizationId,
      collectionIds: ctx.config.collectionIds ?? [],
      sourceIds: acquiredSourceIds,
      topK: ctx.config.topK ?? 8,
    });
    const evidenceRows = passages.length
      ? await db
          .insert(evidence)
          .values(
            passages.map((p, i) => ({
              organizationId: ctx.run.organizationId,
              runId: ctx.run.id,
              chunkId: p.chunkId,
              sourceId: p.sourceId,
              rank: i + 1,
              quote: p.content,
              score: p.score,
            })),
          )
          .returning({ id: evidence.id, rank: evidence.rank, sourceId: evidence.sourceId })
      : [];
    await recordStep(ctx, {
      stage: "retrieving",
      type: "tool_call",
      input: {
        tool: "rag",
        query: ctx.task.question,
        collectionIds: ctx.config.collectionIds ?? [],
        acquiredSources: acquiredSourceIds.length,
      },
      output: {
        hits: passages.map((p) => ({ chunkId: p.chunkId, sourceId: p.sourceId, score: p.score })),
      },
      durationMs: Date.now() - started,
    });
    return { passages, evidenceRows };
  }

  // --- Stage: synthesizing -------------------------------------------------------------
  async function synthesize(
    ctx: Ctx,
    passages: SearchHit[],
    evidenceRows: Array<{ id: string; rank: number; sourceId: string }>,
  ) {
    const { run, task } = ctx;
    const [report] = await db
      .insert(reports)
      .values({ organizationId: run.organizationId, runId: run.id, version: 1 })
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
        await events.publish({ type: "delta", runId: run.id, offset, text });
      }
    };
    const persist = async () => {
      if (content.length > persisted) {
        persisted = content.length;
        await db.update(reports).set({ contentMd: content }).where(eq(reports.id, report!.id));
      }
    };
    const logError = (err: unknown) =>
      logger.warn({ err, runId: run.id }, "Progress update failed");
    const publishTimer = setInterval(() => void flush().catch(logError), publishIntervalMs);
    const persistTimer = setInterval(() => void persist().catch(logError), persistIntervalMs);
    const stopTimers = async () => {
      clearInterval(publishTimer);
      clearInterval(persistTimer);
      await flush().catch(logError);
    };

    const started = Date.now();
    let result;
    try {
      result = await llm.streamText({
        model: run.model,
        instructions: INSTRUCTIONS,
        input: buildInput(
          task.question,
          task.instructions,
          passages.map((p, i) => ({
            number: i + 1,
            sourceTitle: p.sourceTitle,
            origin: p.sourceDomain ?? "your documents",
            pageStart: p.pageStart,
            pageEnd: p.pageEnd,
            content: p.content,
          })),
        ),
        onDelta: (text) => {
          content += text;
        },
        signal: ctx.signal,
      });
    } catch (err) {
      await stopTimers();
      await persist().catch(logError);
      throw err;
    }
    await stopTimers();

    const costUsd = calculateCostUsd(result.model, result.usage);
    const evidenceByNumber = new Map(evidenceRows.map((e) => [e.rank, e]));
    const { claims: extracted, invalidCitations } = extractClaims(
      result.text,
      new Set(evidenceByNumber.keys()),
    );
    const citedSourceIds = [
      ...new Set(
        extracted.flatMap((c) => c.citations.map((n) => evidenceByNumber.get(n)!.sourceId)),
      ),
    ];

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
              evidenceId: evidenceByNumber.get(n)!.id,
              citationNumber: n,
            })),
          ),
        );
      }
      // Discovered sources that ended up cited.
      if (citedSourceIds.length > 0) {
        await tx
          .update(runSources)
          .set({ status: "used" })
          .where(and(eq(runSources.runId, run.id), inArray(runSources.sourceId, citedSourceIds)));
      }
      await tx.insert(agentSteps).values({
        organizationId: run.organizationId,
        runId: run.id,
        seq: ctx.nextSeq(),
        stage: "synthesizing",
        type: "llm_call",
        input: {
          promptVersion: run.promptVersion,
          question: task.question,
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
        durationMs: Date.now() - started,
      });
      await tx
        .update(researchRuns)
        .set({
          model: result.model,
          tokensInput: result.usage.inputTokens,
          tokensOutput: result.usage.outputTokens,
          costUsd,
          status: "completed",
          completedAt: new Date(),
        })
        .where(eq(researchRuns.id, run.id));
    });
    return { costUsd, usage: result.usage, claims: extracted.length };
  }

  return {
    /**
     * Executes one run. `signal` is aborted when the user cancels (the API has already set
     * status = cancelled in that case, so we must not overwrite it).
     */
    async runResearch(runId: string, signal?: AbortSignal): Promise<void> {
      const [queued] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
      const config = (queued?.config ?? {}) as RunConfig;
      const discoveryOn = Boolean(discovery && config.discovery?.enabled);
      const firstStage: RunStage = discoveryOn ? "discovering" : "retrieving";

      // Claim the run atomically: only a queued run starts (a run cancelled while still in the
      // queue, or a duplicate job, is skipped).
      const [run] = await db
        .update(researchRuns)
        .set({ status: "running", stage: firstStage, startedAt: new Date() })
        .where(and(eq(researchRuns.id, runId), eq(researchRuns.status, "queued")))
        .returning();
      if (!run) {
        logger.info({ runId }, "Run is not queued anymore; skipping");
        return;
      }
      await events.publish({ type: "status", runId, status: "running", stage: firstStage });

      const [task] = await db.select().from(researchTasks).where(eq(researchTasks.id, run.taskId));
      let seq = 0;
      const ctx: Ctx = { run, task: task!, config, signal, nextSeq: () => ++seq };
      const started = Date.now();

      try {
        let acquiredIds: string[] = [];
        if (discoveryOn && discovery) {
          const candidates = await discover(ctx, discovery);
          await setStage(runId, "acquiring");
          acquiredIds = await acquire(ctx, discovery, candidates);
          await setStage(runId, "retrieving");
        }
        const { passages, evidenceRows } = await retrieve(ctx, acquiredIds);
        checkCancelled(ctx);
        await setStage(runId, "synthesizing");
        const outcome = await synthesize(ctx, passages, evidenceRows);
        await db.update(researchRuns).set({ stepCount: seq }).where(eq(researchRuns.id, runId));
        await events.publish({ type: "status", runId, status: "completed", stage: "synthesizing" });
        logger.info({ runId, ms: Date.now() - started, ...outcome }, "Run completed");
      } catch (err) {
        if (signal?.aborted || err instanceof RunCancelled) {
          await db
            .update(researchRuns)
            .set({ completedAt: new Date(), stepCount: seq })
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
          stepCount: seq,
        });
      }
    },
  };
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
