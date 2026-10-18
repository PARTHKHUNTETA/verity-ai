import { and, eq, gt, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  refreshTokens,
  type RefreshToken,
  type TokenRevokeReason,
} from "../../infrastructure/database/schema/index.js";

export async function insertRefreshToken(
  db: DbExecutor,
  values: Pick<RefreshToken, "userId" | "organizationId" | "tokenHash" | "familyId" | "expiresAt">,
): Promise<void> {
  await db.insert(refreshTokens).values(values);
}

export async function findRefreshTokenByHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<RefreshToken | undefined> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/**
 * Atomically "uses up" a token: revokes it only if it is still active and unexpired.
 * Returns the row when this call won; undefined if the token was already used, revoked or
 * expired. Doing check-and-revoke in one UPDATE means two concurrent refreshes with the same
 * token can't both succeed.
 */
export async function consumeRefreshToken(
  db: DbExecutor,
  tokenHash: string,
): Promise<RefreshToken | undefined> {
  const [row] = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: "rotated" })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .returning();
  return row;
}

/** Ends a whole login session (every token rotated from the same login). */
export async function revokeTokenFamily(
  db: DbExecutor,
  familyId: string,
  reason: TokenRevokeReason,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Signs a user out of one organization everywhere (used when they are removed from it). */
export async function revokeUserTokensForOrganization(
  db: DbExecutor,
  userId: string,
  organizationId: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), revokedReason: "member_removed" })
    .where(
      and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.organizationId, organizationId),
        isNull(refreshTokens.revokedAt),
      ),
    );
}
