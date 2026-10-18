import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import { organizations, type Organization } from "../../infrastructure/database/schema/index.js";

export async function createOrganization(
  db: DbExecutor,
  values: { name: string; slug: string },
): Promise<Organization> {
  const [org] = await db.insert(organizations).values(values).returning();
  return org!;
}

export async function findOrganizationById(
  db: DbExecutor,
  id: string,
): Promise<Organization | undefined> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return org;
}

export async function slugExists(db: DbExecutor, slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  return row !== undefined;
}
