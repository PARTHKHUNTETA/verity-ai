import { v7 as uuidv7 } from "uuid";
import { env } from "../../config/env.js";
import type { Database, DbExecutor } from "../../infrastructure/database/client.js";
import type { MemberRole, Organization, User } from "../../infrastructure/database/schema/index.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { ConflictError, ForbiddenError, UnauthorizedError } from "../../shared/errors.js";
import type { RequestMeta } from "../../shared/request-meta.js";
import { recordAudit } from "../audit/audit.repository.js";
import {
  addMember,
  findMembership,
  listMembershipsForUser,
} from "../organizations/members.repository.js";
import {
  createOrganization,
  findOrganizationById,
  slugExists,
} from "../organizations/organizations.repository.js";
import { actions, can } from "../policies/permissions.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password.js";
import {
  consumeRefreshToken,
  findRefreshTokenByHash,
  insertRefreshToken,
  revokeTokenFamily,
} from "./refresh-tokens.repository.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from "./tokens.js";
import { createUser, findUserByEmail, findUserById, touchLastLogin } from "./users.repository.js";

/** What the controller needs to answer a successful register/login/refresh. */
export type Session = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: Pick<User, "id" | "email" | "name">;
  organization: Pick<Organization, "id" | "name" | "slug">;
  role: MemberRole;
};

const invalidCredentials = () => new UnauthorizedError("Invalid email or password");

export function createAuthService(db: Database) {
  /** Creates a refresh token (new family on login, same family on rotation) + an access token. */
  async function issueSession(
    tx: DbExecutor,
    user: User,
    organization: Organization,
    role: MemberRole,
    familyId: string = uuidv7(),
  ): Promise<Session> {
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = refreshTokenExpiry();
    await insertRefreshToken(tx, {
      userId: user.id,
      organizationId: organization.id,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      expiresAt: refreshTokenExpiresAt,
    });
    return {
      accessToken: await signAccessToken({ userId: user.id, organizationId: organization.id }),
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt,
      user: { id: user.id, email: user.email, name: user.name },
      organization: { id: organization.id, name: organization.name, slug: organization.slug },
      role,
    };
  }

  async function uniqueSlug(tx: DbExecutor, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "org";
    if (!(await slugExists(tx, base))) return base;
    return `${base}-${uuidv7().slice(-6)}`;
  }

  return {
    /** Creates a user, their organization and an owner membership, all or nothing. */
    async register(input: RegisterInput, meta: RequestMeta): Promise<Session> {
      // Hash before opening the transaction: hashing is slow and shouldn't hold a DB connection.
      const passwordHash = await hashPassword(input.password);
      try {
        return await db.transaction(async (tx) => {
          if (await findUserByEmail(tx, input.email)) {
            throw new ConflictError("An account with this email already exists");
          }
          const user = await createUser(tx, { email: input.email, passwordHash, name: input.name });
          const organization = await createOrganization(tx, {
            name: input.organizationName,
            slug: await uniqueSlug(tx, input.organizationName),
          });
          await addMember(tx, { organizationId: organization.id, userId: user.id, role: "owner" });
          await recordAudit(tx, {
            organizationId: organization.id,
            actorUserId: user.id,
            action: "auth.register",
            resourceType: "user",
            resourceId: user.id,
            meta,
          });
          return issueSession(tx, user, organization, "owner");
        });
      } catch (err) {
        // Two simultaneous sign-ups with one email: the unique constraint decides the winner.
        if (isUniqueViolation(err))
          throw new ConflictError("An account with this email already exists");
        throw err;
      }
    },

    async login(input: LoginInput, meta: RequestMeta): Promise<Session> {
      const user = await findUserByEmail(db, input.email);
      const passwordOk = user
        ? await verifyPassword(user.passwordHash, input.password)
        : await verifyAgainstDummy(input.password);

      if (!user || !passwordOk) {
        await recordAudit(db, {
          actorUserId: user?.id,
          action: "auth.login_failed",
          metadata: { email: input.email },
          meta,
        });
        throw invalidCredentials();
      }

      const memberships = await listMembershipsForUser(db, user.id);
      const chosen = input.organizationId
        ? memberships.find((m) => m.organizationId === input.organizationId)
        : memberships[0];
      if (!chosen) {
        throw new ForbiddenError(
          input.organizationId
            ? "You are not a member of that organization"
            : "You are not a member of any organization",
        );
      }

      const organization = (await findOrganizationById(db, chosen.organizationId))!;
      await touchLastLogin(db, user.id);
      await recordAudit(db, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "auth.login",
        meta,
      });
      return issueSession(db, user, organization, chosen.role);
    },

    /**
     * Rotation: every refresh token works exactly once and is replaced by a new one.
     * If a token that was already rotated shows up again, someone copied it (the real client
     * already moved on to its replacement), so the whole session family is revoked and everyone
     * must log in again. Tokens revoked for other reasons (logout, removal) just fail with 401.
     */
    async refresh(refreshToken: string | undefined, meta: RequestMeta): Promise<Session> {
      if (!refreshToken) throw new UnauthorizedError("No refresh token");
      const tokenHash = hashRefreshToken(refreshToken);

      const consumed = await consumeRefreshToken(db, tokenHash);
      if (!consumed) {
        const existing = await findRefreshTokenByHash(db, tokenHash);
        if (existing?.revokedReason === "rotated") {
          await revokeTokenFamily(db, existing.familyId, "reuse_detected");
          await recordAudit(db, {
            organizationId: existing.organizationId,
            actorUserId: existing.userId,
            action: "auth.refresh_reuse_detected",
            metadata: { familyId: existing.familyId },
            meta,
          });
        }
        throw new UnauthorizedError("Session expired, please log in again");
      }

      const [user, organization, membership] = await Promise.all([
        findUserById(db, consumed.userId),
        findOrganizationById(db, consumed.organizationId),
        findMembership(db, consumed.organizationId, consumed.userId),
      ]);
      if (!user || !organization || !membership) {
        await revokeTokenFamily(db, consumed.familyId, "session_invalid");
        throw new UnauthorizedError("Session expired, please log in again");
      }
      return issueSession(db, user, organization, membership.role, consumed.familyId);
    },

    /** Ends the session family of the presented token. Always succeeds (idempotent). */
    async logout(refreshToken: string | undefined, meta: RequestMeta): Promise<void> {
      if (!refreshToken) return;
      const existing = await findRefreshTokenByHash(db, hashRefreshToken(refreshToken));
      if (!existing) return;
      await revokeTokenFamily(db, existing.familyId, "logout");
      await recordAudit(db, {
        organizationId: existing.organizationId,
        actorUserId: existing.userId,
        action: "auth.logout",
        meta,
      });
    },

    /** The signed-in user, current organization, role, allowed actions and other memberships. */
    async me(userId: string, organizationId: string) {
      const [user, organization, memberships] = await Promise.all([
        findUserById(db, userId),
        findOrganizationById(db, organizationId),
        listMembershipsForUser(db, userId),
      ]);
      const current = memberships.find((m) => m.organizationId === organizationId);
      if (!user || !organization || !current) throw new UnauthorizedError();
      return {
        user: { id: user.id, email: user.email, name: user.name, lastLoginAt: user.lastLoginAt },
        organization: { id: organization.id, name: organization.name, slug: organization.slug },
        role: current.role,
        // Lets the frontend show/hide UI. The backend still checks every request.
        permissions: actions.filter((a) => can(current.role, a)),
        memberships,
      };
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
