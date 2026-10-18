import { z } from "zod";
import { collectionVisibilities } from "../../infrastructure/database/schema/index.js";

export const createCollectionSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(collectionVisibilities).default("organization"),
});

export const collectionParamsSchema = z.object({ collectionId: z.uuid() });
export const collectionSourceParamsSchema = z.object({
  collectionId: z.uuid(),
  sourceId: z.uuid(),
});
export const sourceParamsSchema = z.object({ sourceId: z.uuid() });

export const chunksQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const searchSchema = z.object({
  query: z.string().trim().min(2).max(1000),
  collectionIds: z.array(z.uuid()).max(50).optional(),
  topK: z.number().int().min(1).max(20).default(8),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type SearchInput = z.infer<typeof searchSchema>;
