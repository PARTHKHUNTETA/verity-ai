import { Router, type Request } from "express";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate, getAuth } from "../../middleware/authenticate.js";
import { exportRateLimit } from "../../middleware/rate-limit.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createReportsService } from "./reports.service.js";

const params = z.object({ reportId: z.uuid() });

/** GET /reports, /reports/:id, /reports/:id/export?format=md|pdf */
export function reportsRoutes(db: Database): Router {
  const service = createReportsService(db);
  const router = Router();
  router.use(authenticate(db));
  router.use(requirePermission("report:read"));

  router.get(
    "/",
    validate({
      query: z.object({
        q: z.string().trim().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    }),
    async (req, res) => {
      const query = req.query as unknown as { q?: string; limit: number };
      res.json({ reports: await service.list(getAuth(req), query) });
    },
  );
  router.get(
    "/:reportId",
    validate({ params }),
    async (req: Request<{ reportId: string }>, res) => {
      res.json(await service.get(getAuth(req), req.params.reportId));
    },
  );
  router.get(
    "/:reportId/export",
    exportRateLimit,
    validate({ params, query: z.object({ format: z.enum(["md", "pdf"]).default("md") }) }),
    async (req: Request<{ reportId: string }>, res) => {
      const { format } = req.query as { format: "md" | "pdf" };
      const file = await service.export(getAuth(req), req.params.reportId, format);
      res
        .type(file.contentType)
        .setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`)
        .setHeader("Cache-Control", "private, no-store")
        .send(file.body);
    },
  );
  return router;
}
