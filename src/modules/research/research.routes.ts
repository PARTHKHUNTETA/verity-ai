import { Router } from "express";
import type { Database } from "../../infrastructure/database/client.js";
import type { RunEventBus } from "../../infrastructure/events/run-events.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createResearchController } from "./research.controller.js";
import { createTaskSchema, runParamsSchema, taskParamsSchema } from "./research.schema.js";
import { createResearchService, type ResearchDeps } from "./research.service.js";
import { createRunStreamHandler } from "./research.sse.js";

export function researchRoutes(
  db: Database,
  deps: Omit<ResearchDeps, "events"> & { events: RunEventBus },
): Router {
  const service = createResearchService(db, deps);
  const controller = createResearchController(service);
  const router = Router();

  router.use(authenticate(db));

  router.get("/capabilities", requirePermission("report:read"), controller.capabilities);
  router.get("/tasks", requirePermission("report:read"), controller.listTasks);
  router.post(
    "/tasks",
    requirePermission("run:create"),
    validate({ body: createTaskSchema }),
    controller.createTask,
  );
  router.get(
    "/tasks/:taskId",
    requirePermission("report:read"),
    validate({ params: taskParamsSchema }),
    controller.getTask,
  );
  router.post(
    "/tasks/:taskId/runs",
    requirePermission("run:create"),
    validate({ params: taskParamsSchema }),
    controller.startRun,
  );
  router.get(
    "/runs/:runId/trace",
    requirePermission("report:read"),
    validate({ params: runParamsSchema }),
    controller.getTrace,
  );
  router.get(
    "/runs/:runId/scorecard",
    requirePermission("report:read"),
    validate({ params: runParamsSchema }),
    controller.getScorecard,
  );
  router.get(
    "/runs/:runId",
    requirePermission("report:read"),
    validate({ params: runParamsSchema }),
    controller.getRun,
  );
  router.get(
    "/runs/:runId/stream",
    requirePermission("report:read"),
    validate({ params: runParamsSchema }),
    createRunStreamHandler(service, deps.events),
  );
  router.post(
    "/runs/:runId/cancel",
    requirePermission("run:create"),
    validate({ params: runParamsSchema }),
    controller.cancelRun,
  );

  return router;
}
