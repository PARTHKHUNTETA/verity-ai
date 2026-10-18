import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Database } from "./infrastructure/database/client.js";
import type { RunEventBus } from "./infrastructure/events/run-events.js";
import type { LlmClient } from "./infrastructure/llm/index.js";
import type { IngestJobQueue, ResearchJobQueue } from "./infrastructure/queue/queue.js";
import type { FileStorage } from "./infrastructure/storage/file-storage.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { organizationRoutes } from "./modules/organizations/organizations.routes.js";
import { approvalsRoutes, policiesRoutes } from "./modules/policies/policies.routes.js";
import { researchRoutes } from "./modules/research/research.routes.js";
import { createSearchService } from "./modules/retrieval/search.js";
import { sourcesRoutes } from "./modules/sources/sources.routes.js";

/**
 * External dependencies the app needs. Passing them in (instead of importing them
 * inside modules) lets tests swap in fakes without a real database.
 */
export type AppDependencies = {
  db: Database;
  pingDatabase: () => Promise<void>;
  research: {
    queue: ResearchJobQueue;
    events: RunEventBus;
    /** Model name recorded on new runs. */
    model: string;
    capabilities: { webSearch: string | null; academicSearch: string[] };
  };
  knowledge: {
    storage: FileStorage;
    queue: IngestJobQueue;
    /** Used to embed search queries (the worker embeds documents). */
    llm: LlmClient;
    embeddingModel: string;
    maxUploadBytes: number;
  };
};

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Order matters: id first so every later log line and error response can include it.
  app.use(requestId);
  app.use(requestLogger);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  const api = express.Router();
  const { auth, me } = authRoutes(deps.db);
  api.use("/health", healthRoutes({ pingDatabase: deps.pingDatabase }));
  api.use("/auth", auth);
  api.use("/me", me);
  api.use("/organization", organizationRoutes(deps.db));
  const search = createSearchService(deps.db, deps.knowledge.llm, deps.knowledge.embeddingModel);
  api.use("/research", researchRoutes(deps.db, deps.research));
  api.use("/policies", policiesRoutes(deps.db));
  api.use("/approvals", approvalsRoutes(deps.db, deps.research));
  api.use(sourcesRoutes(deps.db, { ...deps.knowledge, search }));
  // Later phases mount their module routers here, e.g. api.use("/research", researchRoutes(...)).
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
