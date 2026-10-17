import type { RequestHandler } from "express";
import type { HealthService } from "./health.service.js";

export function createHealthController(service: HealthService) {
  const getHealth: RequestHandler = async (_req, res) => {
    const health = await service.check();
    // 503 lets load balancers and Docker take an unhealthy instance out of rotation.
    res.status(health.status === "ok" ? 200 : 503).json(health);
  };

  return { getHealth };
}
