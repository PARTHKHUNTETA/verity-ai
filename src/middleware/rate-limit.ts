import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { TooManyRequestsError } from "../shared/errors.js";

/**
 * Rate limits. Counters are in memory: fine for one API process; a shared store (Postgres or
 * Redis) is needed once the API runs as several replicas. Disabled in tests so suites can make
 * many requests.
 *
 *   - per IP: auth endpoints (password guessing) and the whole API (floods);
 *   - per user: actions that cost money or CPU (research runs, eval runs, exports, uploads).
 */
function limiter(windowMinutes: number, limit: number, key?: (req: Request) => string) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    handler: (_req, _res, next) => next(new TooManyRequestsError()),
    ...(key && { keyGenerator: key }),
  });
}

/** Signed-in user if known, else the client IP (IPv6 addresses grouped per /56). */
const byUser = (req: Request) => req.auth?.userId ?? ipKeyGenerator(req.ip ?? "unknown");

/** Login and register: 10 attempts per 15 minutes per IP. */
export const credentialsRateLimit = limiter(15, 10);
/** Refresh and logout: 60 per 15 minutes per IP. */
export const sessionRateLimit = limiter(15, 60);
/** Everything under /api/v1: 600 requests per minute per IP (the UI polls a little). */
export const apiRateLimit = limiter(1, 600);

/** Starting research (each run calls the LLM many times): 30 per hour per user. */
export const researchRunRateLimit = limiter(60, 30, byUser);
/** Offline eval runs (each runs every case of a dataset): 10 per hour per user. */
export const evalRunRateLimit = limiter(60, 10, byUser);
/** Uploads (parsing + embedding): 60 per hour per user. */
export const uploadRateLimit = limiter(60, 60, byUser);
/** Report exports (PDF rendering is CPU-heavy): 30 per 5 minutes per user. */
export const exportRateLimit = limiter(5, 30, byUser);
