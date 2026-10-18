import { createHash } from "node:crypto";
import { extname } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Database } from "../../infrastructure/database/client.js";
import type { Collection, Source } from "../../infrastructure/database/schema/index.js";
import type { IngestJobQueue } from "../../infrastructure/queue/queue.js";
import type { FileStorage } from "../../infrastructure/storage/file-storage.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors.js";
import type { AuthContext } from "../auth/auth.types.js";
import { can } from "../policies/permissions.js";
import { detectMimeType, UnsupportedDocumentError } from "../retrieval/parsers.js";
import type { SearchService } from "../retrieval/search.js";
import { canReadCollection, canWriteCollection } from "./access.js";
import type { CreateCollectionInput, SearchInput } from "./sources.schema.js";
import * as repo from "./sources.repository.js";

export type SourcesDeps = {
  storage: FileStorage;
  queue: IngestJobQueue;
  search: SearchService;
};

export type UploadedFile = { originalName: string; buffer: Buffer };

export function toSourceDto(source: Source) {
  return {
    id: source.id,
    type: source.type,
    title: source.title,
    fileName: source.fileName,
    mimeType: source.mimeType,
    sizeBytes: source.sizeBytes,
    authors: source.authors,
    url: source.url,
    status: source.status,
    error: source.error,
    pageCount: source.pageCount,
    tokenCount: source.tokenCount,
    createdAt: source.createdAt,
  };
}

function toCollectionDto(c: Collection, counts?: { sourceCount: number; readyCount: number }) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    visibility: c.visibility,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    ...(counts ?? {}),
  };
}

export function createSourcesService(db: Database, deps: SourcesDeps) {
  /** Loads a collection the actor can read; other orgs' and private ones look like 404. */
  async function readable(actor: AuthContext, collectionId: string) {
    const collection = await repo.findCollection(db, actor.organizationId, collectionId);
    if (!collection || !canReadCollection(actor, collection)) {
      throw new NotFoundError("Collection not found");
    }
    return collection;
  }

  async function writable(actor: AuthContext, collectionId: string) {
    const collection = await readable(actor, collectionId);
    if (!canWriteCollection(actor, collection)) {
      throw new ForbiddenError("You can't change documents in this collection");
    }
    return collection;
  }

  return {
    async listCollections(actor: AuthContext) {
      const rows = await repo.listReadableCollections(db, actor);
      return rows.map((r) =>
        toCollectionDto(r.collection, { sourceCount: r.sourceCount, readyCount: r.readyCount }),
      );
    },

    async createCollection(actor: AuthContext, input: CreateCollectionInput) {
      if (input.visibility === "organization" && !can(actor.role, "collection:manage")) {
        throw new ForbiddenError(
          "Only owners and admins can create organization-wide collections. Create a private one instead.",
        );
      }
      const collection = await repo.insertCollection(db, {
        organizationId: actor.organizationId,
        createdBy: actor.userId,
        ...input,
      });
      return toCollectionDto(collection, { sourceCount: 0, readyCount: 0 });
    },

    async getCollection(actor: AuthContext, collectionId: string) {
      const collection = await readable(actor, collectionId);
      const rows = await repo.listCollectionSources(db, collectionId);
      return {
        ...toCollectionDto(collection),
        canEdit: canWriteCollection(actor, collection),
        sources: rows.map((r) => ({ ...toSourceDto(r.source), addedAt: r.addedAt })),
      };
    },

    async deleteCollection(actor: AuthContext, collectionId: string) {
      await writable(actor, collectionId);
      await repo.softDeleteCollection(db, actor.organizationId, collectionId);
    },

    /**
     * Stores the file and queues ingestion. The same file uploaded twice (same SHA-256) is stored
     * and embedded once; the second upload just adds the existing source to this collection.
     */
    async upload(actor: AuthContext, collectionId: string, file: UploadedFile) {
      await writable(actor, collectionId);
      const bytes = new Uint8Array(file.buffer);
      let mimeType;
      try {
        mimeType = detectMimeType(file.originalName, bytes);
      } catch (err) {
        if (err instanceof UnsupportedDocumentError) throw new ValidationError(err.message);
        throw err;
      }
      const contentHash = createHash("sha256").update(bytes).digest("hex");

      const linkExisting = async (existing: Source) => {
        await repo.addToCollection(db, {
          collectionId,
          sourceId: existing.id,
          addedBy: actor.userId,
        });
        if (existing.deletedAt || existing.status === "failed") {
          await repo.updateSource(db, existing.id, {
            deletedAt: null,
            status: "pending",
            error: null,
          });
          await deps.queue.enqueueSourceIngest(existing.id);
          return { source: toSourceDto({ ...existing, status: "pending" }), duplicate: true };
        }
        return { source: toSourceDto(existing), duplicate: true };
      };

      const existing = await repo.findSourceByHash(db, actor.organizationId, contentHash);
      if (existing) return linkExisting(existing);

      const sourceId = uuidv7();
      const storageKey = `${actor.organizationId}/${sourceId}${extname(file.originalName).toLowerCase()}`;
      await deps.storage.put(storageKey, bytes);
      try {
        const source = await db.transaction(async (tx) => {
          const source = await repo.insertSource(tx, {
            id: sourceId,
            organizationId: actor.organizationId,
            type: "upload",
            title: file.originalName,
            fileName: file.originalName,
            mimeType,
            sizeBytes: bytes.byteLength,
            storageKey,
            contentHash,
            createdBy: actor.userId,
          });
          await repo.addToCollection(tx, { collectionId, sourceId, addedBy: actor.userId });
          return source;
        });
        await deps.queue.enqueueSourceIngest(sourceId);
        return { source: toSourceDto(source), duplicate: false };
      } catch (err) {
        await deps.storage.delete(storageKey);
        // The same file was uploaded concurrently: use the one that won.
        if (isUniqueViolation(err)) {
          const winner = await repo.findSourceByHash(db, actor.organizationId, contentHash);
          if (winner) return linkExisting(winner);
        }
        throw err;
      }
    },

    async removeSource(actor: AuthContext, collectionId: string, sourceId: string) {
      await writable(actor, collectionId);
      const removed = await repo.removeFromCollection(db, collectionId, sourceId);
      if (!removed) throw new NotFoundError("Document not found in this collection");
    },

    /** A source is visible if it's in at least one collection the actor can read. */
    async getSource(actor: AuthContext, sourceId: string) {
      const source = await repo.findSource(db, actor.organizationId, sourceId);
      const inCollections = source
        ? await repo.readableCollectionsForSource(db, actor, sourceId)
        : [];
      if (!source || inCollections.length === 0) throw new NotFoundError("Source not found");
      return {
        ...toSourceDto(source),
        collections: inCollections,
        chunkCount: await repo.countChunks(db, sourceId),
      };
    },

    async listChunks(
      actor: AuthContext,
      sourceId: string,
      page: { offset: number; limit: number },
    ) {
      await this.getSource(actor, sourceId);
      return repo.listChunks(db, actor.organizationId, sourceId, page);
    },

    /** Try retrieval directly, the same way research runs use it. */
    async search(actor: AuthContext, input: SearchInput) {
      const collectionIds = input.collectionIds
        ? await repo.filterReadable(db, actor, input.collectionIds)
        : await repo.readableCollectionIds(db, actor);
      return deps.search.search(input.query, {
        organizationId: actor.organizationId,
        collectionIds,
        topK: input.topK,
      });
    },
  };
}

export type SourcesService = ReturnType<typeof createSourcesService>;
