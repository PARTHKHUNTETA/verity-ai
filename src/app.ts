import express, { type Express } from "express";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { requestId } from "./middleware/request-id.js";
import { requestLogger } from "./middleware/request-logger.js";
import { healthRoutes } from "./modules/health/health.routes.js";

/**
 * External dependencies the app needs. Passing them in (instead of importing them
 * inside modules) lets tests swap in fakes without a real database.
 */
export type AppDependencies = {
  pingDatabase: () => Promise<void>;
};

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Order matters: id first so every later log line and error response can include it.
  app.use(requestId);
  app.use(requestLogger);
  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();
  api.use("/health", healthRoutes({ pingDatabase: deps.pingDatabase }));
  // Later phases mount their module routers here, e.g. api.use("/research", researchRoutes(...)).
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
