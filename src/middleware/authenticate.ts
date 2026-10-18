import type { Request, RequestHandler } from "express";
import type { DbExecutor } from "../infrastructure/database/client.js";
import type { AuthContext } from "../modules/auth/auth.types.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";
import { findMembership } from "../modules/organizations/members.repository.js";
import { UnauthorizedError } from "../shared/errors.js";

/**
 * Answers "who are you?". Verifies the Bearer access token, then loads the caller's membership
 * so the role is always current: a removed or demoted member loses access on the next request,
 * not when their token expires.
 */
export function authenticate(db: DbExecutor): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
    if (!token) throw new UnauthorizedError();

    let claims;
    try {
      claims = await verifyAccessToken(token);
    } catch {
      throw new UnauthorizedError("Invalid or expired access token");
    }

    const membership = await findMembership(db, claims.organizationId, claims.userId);
    if (!membership) throw new UnauthorizedError("You are no longer a member of this organization");

    req.auth = {
      userId: claims.userId,
      organizationId: claims.organizationId,
      role: membership.role,
    };
    next();
  };
}

/** For handlers behind `authenticate`: returns the auth context or fails loudly. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new UnauthorizedError();
  return req.auth;
}
