import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { collections, type Collection } from "../../infrastructure/database/schema/index.js";
import type { AuthContext } from "../auth/auth.types.js";
import { can } from "../policies/permissions.js";

/**
 * Collection access rules (docs/system-design.md §4.7):
 * - "organization" collections: every member can read them.
 * - "private" collections: only their creator, plus owners/admins (collection:manage).
 * - Adding/removing documents: the creator (if they can create sources) or collection:manage.
 */

/** SQL filter for collections the actor can read. Use it in every collection query. */
export function readableCollectionsFilter(actor: AuthContext): SQL {
  const base = and(
    eq(collections.organizationId, actor.organizationId),
    isNull(collections.deletedAt),
  )!;
  if (can(actor.role, "collection:manage")) return base;
  return and(
    base,
    or(eq(collections.visibility, "organization"), eq(collections.createdBy, actor.userId)),
  )!;
}

export function canReadCollection(actor: AuthContext, collection: Collection): boolean {
  return (
    collection.organizationId === actor.organizationId &&
    (collection.visibility === "organization" ||
      collection.createdBy === actor.userId ||
      can(actor.role, "collection:manage"))
  );
}

export function canWriteCollection(actor: AuthContext, collection: Collection): boolean {
  if (can(actor.role, "collection:manage")) return true;
  return collection.createdBy === actor.userId && can(actor.role, "source:create");
}
