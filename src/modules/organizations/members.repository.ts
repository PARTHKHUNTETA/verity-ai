import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  organizationMembers,
  organizations,
  users,
  type MemberRole,
  type OrganizationMember,
} from "../../infrastructure/database/schema/index.js";

/**
 * Tenant rule: every query here is scoped by organizationId. A member of org A can never
 * read or change org B's rows, even with a valid id from org B.
 */

export async function findMembership(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<OrganizationMember | undefined> {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return row;
}

export async function listMembers(db: DbExecutor, organizationId: string) {
  return db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(asc(organizationMembers.createdAt));
}

/** All organizations a user belongs to, oldest membership first. */
export async function listMembershipsForUser(db: DbExecutor, userId: string) {
  return db
    .select({
      organizationId: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      role: organizationMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizationMembers.createdAt));
}

export async function addMember(
  db: DbExecutor,
  values: { organizationId: string; userId: string; role: MemberRole },
): Promise<OrganizationMember> {
  const [row] = await db.insert(organizationMembers).values(values).returning();
  return row!;
}

export async function updateMemberRole(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db
    .update(organizationMembers)
    .set({ role })
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

export async function removeMember(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
}

/**
 * Locks the organization's owner rows until the transaction ends (SELECT ... FOR UPDATE),
 * so two admins can't concurrently demote the last two owners. Must be called inside a transaction.
 */
export async function lockOwners(db: DbExecutor, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, "owner"),
      ),
    )
    .for("update");
  return rows.map((r) => r.userId);
}
