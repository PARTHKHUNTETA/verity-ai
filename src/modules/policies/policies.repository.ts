import { and, desc, eq } from "drizzle-orm";
import type { Database, DbExecutor } from "../../infrastructure/database/client.js";
import { policies, type Policy } from "../../infrastructure/database/schema/index.js";
import { DEFAULT_POLICY_RULES, type PolicyRules } from "./policy-rules.js";

/** The organization's active policy. Created (version 1, defaults) the first time it's needed. */
export async function getActivePolicy(db: DbExecutor, organizationId: string): Promise<Policy> {
  const active = await findActive(db, organizationId);
  if (active) return active;
  // Two requests may race to create it; the partial unique index lets only one win.
  await db
    .insert(policies)
    .values({ organizationId, version: 1, isActive: true, rules: DEFAULT_POLICY_RULES })
    .onConflictDoNothing();
  return (await findActive(db, organizationId))!;
}

async function findActive(db: DbExecutor, organizationId: string) {
  const [row] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.organizationId, organizationId), eq(policies.isActive, true)))
    .limit(1);
  return row;
}

/** Saves new rules as the next version and makes it the active one (atomically). */
export async function saveNewVersion(
  db: Database,
  organizationId: string,
  rules: PolicyRules,
  createdBy: string,
): Promise<{ previous: Policy; current: Policy }> {
  return db.transaction(async (tx) => {
    const previous = await getActivePolicy(tx, organizationId);
    // Lock the active row so two admins saving at once get versions n+1 and n+2, not two n+1s.
    await tx.select().from(policies).where(eq(policies.id, previous.id)).for("update");
    const [latest] = await tx
      .select({ version: policies.version })
      .from(policies)
      .where(eq(policies.organizationId, organizationId))
      .orderBy(desc(policies.version))
      .limit(1);
    await tx.update(policies).set({ isActive: false }).where(eq(policies.id, previous.id));
    const [current] = await tx
      .insert(policies)
      .values({
        organizationId,
        version: (latest?.version ?? previous.version) + 1,
        isActive: true,
        rules,
        createdBy,
      })
      .returning();
    return { previous, current: current! };
  });
}

export async function listVersions(db: DbExecutor, organizationId: string) {
  return db
    .select({
      id: policies.id,
      version: policies.version,
      isActive: policies.isActive,
      createdBy: policies.createdBy,
      createdAt: policies.createdAt,
    })
    .from(policies)
    .where(eq(policies.organizationId, organizationId))
    .orderBy(desc(policies.version));
}
