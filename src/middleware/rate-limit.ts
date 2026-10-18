import { rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { TooManyRequestsError } from "../shared/errors.js";

/**
 * Per-IP limits for auth endpoints, which attackers target for password guessing.
 * Counters are in memory: fine for one API process; a shared store is needed once we scale out.
 * Disabled in tests so suites can log in many times.
 */
function limiter(windowMinutes: number, limit: number) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => env.NODE_ENV === "test",
    handler: (_req, _res, next) => next(new TooManyRequestsError()),
  });
}

/** Login and register: 10 attempts per 15 minutes per IP. */
export const credentialsRateLimit = limiter(15, 10);
/** Refresh and logout: 60 per 15 minutes per IP. */
export const sessionRateLimit = limiter(15, 60);
