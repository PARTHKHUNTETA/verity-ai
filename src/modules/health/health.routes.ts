import { Router } from "express";
import { createHealthController } from "./health.controller.js";
import { createHealthService, type HealthDependencies } from "./health.service.js";

export function healthRoutes(deps: HealthDependencies): Router {
  const controller = createHealthController(createHealthService(deps));
  const router = Router();
  router.get("/", controller.getHealth);
  return router;
}
