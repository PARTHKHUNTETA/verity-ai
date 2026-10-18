import type { CookieOptions, RequestHandler, Response } from "express";
import { env } from "../../config/env.js";
import { getAuth } from "../../middleware/authenticate.js";
import { requestMeta } from "../../shared/request-meta.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import type { AuthService, Session } from "./auth.service.js";

export const REFRESH_COOKIE = "verity_refresh";

/**
 * httpOnly: JavaScript can't read it, so an XSS bug can't steal it.
 * sameSite strict: the browser won't send it on requests started by other sites (CSRF).
 * path: only sent to /api/v1/auth, never to the rest of the API.
 */
const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/v1/auth",
};

function sendSession(res: Response, session: Session, status = 200) {
  const { refreshToken, refreshTokenExpiresAt, ...body } = session;
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...refreshCookieOptions,
    expires: refreshTokenExpiresAt,
  });
  // The refresh token goes only in the cookie, never in the JSON body.
  res.status(status).json({ tokenType: "Bearer", ...body });
}

function readRefreshCookie(cookies: unknown): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === "string" ? value : undefined;
}

export function createAuthController(service: AuthService) {
  const register: RequestHandler = async (req, res) => {
    sendSession(res, await service.register(req.body as RegisterInput, requestMeta(req)), 201);
  };

  const login: RequestHandler = async (req, res) => {
    sendSession(res, await service.login(req.body as LoginInput, requestMeta(req)));
  };

  const refresh: RequestHandler = async (req, res) => {
    try {
      sendSession(res, await service.refresh(readRefreshCookie(req.cookies), requestMeta(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
      throw err;
    }
  };

  const logout: RequestHandler = async (req, res) => {
    await service.logout(readRefreshCookie(req.cookies), requestMeta(req));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    res.status(204).end();
  };

  const me: RequestHandler = async (req, res) => {
    const { userId, organizationId } = getAuth(req);
    res.json(await service.me(userId, organizationId));
  };

  return { register, login, refresh, logout, me };
}
