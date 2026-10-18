import type { Database } from "../../infrastructure/database/client.js";
import type { MemberRole } from "../../infrastructure/database/schema/index.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { RequestMeta } from "../../shared/request-meta.js";
import type { AuthContext } from "../auth/auth.types.js";
import { revokeUserTokensForOrganization } from "../auth/refresh-tokens.repository.js";
import { findUserByEmail } from "../auth/users.repository.js";
import { recordAudit } from "../audit/audit.repository.js";
import { canAssignRole } from "../policies/permissions.js";
import type { AddMemberInput } from "./members.schema.js";
import {
  addMember,
  findMembership,
  listMembers,
  lockOwners,
  removeMember,
  updateMemberRole,
} from "./members.repository.js";
import { findOrganizationById } from "./organizations.repository.js";

/**
 * Member management. Routes already require "member:manage"; this service adds the rules a
 * flat permission list can't express:
 * - only owners can grant the owner role or change/remove an existing owner;
 * - an organization always keeps at least one owner.
 * All lookups use the caller's organizationId, so ids from other organizations act as "not found".
 */
export function createMembersService(db: Database) {
  const notMember = () => new NotFoundError("Member not found in this organization");

  function assertCanTouch(actor: AuthContext, currentRole: MemberRole, nextRole?: MemberRole) {
    if (currentRole === "owner" && actor.role !== "owner") {
      throw new ForbiddenError("Only owners can change or remove an owner");
    }
    if (nextRole && !canAssignRole(actor.role, nextRole)) {
      throw new ForbiddenError(`Your role (${actor.role}) cannot assign the ${nextRole} role`);
    }
  }

  return {
    async getOrganization(actor: AuthContext) {
      const org = await findOrganizationById(db, actor.organizationId);
      if (!org) throw new NotFoundError("Organization not found");
      return { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt };
    },

    list(actor: AuthContext) {
      return listMembers(db, actor.organizationId);
    },

    /** Adds an already-registered user. Email invitations for new users come in a later phase. */
    async add(actor: AuthContext, input: AddMemberInput, meta: RequestMeta) {
      if (!canAssignRole(actor.role, input.role)) {
        throw new ForbiddenError(`Your role (${actor.role}) cannot assign the ${input.role} role`);
      }
      const user = await findUserByEmail(db, input.email);
      if (!user) throw new NotFoundError("No account with this email. Ask them to register first.");

      try {
        await addMember(db, {
          organizationId: actor.organizationId,
          userId: user.id,
          role: input.role,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError("This user is already a member");
        throw err;
      }
      await recordAudit(db, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "member.add",
        resourceType: "user",
        resourceId: user.id,
        metadata: { role: input.role },
        meta,
      });
      return { userId: user.id, email: user.email, name: user.name, role: input.role };
    },

    async changeRole(actor: AuthContext, userId: string, role: MemberRole, meta: RequestMeta) {
      await db.transaction(async (tx) => {
        const owners = await lockOwners(tx, actor.organizationId);
        const target = await findMembership(tx, actor.organizationId, userId);
        if (!target) throw notMember();
        if (target.role === role) return;

        assertCanTouch(actor, target.role, role);
        if (target.role === "owner" && owners.length === 1) {
          throw new ConflictError("An organization must keep at least one owner");
        }

        await updateMemberRole(tx, actor.organizationId, userId, role);
        await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "member.role_change",
          resourceType: "user",
          resourceId: userId,
          metadata: { from: target.role, to: role },
          meta,
        });
      });
    },

    async remove(actor: AuthContext, userId: string, meta: RequestMeta) {
      await db.transaction(async (tx) => {
        const owners = await lockOwners(tx, actor.organizationId);
        const target = await findMembership(tx, actor.organizationId, userId);
        if (!target) throw notMember();

        assertCanTouch(actor, target.role);
        if (target.role === "owner" && owners.length === 1) {
          throw new ConflictError("An organization must keep at least one owner");
        }

        await removeMember(tx, actor.organizationId, userId);
        // Their access tokens stop working right away (authenticate checks membership);
        // revoking refresh tokens also ends their sessions for this organization.
        await revokeUserTokensForOrganization(tx, userId, actor.organizationId);
        await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "member.remove",
          resourceType: "user",
          resourceId: userId,
          metadata: { role: target.role },
          meta,
        });
      });
    },
  };
}

export type MembersService = ReturnType<typeof createMembersService>;
