import { Router, type Request } from "express";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate, getAuth } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createFeedbackService, type FeedbackInput } from "./feedback.service.js";
import {
  caseParams,
  caseSchema,
  compareQuery,
  datasetParams,
  datasetSchema,
  evalRunParams,
  startEvalRunSchema,
  type CaseInput,
  type DatasetInput,
  type StartEvalRunInput,
} from "./offline/eval.schema.js";
import { createEvalService, type EvalServiceDeps } from "./offline/eval.service.js";

export const feedbackSchema = z.object({
  reportId: z.uuid(),
  claimId: z.uuid().nullish(),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  comment: z.string().trim().max(2000).nullish(),
});

/** POST /feedback: rate a report or one of its claims. Anyone who can read reports may rate. */
export function feedbackRoutes(db: Database): Router {
  const service = createFeedbackService(db);
  const router = Router();
  router.use(authenticate(db));
  router.post(
    "/",
    requirePermission("report:read"),
    validate({ body: feedbackSchema }),
    async (req, res) => {
      res.json(await service.rate(getAuth(req), req.body as FeedbackInput));
    },
  );
  return router;
}

/**
 * Offline evaluation (Phase 11): datasets and cases, eval runs, comparisons.
 * Reading results needs report:read; changing datasets or starting runs needs eval:manage.
 */
export function evalsRoutes(db: Database, deps: EvalServiceDeps): Router {
  const service = createEvalService(db, deps);
  const router = Router();
  router.use(authenticate(db));
  const read = requirePermission("report:read");
  const manage = requirePermission("eval:manage");
  type P<T> = Request<T>;

  router.get("/datasets", read, async (req, res) => {
    res.json({ datasets: await service.listDatasets(getAuth(req)) });
  });
  router.post("/datasets", manage, validate({ body: datasetSchema }), async (req, res) => {
    res.status(201).json(await service.createDataset(getAuth(req), req.body as DatasetInput));
  });
  router.post("/datasets/starter", manage, async (req, res) => {
    res.status(201).json(await service.installStarter(getAuth(req)));
  });
  router.get(
    "/datasets/:datasetId",
    read,
    validate({ params: datasetParams }),
    async (req: P<{ datasetId: string }>, res) => {
      res.json(await service.getDataset(getAuth(req), req.params.datasetId));
    },
  );
  router.put(
    "/datasets/:datasetId",
    manage,
    validate({ params: datasetParams, body: datasetSchema }),
    async (req: P<{ datasetId: string }>, res) => {
      res.json(
        await service.updateDataset(getAuth(req), req.params.datasetId, req.body as DatasetInput),
      );
    },
  );
  router.delete(
    "/datasets/:datasetId",
    manage,
    validate({ params: datasetParams }),
    async (req: P<{ datasetId: string }>, res) => {
      await service.deleteDataset(getAuth(req), req.params.datasetId);
      res.status(204).end();
    },
  );
  router.post(
    "/datasets/:datasetId/cases",
    manage,
    validate({ params: datasetParams, body: caseSchema }),
    async (req: P<{ datasetId: string }>, res) => {
      res
        .status(201)
        .json(await service.addCase(getAuth(req), req.params.datasetId, req.body as CaseInput));
    },
  );
  router.put(
    "/datasets/:datasetId/cases/:caseId",
    manage,
    validate({ params: caseParams, body: caseSchema }),
    async (req: P<{ datasetId: string; caseId: string }>, res) => {
      res.json(
        await service.updateCase(
          getAuth(req),
          req.params.datasetId,
          req.params.caseId,
          req.body as CaseInput,
        ),
      );
    },
  );
  router.delete(
    "/datasets/:datasetId/cases/:caseId",
    manage,
    validate({ params: caseParams }),
    async (req: P<{ datasetId: string; caseId: string }>, res) => {
      await service.deleteCase(getAuth(req), req.params.datasetId, req.params.caseId);
      res.status(204).end();
    },
  );

  router.get(
    "/runs",
    read,
    validate({ query: z.object({ datasetId: z.uuid().optional() }) }),
    async (req, res) => {
      const { datasetId } = req.query as { datasetId?: string };
      res.json({ runs: await service.listRuns(getAuth(req), datasetId) });
    },
  );
  router.post("/runs", manage, validate({ body: startEvalRunSchema }), async (req, res) => {
    res.status(201).json(await service.startRun(getAuth(req), req.body as StartEvalRunInput));
  });
  router.get(
    "/runs/:evalRunId",
    read,
    validate({ params: evalRunParams }),
    async (req: P<{ evalRunId: string }>, res) => {
      res.json(await service.getRun(getAuth(req), req.params.evalRunId));
    },
  );
  router.post(
    "/runs/:evalRunId/cancel",
    manage,
    validate({ params: evalRunParams }),
    async (req: P<{ evalRunId: string }>, res) => {
      res.json(await service.cancelRun(getAuth(req), req.params.evalRunId));
    },
  );
  router.get("/compare", read, validate({ query: compareQuery }), async (req, res) => {
    const { a, b } = req.query as { a: string; b: string };
    res.json(await service.compare(getAuth(req), a, b));
  });
  return router;
}
