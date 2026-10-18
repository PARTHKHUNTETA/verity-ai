import { asc, eq } from "drizzle-orm";
import { runSources } from "../../../infrastructure/database/schema/index.js";
import type { AcquireResult } from "../../retrieval/acquisition.js";
import type { SearchResult } from "../../tools/search.tool.js";
import type { DiscoveryDeps, StageContext } from "./context.js";

const CONCURRENCY = 3;

/**
 * Acquiring: download, parse and index the best candidates, up to `maxSources`. Every fetch goes
 * through the policy gateway (domain rules, per-run fetch limit, budget); a denied candidate is
 * marked "blocked" with the policy's reason and the agent simply moves on to the next one.
 */
export async function acquireStage(ctx: StageContext, deps: DiscoveryDeps): Promise<void> {
  const started = Date.now();
  const rows = await ctx.db
    .select()
    .from(runSources)
    .where(eq(runSources.runId, ctx.run.id))
    .orderBy(asc(runSources.rank));

  const acquired = new Set<string>();
  const counts = { acquired: 0, reused: 0, rejected: 0, blocked: 0 };
  let next = 0;
  // If one download needs approval (or fails hard), the other workers must stop too.
  let stopError: unknown = null;

  const worker = async () => {
    while (
      next < rows.length &&
      acquired.size < deps.maxSources &&
      !ctx.signal.aborted &&
      !stopError
    ) {
      const row = rows[next++]!;
      const candidate: SearchResult = {
        url: row.url,
        title: row.title ?? row.url,
        snippet: row.snippet ?? "",
        provider: row.provider as SearchResult["provider"],
        kind: row.discoveredVia === "academic_search" ? "paper" : "web",
        pdfUrl: row.pdfUrl ?? undefined,
        authors: row.metadata.authors,
        publishedAt: row.metadata.publishedAt,
        doi: row.metadata.doi,
      };
      let result: AcquireResult;
      try {
        const outcome = await ctx.tools.call(
          "fetch",
          { url: candidate.url, pdfUrl: candidate.pdfUrl ?? null },
          () => deps.acquisition.acquire(ctx.run.organizationId, candidate, ctx.signal),
          { stage: "acquiring", summary: `Fetch ${candidate.url}`, timeoutMs: 120_000 },
        );
        result =
          outcome.status === "succeeded"
            ? outcome.result
            : outcome.status === "denied"
              ? { status: "blocked", reason: `Policy: ${outcome.reason}` }
              : { status: "rejected", reason: outcome.error };
      } catch (err) {
        stopError = err;
        return;
      }
      if (result.status === "acquired") {
        if (acquired.size >= deps.maxSources) continue; // another worker filled the quota
        acquired.add(result.sourceId);
        counts[result.reused ? "reused" : "acquired"]++;
      } else {
        counts[result.status]++;
      }
      await ctx.db
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
        .where(eq(runSources.id, row.id));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (stopError) throw stopError;
  ctx.checkCancelled();
  ctx.state.acquiredSourceIds = [...acquired];

  await ctx.recordStep({
    stage: "acquiring",
    type: "tool_call",
    input: { tool: "fetch", candidates: rows.length, maxSources: deps.maxSources },
    output: counts,
    durationMs: Date.now() - started,
  });
}
