import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import { users, type NewUser, type User } from "../../infrastructure/database/schema/index.js";

/** Users are global (not tenant-owned); organization access goes through organization_members. */

export async function findUserByEmail(db: DbExecutor, email: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function findUserById(db: DbExecutor, id: string): Promise<User | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function createUser(db: DbExecutor, values: NewUser): Promise<User> {
  const [user] = await db.insert(users).values(values).returning();
  return user!;
}

export async function touchLastLogin(db: DbExecutor, id: string): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}
