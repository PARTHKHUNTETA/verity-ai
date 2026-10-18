import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/client.js";
import {
  evalCases,
  evalDatasets,
  evalResults,
  evalRuns,
  type EvalCase,
  type EvalConfig,
  type EvalDataset,
  type EvalRun,
} from "../../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../../infrastructure/events/run-events.js";
import type { EvalJobQueue } from "../../../infrastructure/queue/queue.js";
import { isUniqueViolation } from "../../../shared/db-errors.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../shared/errors.js";
import { PIPELINE_VERSION } from "../../agent/pipeline.js";
import { ANALYZE_PROMPT_VERSION } from "../../agent/prompts/analyze.js";
import { EXTRACT_PROMPT_VERSION } from "../../agent/prompts/extract.js";
import { PLAN_PROMPT_VERSION } from "../../agent/prompts/plan.js";
import { REPORT_PROMPT_VERSION, REVISION_PROMPT_VERSION } from "../../agent/prompts/report.js";
import type { AuthContext } from "../../auth/auth.types.js";
import { can } from "../../policies/permissions.js";
import { getActivePolicy } from "../../policies/policies.repository.js";
import { cancelRun } from "../../research/research.repository.js";
import { filterReadable, readableCollectionIds } from "../../sources/sources.repository.js";
import { createSourcesService, type SourcesDeps } from "../../sources/sources.service.js";
import { CLAIM_JUDGE_PROMPT_VERSION } from "../prompts/claim-judge.js";
import { POINTS_JUDGE_PROMPT_VERSION } from "../prompts/points-judge.js";
import { TASK_JUDGE_PROMPT_VERSION } from "../prompts/task-judge.js";
import type { CaseInput, DatasetInput, StartEvalRunInput } from "./eval.schema.js";
import { activeResearchRuns } from "./runner.js";
import { STARTER_CASES, STARTER_DATASET_NAME, STARTER_DOCUMENTS } from "./starter-dataset.js";
import { compareRuns } from "./summary.js";

/** Every prompt the pipeline and judges use, recorded on each eval run. */
export const PROMPT_VERSIONS = {
  plan: PLAN_PROMPT_VERSION,
  extract: EXTRACT_PROMPT_VERSION,
  analyze: ANALYZE_PROMPT_VERSION,
  report: REPORT_PROMPT_VERSION,
  revision: REVISION_PROMPT_VERSION,
  claimJudge: CLAIM_JUDGE_PROMPT_VERSION,
  taskJudge: TASK_JUDGE_PROMPT_VERSION,
  pointsJudge: POINTS_JUDGE_PROMPT_VERSION,
};

export type EvalServiceDeps = {
  queue: EvalJobQueue;
  events: RunEventPublisher;
  /** Default model for eval runs (the server's model). */
  model: string;
  sources: SourcesDeps;
};

const toDatasetDto = (d: EvalDataset) => ({
  id: d.id,
  name: d.name,
  description: d.description,
  collectionId: d.collectionId,
  createdBy: d.createdBy,
  createdAt: d.createdAt,
});

const toCaseDto = (c: EvalCase) => ({
  id: c.id,
  position: c.position,
  question: c.question,
  instructions: c.instructions,
  referenceAnswer: c.referenceAnswer,
  category: c.category,
  requiredPoints: c.requiredPoints,
  expectedSources: c.expectedSources,
  forbiddenSources: c.forbiddenSources,
  forbiddenContent: c.forbiddenContent,
  tags: c.tags,
});

const toRunDto = (r: EvalRun) => ({
  id: r.id,
  datasetId: r.datasetId,
  name: r.name,
  config: r.config,
  status: r.status,
  summary: r.summary,
  error: r.error,
  startedBy: r.startedBy,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
});

export function createEvalService(db: Database, deps: EvalServiceDeps) {
  async function dataset(actor: AuthContext, datasetId: string) {
    const [row] = await db
      .select()
      .from(evalDatasets)
      .where(
        and(eq(evalDatasets.id, datasetId), eq(evalDatasets.organizationId, actor.organizationId)),
      );
    if (!row) throw new NotFoundError("Dataset not found");
    return row;
  }

  async function evalRun(actor: AuthContext, evalRunId: string) {
    const [row] = await db
      .select()
      .from(evalRuns)
      .where(and(eq(evalRuns.id, evalRunId), eq(evalRuns.organizationId, actor.organizationId)));
    if (!row) throw new NotFoundError("Eval run not found");
    return row;
  }

  async function nextPosition(datasetId: string) {
    const [row] = await db
      .select({ last: max(evalCases.position) })
      .from(evalCases)
      .where(eq(evalCases.datasetId, datasetId));
    return (row?.last ?? 0) + 1;
  }

  async function insertDataset(actor: AuthContext, input: DatasetInput) {
    if (input.collectionId) {
      const [readable] = await filterReadable(db, actor, [input.collectionId]);
      if (!readable) throw new NotFoundError("Collection not found");
    }
    try {
      const [row] = await db
        .insert(evalDatasets)
        .values({
          organizationId: actor.organizationId,
          name: input.name,
          description: input.description ?? null,
          collectionId: input.collectionId ?? null,
          createdBy: actor.userId,
        })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(`A dataset named "${input.name}" exists`);
      throw err;
    }
  }

  /** Results of an eval run with each case's question, for the run page and comparisons. */
  async function results(evalRunId: string) {
    return db
      .select({
        id: evalResults.id,
        caseId: evalResults.caseId,
        position: evalCases.position,
        question: evalCases.question,
        category: evalCases.category,
        researchRunId: evalResults.researchRunId,
        scores: evalResults.scores,
        passed: evalResults.passed,
        failures: evalResults.failures,
        details: evalResults.details,
      })
      .from(evalResults)
      .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
      .where(eq(evalResults.evalRunId, evalRunId))
      .orderBy(asc(evalCases.position));
  }

  return {
    async listDatasets(actor: AuthContext) {
      const rows = await db
        .select({ dataset: evalDatasets, cases: count(evalCases.id) })
        .from(evalDatasets)
        .leftJoin(evalCases, eq(evalCases.datasetId, evalDatasets.id))
        .where(eq(evalDatasets.organizationId, actor.organizationId))
        .groupBy(evalDatasets.id)
        .orderBy(asc(evalDatasets.name));
      return rows.map((r) => ({ ...toDatasetDto(r.dataset), caseCount: r.cases }));
    },

    async createDataset(actor: AuthContext, input: DatasetInput) {
      return toDatasetDto(await insertDataset(actor, input));
    },

    async getDataset(actor: AuthContext, datasetId: string) {
      const row = await dataset(actor, datasetId);
      const cases = await db
        .select()
        .from(evalCases)
        .where(eq(evalCases.datasetId, datasetId))
        .orderBy(asc(evalCases.position), asc(evalCases.createdAt));
      return { ...toDatasetDto(row), cases: cases.map(toCaseDto) };
    },

    async updateDataset(actor: AuthContext, datasetId: string, input: DatasetInput) {
      await dataset(actor, datasetId);
      if (input.collectionId) {
        const [readable] = await filterReadable(db, actor, [input.collectionId]);
        if (!readable) throw new NotFoundError("Collection not found");
      }
      try {
        const [row] = await db
          .update(evalDatasets)
          .set({
            name: input.name,
            description: input.description ?? null,
            collectionId: input.collectionId ?? null,
          })
          .where(eq(evalDatasets.id, datasetId))
          .returning();
        return toDatasetDto(row!);
      } catch (err) {
        if (isUniqueViolation(err))
          throw new ConflictError(`A dataset named "${input.name}" exists`);
        throw err;
      }
    },

    async deleteDataset(actor: AuthContext, datasetId: string) {
      await dataset(actor, datasetId);
      const [running] = await db
        .select({ id: evalRuns.id })
        .from(evalRuns)
        .where(
          and(eq(evalRuns.datasetId, datasetId), inArray(evalRuns.status, ["queued", "running"])),
        )
        .limit(1);
      if (running) throw new ConflictError("An eval run on this dataset is still in progress");
      await db.delete(evalDatasets).where(eq(evalDatasets.id, datasetId));
    },

    async addCase(actor: AuthContext, datasetId: string, input: CaseInput) {
      await dataset(actor, datasetId);
      const [row] = await db
        .insert(evalCases)
        .values({
          organizationId: actor.organizationId,
          datasetId,
          position: await nextPosition(datasetId),
          ...input,
        })
        .returning();
      return toCaseDto(row!);
    },

    async updateCase(actor: AuthContext, datasetId: string, caseId: string, input: CaseInput) {
      await dataset(actor, datasetId);
      const [row] = await db
        .update(evalCases)
        .set(input)
        .where(and(eq(evalCases.id, caseId), eq(evalCases.datasetId, datasetId)))
        .returning();
      if (!row) throw new NotFoundError("Case not found");
      return toCaseDto(row);
    },

    async deleteCase(actor: AuthContext, datasetId: string, caseId: string) {
      await dataset(actor, datasetId);
      const deleted = await db
        .delete(evalCases)
        .where(and(eq(evalCases.id, caseId), eq(evalCases.datasetId, datasetId)))
        .returning({ id: evalCases.id });
      if (!deleted.length) throw new NotFoundError("Case not found");
    },

    /**
     * Installs the starter benchmark: a collection with the fixture documents (two of them
     * poisoned with prompt injections) and the 25 cases written against it.
     */
    async installStarter(actor: AuthContext) {
      const sources = createSourcesService(db, deps.sources);
      const collection = await sources.createCollection(actor, {
        name: `Eval fixtures: ${STARTER_DATASET_NAME}`,
        description:
          "Documents for the starter eval dataset. Two contain prompt injections on purpose: don't use them for real research.",
        visibility: can(actor.role, "collection:manage") ? "organization" : "private",
      });
      const created = await insertDataset(actor, {
        name: STARTER_DATASET_NAME,
        description:
          "Starter benchmark: 20 questions about AI agents, RAG, evaluation and safety, plus 5 prompt-injection (red-team) cases.",
        collectionId: collection.id,
      });
      for (const doc of STARTER_DOCUMENTS) {
        await sources.upload(actor, collection.id, {
          originalName: doc.fileName,
          buffer: Buffer.from(doc.content),
        });
      }
      await db.insert(evalCases).values(
        STARTER_CASES.map((c, i) => ({
          organizationId: actor.organizationId,
          datasetId: created.id,
          position: i + 1,
          question: c.question,
          instructions: c.instructions ?? null,
          category: c.category,
          requiredPoints: c.requiredPoints ?? [],
          expectedSources: c.expectedSources ?? [],
          forbiddenSources: c.forbiddenSources ?? [],
          forbiddenContent: c.forbiddenContent ?? [],
          tags: c.tags ?? [],
        })),
      );
      return { ...toDatasetDto(created), caseCount: STARTER_CASES.length };
    },

    /** Freezes the config (model, prompts, policy version, retrieval settings) and queues the run. */
    async startRun(actor: AuthContext, input: StartEvalRunInput) {
      const ds = await dataset(actor, input.datasetId);
      const [{ cases } = { cases: 0 }] = await db
        .select({ cases: count() })
        .from(evalCases)
        .where(eq(evalCases.datasetId, ds.id));
      if (!cases) throw new ValidationError("The dataset has no cases yet");

      const collectionIds = input.collectionIds
        ? await filterReadable(db, actor, input.collectionIds)
        : ds.collectionId
          ? await filterReadable(db, actor, [ds.collectionId])
          : await readableCollectionIds(db, actor);
      const policy = await getActivePolicy(db, actor.organizationId);
      const config: EvalConfig = {
        model: input.model ?? deps.model,
        pipelineVersion: PIPELINE_VERSION,
        promptVersions: PROMPT_VERSIONS,
        policyVersion: policy.version,
        topK: input.topK,
        discovery: input.discovery,
        revise: input.revise,
        collectionIds,
        categories: input.categories ?? null,
        limit: input.limit ?? null,
      };
      const [row] = await db
        .insert(evalRuns)
        .values({
          organizationId: actor.organizationId,
          datasetId: ds.id,
          name: input.name,
          config,
          startedBy: actor.userId,
        })
        .returning();
      try {
        await deps.queue.enqueueEvalRun(row!.id);
      } catch (err) {
        await db
          .update(evalRuns)
          .set({ status: "failed", error: "Could not queue the eval run" })
          .where(eq(evalRuns.id, row!.id));
        throw err;
      }
      return toRunDto(row!);
    },

    async listRuns(actor: AuthContext, datasetId?: string) {
      const rows = await db
        .select()
        .from(evalRuns)
        .where(
          and(
            eq(evalRuns.organizationId, actor.organizationId),
            datasetId ? eq(evalRuns.datasetId, datasetId) : undefined,
          ),
        )
        .orderBy(desc(evalRuns.createdAt))
        .limit(100);
      return rows.map(toRunDto);
    },

    async getRun(actor: AuthContext, evalRunId: string) {
      const row = await evalRun(actor, evalRunId);
      const [ds] = await db.select().from(evalDatasets).where(eq(evalDatasets.id, row.datasetId));
      const [{ total } = { total: 0 }] = await db
        .select({ total: count() })
        .from(evalCases)
        .where(
          and(
            eq(evalCases.datasetId, row.datasetId),
            row.config.categories?.length
              ? inArray(evalCases.category, row.config.categories)
              : undefined,
          ),
        );
      const list = await results(row.id);
      // The case being worked on right now, if any.
      const [current] = await activeResearchRuns(db, actor.organizationId, row.id);
      return {
        ...toRunDto(row),
        dataset: ds ? toDatasetDto(ds) : null,
        progress: { done: list.length, total: Math.min(total, row.config.limit ?? total) },
        currentResearchRunId: current?.id ?? null,
        results: list,
      };
    },

    /** Stops an eval run; the research run in flight is cancelled too. */
    async cancelRun(actor: AuthContext, evalRunId: string) {
      await evalRun(actor, evalRunId);
      const [row] = await db
        .update(evalRuns)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(and(eq(evalRuns.id, evalRunId), inArray(evalRuns.status, ["queued", "running"])))
        .returning();
      if (!row) throw new ConflictError("The eval run has already finished");
      for (const run of await activeResearchRuns(db, actor.organizationId, evalRunId)) {
        const cancelled = await cancelRun(db, actor.organizationId, run.id);
        if (cancelled) {
          await deps.events.publish({
            type: "status",
            runId: run.id,
            status: "cancelled",
            stage: cancelled.stage,
          });
        }
      }
      return toRunDto(row);
    },

    /** Two finished eval runs of the same dataset, metric by metric and case by case. */
    async compare(actor: AuthContext, aId: string, bId: string) {
      const [a, b] = await Promise.all([evalRun(actor, aId), evalRun(actor, bId)]);
      if (a.datasetId !== b.datasetId)
        throw new ValidationError("Only runs on the same dataset can be compared");
      if (!a.summary || !b.summary)
        throw new ValidationError("Both eval runs need to be finished before comparing");
      const [ra, rb] = await Promise.all([results(a.id), results(b.id)]);
      const comparison = compareRuns(
        { summary: a.summary, results: ra },
        { summary: b.summary, results: rb },
      );
      const question = new Map([...ra, ...rb].map((r) => [r.caseId, r]));
      return {
        a: toRunDto(a),
        b: toRunDto(b),
        metrics: comparison.metrics,
        cases: comparison.cases.map((c) => ({
          ...c,
          position: question.get(c.caseId)?.position ?? 0,
          question: question.get(c.caseId)?.question ?? "",
          category: question.get(c.caseId)?.category ?? "normal",
        })),
      };
    },
  };
}

export type EvalService = ReturnType<typeof createEvalService>;
