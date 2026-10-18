import { Router } from "express";
import multer from "multer";
import type { Database } from "../../infrastructure/database/client.js";
import { uploadRateLimit } from "../../middleware/rate-limit.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { validate } from "../../middleware/validate.js";
import { createSourcesController } from "./sources.controller.js";
import {
  chunksQuerySchema,
  collectionParamsSchema,
  collectionSourceParamsSchema,
  createCollectionSchema,
  searchSchema,
  sourceParamsSchema,
} from "./sources.schema.js";
import { createSourcesService, type SourcesDeps } from "./sources.service.js";

/** Mounted at /api/v1 (routes: /collections…, /sources…, /search). */
export function sourcesRoutes(
  db: Database,
  deps: SourcesDeps & { maxUploadBytes: number },
): Router {
  const controller = createSourcesController(createSourcesService(db, deps));
  // Files are held in memory (≤ maxUploadBytes), hashed, then written to storage by the service.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxUploadBytes, files: 1 },
  });
  const router = Router();
  router.use(["/collections", "/sources", "/search"], authenticate(db));

  router.get("/collections", requirePermission("report:read"), controller.listCollections);
  router.post(
    "/collections",
    requirePermission("source:create"),
    validate({ body: createCollectionSchema }),
    controller.createCollection,
  );
  router.get(
    "/collections/:collectionId",
    requirePermission("report:read"),
    validate({ params: collectionParamsSchema }),
    controller.getCollection,
  );
  router.delete(
    "/collections/:collectionId",
    requirePermission("source:create"),
    validate({ params: collectionParamsSchema }),
    controller.deleteCollection,
  );
  router.post(
    "/collections/:collectionId/sources",
    requirePermission("source:create"),
    uploadRateLimit,
    validate({ params: collectionParamsSchema }),
    upload.single("file"),
    controller.upload,
  );
  router.delete(
    "/collections/:collectionId/sources/:sourceId",
    requirePermission("source:create"),
    validate({ params: collectionSourceParamsSchema }),
    controller.removeSource,
  );
  router.get(
    "/sources/:sourceId",
    requirePermission("report:read"),
    validate({ params: sourceParamsSchema }),
    controller.getSource,
  );
  router.get(
    "/sources/:sourceId/chunks",
    requirePermission("report:read"),
    validate({ params: sourceParamsSchema, query: chunksQuerySchema }),
    controller.listChunks,
  );
  router.post(
    "/search",
    requirePermission("report:read"),
    validate({ body: searchSchema }),
    controller.search,
  );

  return router;
}
