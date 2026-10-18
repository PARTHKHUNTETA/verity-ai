import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { and, asc, eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { closeDatabase, db } from "../infrastructure/database/client.js";
import {
  evalDatasets,
  organizationMembers,
  organizations,
  users,
} from "../infrastructure/database/schema/index.js";
import { createInMemoryRunEventBus } from "../infrastructure/events/run-events.js";
import { createSafeFetcher } from "../infrastructure/http/safe-fetch.js";
import { chatModelFor, createLlmClient, embeddingModelFor } from "../infrastructure/llm/index.js";
import { createLocalFileStorage } from "../infrastructure/storage/file-storage.js";
import { createAgentRuntime } from "../modules/agent/agent-runtime.js";
import { researchFakes } from "../modules/agent/fakes.js";
import { createAuthService } from "../modules/auth/auth.service.js";
import type { AuthContext } from "../modules/auth/auth.types.js";
import type { EvalCaseCategory } from "../infrastructure/database/schema/index.js";
import { createEvalService } from "../modules/evaluation/offline/eval.service.js";
import { createEvalRunner } from "../modules/evaluation/offline/runner.js";
import { STARTER_DATASET_NAME } from "../modules/evaluation/offline/starter-dataset.js";
import { SUMMARY_METRICS } from "../modules/evaluation/offline/summary.js";
import { createTracer } from "../modules/observability/tracer.js";
import { createAcquisitionService } from "../modules/retrieval/acquisition.js";
import { createIngestionService } from "../modules/retrieval/ingestion.js";
import { createSearchService } from "../modules/retrieval/search.js";
import { parseDomainList } from "../modules/retrieval/urls.js";
import { discoveryProvidersFrom } from "../modules/tools/discovery.js";
import { logger } from "../shared/logger.js";

/**
 * Offline eval from the command line, for CI:
 *
 *   npm run eval -- --dataset ai-agents [--org my-org] [--name "prompt v2"] [--model gpt-5-mini]
 *                   [--top-k 4] [--no-revise] [--discovery] [--limit 5]
 *                   [--category red_team] [--min-pass-rate 0.8] [--baseline <evalRunId>]
 *                   [--install-starter] [--bootstrap]
 *
 * --bootstrap creates an "eval-ci" organization when the database has none (CI starts empty).
 *
 * Runs in this process (no worker or queue needed), prints the scorecard, and exits with
 * code 1 when the pass rate is below --min-pass-rate or a metric regressed against --baseline.
 */

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string", default: STARTER_DATASET_NAME },
    org: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    "top-k": { type: "string", default: "4" },
    "no-revise": { type: "boolean", default: false },
    discovery: { type: "boolean", default: false },
    limit: { type: "string" },
    category: { type: "string", multiple: true },
    bootstrap: { type: "boolean", default: false },
    "min-pass-rate": { type: "string", default: "0" },
    baseline: { type: "string" },
    "install-starter": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(`✕ ${message}`);
  process.exit(2);
}

/** Acts as the organization's first owner (evals need eval:manage). */
async function actor(): Promise<AuthContext> {
  const rows = await db
    .select({ orgId: organizations.id, slug: organizations.slug, userId: users.id })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.role, "owner"),
        args.org ? eq(organizations.slug, args.org) : undefined,
      ),
    )
    .orderBy(asc(organizationMembers.createdAt));
  const orgs = [...new Set(rows.map((r) => r.slug))];
  if (!rows.length && args.bootstrap && !args.org) {
    // An empty database (CI): create an organization and an owner with a throwaway password.
    console.log('Creating the "eval-ci" organization…');
    const session = await createAuthService(db).register(
      {
        email: "eval-ci@verity.local",
        password: randomBytes(24).toString("base64url"),
        organizationName: "eval-ci",
      },
      { ip: null, userAgent: "eval-cli" },
    );
    return { userId: session.user.id, organizationId: session.organization.id, role: "owner" };
  }
  if (!rows.length) fail(args.org ? `No organization "${args.org}"` : "No organizations yet");
  if (orgs.length > 1) fail(`Several organizations exist; pass --org (${orgs.join(", ")})`);
  return { userId: rows[0]!.userId, organizationId: rows[0]!.orgId, role: "owner" };
}

const llm = createLlmClient(env, researchFakes);
const embeddingModel = embeddingModelFor(env);
const storage = createLocalFileStorage(env.STORAGE_DIR);
const search = createSearchService(db, llm, embeddingModel);
const ingestion = createIngestionService({ db, llm, storage, embeddingModel, logger });
const events = createInMemoryRunEventBus();
const providers = discoveryProvidersFrom(env);
const tracer = createTracer({ db, logger });
const runtime = createAgentRuntime({
  db,
  llm,
  search,
  events,
  logger,
  tracer,
  discovery: {
    providers,
    acquisition: createAcquisitionService({
      db,
      fetcher: createSafeFetcher({
        maxBytes: env.FETCH_MAX_MB * 1024 * 1024,
        timeoutMs: env.FETCH_TIMEOUT_MS,
      }),
      storage,
      ingestion,
      logger,
    }),
    maxSources: env.MAX_SOURCES_PER_RUN,
  },
  platformDomains: {
    blocked: parseDomainList(env.BLOCKED_DOMAINS),
    allowed: parseDomainList(env.ALLOWED_DOMAINS),
  },
});
const service = createEvalService(db, {
  // The CLI executes the run itself, and ingests uploads inline instead of queueing them.
  queue: { enqueueEvalRun: async () => {} },
  events,
  model: chatModelFor(env),
  sources: {
    storage,
    search,
    queue: { enqueueSourceIngest: (id) => ingestion.ingestSource(id) },
  },
});
const runner = createEvalRunner({ db, runtime, llm, logger });

const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

try {
  const me = await actor();
  let [dataset] = await db
    .select()
    .from(evalDatasets)
    .where(
      and(eq(evalDatasets.organizationId, me.organizationId), eq(evalDatasets.name, args.dataset!)),
    );
  if (!dataset && args["install-starter"] && args.dataset === STARTER_DATASET_NAME) {
    console.log("Installing the starter dataset…");
    await service.installStarter(me);
    [dataset] = await db
      .select()
      .from(evalDatasets)
      .where(
        and(
          eq(evalDatasets.organizationId, me.organizationId),
          eq(evalDatasets.name, args.dataset!),
        ),
      );
  }
  if (!dataset) fail(`No dataset "${args.dataset}" (add --install-starter for the starter one)`);

  const run = await service.startRun(me, {
    datasetId: dataset.id,
    name: args.name ?? `CLI ${new Date().toISOString().slice(0, 16)}`,
    model: args.model,
    topK: Number(args["top-k"]),
    discovery: args.discovery!,
    revise: !args["no-revise"],
    limit: args.limit ? Number(args.limit) : null,
    categories: (args.category as EvalCaseCategory[] | undefined) ?? null,
  });
  console.log(`Eval run ${run.id} on "${dataset.name}" (model ${run.config.model})…`);
  const summary = await runner.execute(run.id);
  await tracer.flush();
  if (!summary) fail("The eval run did not complete (see the logs)");

  const detail = await service.getRun(me, run.id);
  console.log("\nCases");
  console.table(
    detail.results.map((r) => ({
      "#": r.position,
      category: r.category,
      passed: r.passed ? "✓" : "✕",
      question: r.question.length > 60 ? `${r.question.slice(0, 57)}…` : r.question,
      why: (r.failures.length
        ? r.failures
        : ((r.details.warnings as string[] | undefined) ?? []).map((w) => `note: ${w}`)
      )
        .join("; ")
        .slice(0, 80),
    })),
  );
  console.log("\nScorecard");
  console.table({
    "Pass rate": `${pct(summary.passRate)} (${summary.passed}/${summary.cases})`,
    ...Object.fromEntries(SUMMARY_METRICS.map((m) => [m.label, pct(summary.means[m.key])])),
    "Latency p50 / p95": `${summary.latencyMs.p50 ?? "—"} / ${summary.latencyMs.p95 ?? "—"} ms`,
    "Total cost": summary.totalCostUsd === null ? "unknown" : `$${summary.totalCostUsd}`,
  });

  let exitCode = 0;
  const minPassRate = Number(args["min-pass-rate"]);
  if (summary.passRate < minPassRate) {
    console.error(`✕ Pass rate ${pct(summary.passRate)} is below ${pct(minPassRate)}`);
    exitCode = 1;
  }
  if (args.baseline) {
    const comparison = await service.compare(me, args.baseline, run.id);
    console.log("\nAgainst the baseline");
    console.table(
      comparison.metrics.map((m) => ({
        metric: m.label,
        baseline: m.a,
        this: m.b,
        delta: m.delta,
        better: m.better === "b" ? "this" : m.better === "a" ? "baseline" : m.better,
      })),
    );
    const regressed = comparison.cases.filter((c) => c.change === "regressed");
    if (regressed.length) {
      console.error(
        `✕ ${regressed.length} case(s) regressed: ${regressed.map((c) => `#${c.position}`).join(", ")}`,
      );
      exitCode = 1;
    }
  }
  console.log(exitCode ? "\nEval FAILED" : "\nEval passed");
  await closeDatabase();
  process.exit(exitCode);
} catch (err) {
  logger.error({ err }, "Eval CLI failed");
  await closeDatabase();
  process.exit(2);
}
