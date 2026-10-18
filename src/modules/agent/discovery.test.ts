import { eq } from "drizzle-orm";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import {
  evidence,
  researchRuns,
  runSources,
  sources,
} from "../../infrastructure/database/schema/index.js";
import { createInMemoryRunEventBus } from "../../infrastructure/events/run-events.js";
import { createSafeFetcher } from "../../infrastructure/http/safe-fetch.js";
import { createFakeLlmClient } from "../../infrastructure/llm/index.js";
import {
  app,
  bearer,
  memoryStorage,
  registerUser,
  resetDatabase,
  testLlm,
  type TestSession,
} from "../../tests/helpers.js";
import { buildPdf } from "../../tests/pdf.js";
import { ARTICLE_HTML, startTestServer } from "../../tests/web-server.js";
import { createAcquisitionService } from "../retrieval/acquisition.js";
import { createIngestionService } from "../retrieval/ingestion.js";
import { createSearchService } from "../retrieval/search.js";
import { createFakeSearchProvider, type SearchResult } from "../tools/search.tool.js";
import { createAgentRuntime } from "./agent-runtime.js";
import { researchFakes } from "./fakes.js";

const logger = pino({ level: "silent" });
let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
  server = await startTestServer({
    "/blog/agents": (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(ARTICLE_HTML);
    },
    "/papers/survey.pdf": (_req, res) => {
      res.setHeader("Content-Type", "application/pdf");
      res.end(
        Buffer.from(
          buildPdf(
            [
              "Research agents search the web, fetch documents and cite evidence for every claim they make in a report.",
              "Benchmarks for research agents measure citation accuracy, claim support and source reliability across many questions.",
            ],
            { title: "A Survey of Research Agents" },
          ),
        ),
      );
    },
  });
});
afterAll(() => server.close());
beforeEach(resetDatabase);

const ABSTRACT =
  "This paper studies how research agents evaluate sources. We find that agents which verify citations against source passages produce more reliable reports, and we propose a benchmark for measuring claim support in generated research summaries.";

function candidates(): SearchResult[] {
  return [
    {
      url: server.url("/blog/agents"),
      title: "How Research Agents Work",
      snippet: "Research agents combine web search…",
      provider: "fake",
      kind: "web",
    },
    {
      url: "http://internal.test/admin", // resolves to a private IP: must be blocked
      title: "Internal admin",
      snippet: "",
      provider: "fake",
      kind: "web",
    },
    {
      url: server.url("/abs/survey", "papers.test"),
      title: "A Survey of Research Agents",
      snippet: "Survey abstract…",
      provider: "fake",
      kind: "paper",
      pdfUrl: server.url("/papers/survey.pdf", "papers.test"),
      authors: ["Ada Lovelace"],
      publishedAt: "2026-02-01",
    },
    {
      url: server.url("/paywalled", "journal.test"), // 404, but has a long abstract
      title: "Evaluating Research Agents",
      snippet: ABSTRACT,
      provider: "fake",
      kind: "paper",
    },
    {
      url: "https://spam.example/clickbait",
      title: "Clickbait",
      snippet: "",
      provider: "fake",
      kind: "web",
    },
  ];
}

function buildRuntime() {
  const fetcher = createSafeFetcher({
    maxBytes: 5 * 1024 * 1024,
    timeoutMs: 5000,
    allowAnyPort: true,
    resolve: async (host) => [
      { address: host === "internal.test" ? "10.0.0.7" : "127.0.0.1", family: 4 },
    ],
    isAllowedAddress: (address) => address === "127.0.0.1",
  });
  const ingestion = createIngestionService({
    db,
    llm: testLlm,
    storage: memoryStorage,
    embeddingModel: "fake-embedding",
    logger,
  });
  const acquisition = createAcquisitionService({
    db,
    fetcher,
    storage: memoryStorage,
    ingestion,
    logger,
  });
  return createAgentRuntime({
    db,
    llm: createFakeLlmClient({ ...researchFakes, delayMs: 0 }),
    search: createSearchService(db, testLlm, "fake-embedding"),
    events: createInMemoryRunEventBus(),
    logger,
    discovery: {
      providers: { web: createFakeSearchProvider(candidates(), "web"), academic: [] },
      acquisition,
      maxSources: 5,
    },
    // spam.example is blocked platform-wide; the gateway denies the fetch before it happens.
    platformDomains: { blocked: ["spam.example"], allowed: [] },
  });
}

async function startRun(owner: TestSession, question: string, discover = true) {
  const res = await request(app)
    .post("/api/v1/research/tasks")
    .set("Authorization", bearer(owner))
    .send({ question, discover });
  return res.body.run.id as string;
}

describe("discovery and acquisition", () => {
  it("finds, safely fetches, indexes and cites new sources", async () => {
    const owner = await registerUser("owner@example.com");
    const runId = await startRun(owner, "How do research agents cite evidence?");

    await buildRuntime().runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run!.status).toBe("completed");

    const discovered = await db
      .select()
      .from(runSources)
      .where(eq(runSources.runId, runId))
      .orderBy(runSources.rank);
    const byTitle = Object.fromEntries(discovered.map((d) => [d.title, d]));
    expect(byTitle["Internal admin"]).toMatchObject({ status: "blocked" });
    expect(byTitle["Internal admin"]!.reason).toMatch(/non-public address/);
    expect(byTitle["Clickbait"]).toMatchObject({
      status: "blocked",
      reason: "Policy: Domain spam.example is blocked",
    });
    expect(byTitle["Evaluating Research Agents"]!.reason).toMatch(/indexed the abstract/);
    // Sources that ended up cited are marked "used".
    expect(discovered.filter((d) => d.status === "used").length).toBeGreaterThan(0);
    for (const d of discovered.filter((d) => ["acquired", "used"].includes(d.status))) {
      expect(d.sourceId).not.toBeNull();
    }

    // The PDF and the HTML article were indexed as sources with metadata.
    const indexed = await db.select().from(sources);
    const survey = indexed.find((s) => s.title === "A Survey of Research Agents");
    expect(survey).toMatchObject({
      type: "paper",
      status: "ready",
      pageCount: 2,
      domain: "papers.test",
    });
    expect(survey!.authors).toEqual(["Ada Lovelace"]);
    const blog = indexed.find((s) => s.type === "web");
    expect(blog).toMatchObject({ status: "ready", mimeType: "text/html" });

    // Evidence includes passages from the fetched sources.
    const ev = await db.select().from(evidence).where(eq(evidence.runId, runId));
    expect(ev.length).toBeGreaterThan(0);

    // Fetched web sources are readable by org members (e.g. from a citation).
    const page = await request(app)
      .get(`/api/v1/sources/${blog!.id}`)
      .set("Authorization", bearer(owner));
    expect(page.status).toBe(200);

    // The run detail lists what was discovered.
    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    expect(detail.body.discovered).toHaveLength(5);
  });

  it("reuses already-indexed sources instead of downloading them again", async () => {
    const owner = await registerUser("owner@example.com");
    await buildRuntime().runResearch(
      await startRun(owner, "How do research agents cite evidence?"),
    );
    const hitsAfterFirst = server.hits.length;

    const secondRun = await startRun(owner, "What do benchmarks for research agents measure?");
    await buildRuntime().runResearch(secondRun);

    const rows = await db.select().from(runSources).where(eq(runSources.runId, secondRun));
    // The article, the PDF and the abstract-only paper were all indexed by the first run.
    expect(rows.filter((r) => r.reason === "Already indexed (cached)").length).toBe(3);
    expect(server.hits.slice(hitsAfterFirst)).toEqual([]); // nothing was downloaded again
    expect(await db.select().from(sources)).toHaveLength(3);
  });

  it("skips discovery when the run has it turned off", async () => {
    const owner = await registerUser("owner@example.com");
    const runId = await startRun(owner, "How do research agents cite evidence?", false);
    await buildRuntime().runResearch(runId);

    expect(await db.select().from(runSources).where(eq(runSources.runId, runId))).toHaveLength(0);
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run!.status).toBe("completed");
  });
});
