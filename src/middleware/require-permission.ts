import type { RequestHandler } from "express";
import { can, type Action } from "../modules/policies/permissions.js";
import { ForbiddenError } from "../shared/errors.js";
import { getAuth } from "./authenticate.js";

/**
 * Answers "are you allowed to do this?". Must run after `authenticate`.
 * Usage: router.post("/", requirePermission("member:manage"), controller.add)
 */
export function requirePermission(action: Action): RequestHandler {
  return (req, _res, next) => {
    const { role } = getAuth(req);
    if (!can(role, action)) {
      throw new ForbiddenError(`Your role (${role}) does not allow ${action}`);
    }
    next();
  };
}
