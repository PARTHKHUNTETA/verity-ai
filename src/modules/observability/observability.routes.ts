import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate, getAuth } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createMetricsService } from "./metrics.service.js";

/** GET /observability/metrics?days=7: the ops dashboard's numbers for the caller's organization. */
export function observabilityRoutes(db: Database): Router {
  const metrics = createMetricsService(db);
  const router = Router();
  router.use(authenticate(db));
  router.get(
    "/metrics",
    requirePermission("report:read"),
    validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }) }),
    async (req, res) => {
      const { days } = req.query as unknown as { days: number };
      res.json(await metrics.overview(getAuth(req).organizationId, days));
    },
  );
  return router;
}
