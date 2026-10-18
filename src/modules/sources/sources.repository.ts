import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  collections,
  collectionSources,
  sourceChunks,
  sources,
  type Source,
} from "../../infrastructure/database/schema/index.js";
import type { AuthContext } from "../auth/auth.types.js";
import { readableCollectionsFilter } from "./access.js";

export async function listReadableCollections(db: DbExecutor, actor: AuthContext) {
  return db
    .select({
      collection: collections,
      sourceCount: count(collectionSources.sourceId),
      readyCount: sql<number>`count(*) filter (where ${sources.status} = 'ready')`.mapWith(Number),
    })
    .from(collections)
    .leftJoin(collectionSources, eq(collectionSources.collectionId, collections.id))
    .leftJoin(sources, and(eq(sources.id, collectionSources.sourceId), isNull(sources.deletedAt)))
    .where(readableCollectionsFilter(actor))
    .groupBy(collections.id)
    .orderBy(desc(collections.createdAt));
}

export async function readableCollectionIds(db: DbExecutor, actor: AuthContext): Promise<string[]> {
  const rows = await db
    .select({ id: collections.id })
    .from(collections)
    .where(readableCollectionsFilter(actor));
  return rows.map((r) => r.id);
}

export async function findCollection(db: DbExecutor, organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.id, id),
        eq(collections.organizationId, organizationId),
        isNull(collections.deletedAt),
      ),
    );
  return row;
}

export async function insertCollection(db: DbExecutor, values: typeof collections.$inferInsert) {
  const [row] = await db.insert(collections).values(values).returning();
  return row!;
}

export async function softDeleteCollection(db: DbExecutor, organizationId: string, id: string) {
  await db
    .update(collections)
    .set({ deletedAt: new Date() })
    .where(and(eq(collections.id, id), eq(collections.organizationId, organizationId)));
}

export async function listCollectionSources(db: DbExecutor, collectionId: string) {
  return db
    .select({ source: sources, addedAt: collectionSources.createdAt })
    .from(collectionSources)
    .innerJoin(sources, eq(sources.id, collectionSources.sourceId))
    .where(and(eq(collectionSources.collectionId, collectionId), isNull(sources.deletedAt)))
    .orderBy(desc(collectionSources.createdAt));
}

export async function findSource(db: DbExecutor, organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, id),
        eq(sources.organizationId, organizationId),
        isNull(sources.deletedAt),
      ),
    );
  return row;
}

export async function findSourceByHash(
  db: DbExecutor,
  organizationId: string,
  contentHash: string,
) {
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.organizationId, organizationId), eq(sources.contentHash, contentHash)));
  return row;
}

export async function insertSource(
  db: DbExecutor,
  values: typeof sources.$inferInsert,
): Promise<Source> {
  const [row] = await db.insert(sources).values(values).returning();
  return row!;
}

export async function updateSource(
  db: DbExecutor,
  id: string,
  values: Partial<typeof sources.$inferInsert>,
) {
  await db.update(sources).set(values).where(eq(sources.id, id));
}

export async function addToCollection(
  db: DbExecutor,
  values: { collectionId: string; sourceId: string; addedBy: string },
) {
  await db.insert(collectionSources).values(values).onConflictDoNothing();
}

export async function removeFromCollection(db: DbExecutor, collectionId: string, sourceId: string) {
  const deleted = await db
    .delete(collectionSources)
    .where(
      and(
        eq(collectionSources.collectionId, collectionId),
        eq(collectionSources.sourceId, sourceId),
      ),
    )
    .returning();
  return deleted.length > 0;
}

/** Collections (readable by the actor) that contain the source. */
export async function readableCollectionsForSource(
  db: DbExecutor,
  actor: AuthContext,
  sourceId: string,
) {
  return db
    .select({ id: collections.id, name: collections.name })
    .from(collectionSources)
    .innerJoin(collections, eq(collections.id, collectionSources.collectionId))
    .where(and(eq(collectionSources.sourceId, sourceId), readableCollectionsFilter(actor)));
}

export async function listChunks(
  db: DbExecutor,
  organizationId: string,
  sourceId: string,
  { offset, limit }: { offset: number; limit: number },
) {
  return db
    .select({
      id: sourceChunks.id,
      chunkIndex: sourceChunks.chunkIndex,
      content: sourceChunks.content,
      tokenCount: sourceChunks.tokenCount,
      pageStart: sourceChunks.pageStart,
      pageEnd: sourceChunks.pageEnd,
    })
    .from(sourceChunks)
    .where(
      and(eq(sourceChunks.sourceId, sourceId), eq(sourceChunks.organizationId, organizationId)),
    )
    .orderBy(asc(sourceChunks.chunkIndex))
    .offset(offset)
    .limit(limit);
}

export async function countChunks(db: DbExecutor, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sourceChunks)
    .where(eq(sourceChunks.sourceId, sourceId));
  return row?.n ?? 0;
}

export async function filterReadable(
  db: DbExecutor,
  actor: AuthContext,
  collectionIds: string[],
): Promise<string[]> {
  if (collectionIds.length === 0) return [];
  const rows = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(inArray(collections.id, collectionIds), readableCollectionsFilter(actor)));
  return rows.map((r) => r.id);
}
