import { XMLParser } from "fast-xml-parser";

/**
 * Discovery: finding sources the user doesn't have yet (docs/system-design.md §3, stage 2).
 * Every provider returns the same SearchResult shape, so the rest of the pipeline doesn't care
 * where a result came from. These call fixed, well-known API hosts, so they use plain fetch;
 * the URLs *in* the results are untrusted and are only ever opened through the safe fetcher.
 */

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
  provider: "tavily" | "arxiv" | "semantic_scholar" | "fake";
  kind: "web" | "paper";
  /** A direct PDF link when the provider knows one (papers). */
  pdfUrl?: string;
  authors?: string[];
  publishedAt?: string;
  doi?: string;
};

export interface SearchProvider {
  readonly name: SearchResult["provider"];
  readonly kind: SearchResult["kind"];
  search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

const TIMEOUT_MS = 15_000;

function withTimeout(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Tavily: a web search API built for LLM agents (https://docs.tavily.com). */
export function createTavilyProvider(apiKey: string): SearchProvider {
  return {
    name: "tavily",
    kind: "web",
    async search(query, { limit, signal }) {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: query.slice(0, 400),
          max_results: limit,
          search_depth: "basic",
          include_published_date: true,
        }),
        signal: withTimeout(signal),
      });
      if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        results?: Array<{ url: string; title: string; content?: string; published_date?: string }>;
      };
      return (data.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        snippet: r.content ?? "",
        provider: "tavily" as const,
        kind: "web" as const,
        publishedAt: r.published_date,
      }));
    },
  };
}

// Common words, plus words that are typical of research *instructions* rather than topics.
const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from had has have how i if in into is it its " +
    "of on or our should so than that the their them then there these they this those to was we were what " +
    "when where which who why will with without would you your " +
    "about across analyze analysis approach approaches best cite compare comparison current describe " +
    "development developments different existing explain find gap gaps identify latest main major " +
    "new overview recent recently reliable research review source sources state study summarize " +
    "trend trends understand using versus vs"
  ).split(" "),
);

/**
 * Key terms of a natural-language question: drop stopwords, keep acronyms (AI, LLM, RAG),
 * which are short but carry most of the meaning.
 */
export function keywords(question: string, maxTerms = 4): string[] {
  const words = question
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return [
    ...new Set(
      words
        .filter(
          (w) => /^[A-Z]{2,6}s?$/.test(w) || (w.length > 2 && !STOPWORDS.has(w.toLowerCase())),
        )
        .map((w) => w.toLowerCase()),
    ),
  ].slice(0, maxTerms);
}

/** Turns a question into an arXiv query: all key terms must appear. */
export function arxivQuery(question: string, maxTerms = 4): string {
  return keywords(question, maxTerms)
    .map((t) => `all:${t}`)
    .join(" AND ");
}

/**
 * arXiv asks API users for at most one request every 3 seconds. Each call reserves the next
 * free slot, so concurrent runs in this process queue up politely.
 */
let nextArxivSlot = 0;
async function arxivThrottle() {
  const slot = Math.max(Date.now(), nextArxivSlot);
  nextArxivSlot = slot + 3000;
  if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
}

/** arXiv: free preprint server for CS, physics, math… (https://info.arxiv.org/help/api). */
export function createArxivProvider(): SearchProvider {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const asArray = <T>(v: T | T[] | undefined): T[] =>
    v === undefined ? [] : Array.isArray(v) ? v : [v];

  async function query(searchQuery: string, limit: number, signal?: AbortSignal) {
    await arxivThrottle();
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", searchQuery);
    url.searchParams.set("max_results", String(limit));
    url.searchParams.set("sortBy", "relevance");
    const res = await fetch(url, { signal: withTimeout(signal) });
    if (!res.ok) throw new Error(`arXiv search failed: HTTP ${res.status}`);
    type Entry = {
      id: string;
      title: string;
      summary: string;
      published?: string;
      author?: { name: string } | Array<{ name: string }>;
      link?:
        { "@_href": string; "@_title"?: string } | Array<{ "@_href": string; "@_title"?: string }>;
      "arxiv:doi"?: string;
    };
    const feed = parser.parse(await res.text()) as { feed?: { entry?: Entry | Entry[] } };
    return asArray(feed.feed?.entry).map((e) => ({
      url: String(e.id).replace(/^http:/, "https:"),
      title: String(e.title).replace(/\s+/g, " ").trim(),
      snippet: String(e.summary).replace(/\s+/g, " ").trim(),
      provider: "arxiv" as const,
      kind: "paper" as const,
      pdfUrl: asArray(e.link).find((l) => l["@_title"] === "pdf")?.["@_href"],
      authors: asArray(e.author).map((a) => a.name),
      publishedAt: e.published?.slice(0, 10),
      doi: e["arxiv:doi"],
    }));
  }

  return {
    name: "arxiv",
    kind: "paper",
    async search(question, { limit, signal }) {
      // All key terms first (precise); if that finds nothing, fewer terms (broader).
      const results = await query(arxivQuery(question), limit, signal);
      return results.length > 0 ? results : query(arxivQuery(question, 2), limit, signal);
    },
  };
}

/** Semantic Scholar: 200M+ papers with open-access PDF links (https://api.semanticscholar.org). */
export function createSemanticScholarProvider(apiKey?: string): SearchProvider {
  return {
    name: "semantic_scholar",
    kind: "paper",
    async search(question, { limit, signal }) {
      const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
      url.searchParams.set("query", question.slice(0, 300));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set(
        "fields",
        "title,abstract,url,authors,externalIds,openAccessPdf,publicationDate",
      );
      const res = await fetch(url, {
        headers: apiKey ? { "x-api-key": apiKey } : {},
        signal: withTimeout(signal),
      });
      if (!res.ok) throw new Error(`Semantic Scholar search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: Array<{
          url: string;
          title: string;
          abstract: string | null;
          authors?: Array<{ name: string }>;
          externalIds?: { DOI?: string; ArXiv?: string };
          openAccessPdf?: { url?: string } | null;
          publicationDate?: string | null;
        }>;
      };
      return (data.data ?? []).map((p) => ({
        // Prefer the arXiv page when the paper is on arXiv: it dedupes with arXiv results.
        url: p.externalIds?.ArXiv ? `https://arxiv.org/abs/${p.externalIds.ArXiv}` : p.url,
        title: p.title,
        snippet: p.abstract ?? "",
        provider: "semantic_scholar" as const,
        kind: "paper" as const,
        pdfUrl: p.openAccessPdf?.url || undefined,
        authors: p.authors?.map((a) => a.name),
        publishedAt: p.publicationDate ?? undefined,
        doi: p.externalIds?.DOI,
      }));
    },
  };
}

/** For tests and offline development: returns fixed results. */
export function createFakeSearchProvider(
  results: SearchResult[],
  kind: SearchResult["kind"] = "web",
): SearchProvider {
  return {
    name: "fake",
    kind,
    async search(_query, { limit }) {
      return results.slice(0, limit);
    },
  };
}

export type DiscoveryProviders = { web: SearchProvider | null; academic: SearchProvider[] };
