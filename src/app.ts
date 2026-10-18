import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Database } from "./infrastructure/database/client.js";
import type { RunEventBus } from "./infrastructure/events/run-events.js";
import type { ResearchJobQueue } from "./infrastructure/queue/queue.js";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { organizationRoutes } from "./modules/organizations/organizations.routes.js";
import { researchRoutes } from "./modules/research/research.routes.js";

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
  api.use("/research", researchRoutes(deps.db, deps.research));
  // Later phases mount their module routers here, e.g. api.use("/research", researchRoutes(...)).
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
