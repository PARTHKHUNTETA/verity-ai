import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../../config/env.js";

/**
 * Two kinds of tokens (docs/system-design.md §7):
 * - Access token: a short-lived JWT sent as `Authorization: Bearer ...`. Verified without a DB
 *   lookup, so it can't be revoked; that's why it lives only ~15 minutes.
 * - Refresh token: a long random string in an httpOnly cookie. Stored only as a hash and
 *   rotated on every use; used to get new access tokens.
 */

const ISSUER = "verity-ai";
const AUDIENCE = "verity-ai-api";
const secret = new TextEncoder().encode(env.JWT_SECRET);

export type AccessTokenClaims = { userId: string; organizationId: string };

export async function signAccessToken({ userId, organizationId }: AccessTokenClaims) {
  return new SignJWT({ org: organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/** Throws if the token is malformed, tampered with, expired, or issued for someone else. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string" || typeof payload.org !== "string") {
    throw new Error("Access token is missing required claims");
  }
  return { userId: payload.sub, organizationId: payload.org };
}

/** 256 bits of randomness, URL-safe. Only its hash is ever stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 is fine here (unlike for passwords) because the token is already high-entropy. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Calculate the expiry date for a refresh token based on the current date and the refresh token TTL. */
export function refreshTokenExpiry(from = new Date()): Date {
  return new Date(from.getTime() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
