import { Router } from "express";
import { z } from "zod";
import type { Database } from "../../infrastructure/database/client.js";
import { authenticate, getAuth } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createFeedbackService, type FeedbackInput } from "./feedback.service.js";

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
