import { asc, eq } from "drizzle-orm";
import { runSources, subQuestions } from "../../../infrastructure/database/schema/index.js";
import { canonicalizeUrl } from "../../retrieval/urls.js";
import type { SearchProvider, SearchResult } from "../../tools/search.tool.js";
import type { DiscoveryDeps, StageContext } from "./context.js";

const MAX_CANDIDATES = 24;

/**
 * Discovering: each sub-question's first search query goes to every provider. Providers run in
 * parallel; each provider handles its queries one after another (arXiv asks for ≤1 req/3 s).
 */
export async function discoverStage(ctx: StageContext, deps: DiscoveryDeps): Promise<void> {
  await ctx.db.delete(runSources).where(eq(runSources.runId, ctx.run.id)); // resume: start clean
  const started = Date.now();
  const sqs = await ctx.db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, ctx.run.id))
    .orderBy(asc(subQuestions.position));
  const queries = sqs.map((sq) => ({
    subQuestionId: sq.id,
    query: sq.searchQueries[0] ?? sq.text,
  }));

  const providers: Array<{ provider: SearchProvider; limit: number }> = [
    ...(deps.providers.web ? [{ provider: deps.providers.web, limit: 5 }] : []),
    ...deps.providers.academic.map((provider) => ({ provider, limit: 3 })),
  ];
  const errors: Array<{ provider: string; query: string; error: string }> = [];
  type Found = SearchResult & { subQuestionId: string; query: string };

  const perProvider = await Promise.all(
    providers.map(async ({ provider, limit }) => {
      const lists: Found[][] = [];
      for (const { subQuestionId, query } of queries) {
        ctx.checkCancelled();
        try {
          const results = await provider.search(query, { limit, signal: ctx.signal });
          lists.push(results.map((r) => ({ ...r, subQuestionId, query })));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          errors.push({ provider: provider.name, query, error });
          ctx.logger.warn({ runId: ctx.run.id, provider: provider.name, error }, "Search failed");
        }
      }
      return lists;
    }),
  );
  ctx.checkCancelled();

  // Round-robin over every (provider, sub-question) list so each sub-question gets candidates,
  // then drop duplicates by canonical URL.
  const lists = perProvider.flat();
  const seen = new Set<string>();
  const candidates: Found[] = [];
  for (let i = 0; candidates.length < MAX_CANDIDATES && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const result = list[i];
      if (!result || candidates.length >= MAX_CANDIDATES) continue;
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

  if (candidates.length) {
    await ctx.db.insert(runSources).values(
      candidates.map((c, i) => ({
        organizationId: ctx.run.organizationId,
        runId: ctx.run.id,
        subQuestionId: c.subQuestionId,
        url: c.url,
        pdfUrl: c.pdfUrl ?? null,
        metadata: { authors: c.authors, publishedAt: c.publishedAt, doi: c.doi },
        title: c.title.slice(0, 500),
        snippet: c.snippet.slice(0, 2000),
        provider: c.provider,
        discoveredVia: c.kind === "paper" ? "academic_search" : "web_search",
        query: c.query,
        rank: i + 1,
      })),
    );
  }

  await ctx.recordStep({
    stage: "discovering",
    type: "tool_call",
    input: {
      tool: "search",
      queries: queries.map((q) => q.query),
      providers: providers.map((p) => p.provider.name),
    },
    output: { candidates: candidates.length, errors },
    durationMs: Date.now() - started,
  });
}
