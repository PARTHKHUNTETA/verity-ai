import { z } from "zod";
import { evalCaseCategories } from "../../../infrastructure/database/schema/index.js";

const lines = z.array(z.string().trim().min(1).max(500)).max(20).default([]);

export const datasetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, numbers and dashes (e.g. ai-agents)"),
  description: z.string().trim().max(1000).nullish(),
  collectionId: z.uuid().nullish(),
});

export const caseSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  instructions: z.string().trim().max(2000).nullish(),
  referenceAnswer: z.string().trim().max(5000).nullish(),
  category: z.enum(evalCaseCategories).default("normal"),
  requiredPoints: lines,
  expectedSources: lines,
  forbiddenSources: lines,
  forbiddenContent: lines,
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});

export const startEvalRunSchema = z.object({
  datasetId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  /** Model for the agent and the judges. Defaults to the server's model. */
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{1,80}$/)
    .optional(),
  topK: z.number().int().min(1).max(10).default(4),
  discovery: z.boolean().default(false),
  revise: z.boolean().default(true),
  collectionIds: z.array(z.uuid()).max(50).optional(),
  limit: z.number().int().min(1).max(500).nullish(),
});

export const datasetParams = z.object({ datasetId: z.uuid() });
export const caseParams = z.object({ datasetId: z.uuid(), caseId: z.uuid() });
export const evalRunParams = z.object({ evalRunId: z.uuid() });
export const compareQuery = z.object({
  a: z.uuid(),
  b: z.uuid(),
});

export type DatasetInput = z.infer<typeof datasetSchema>;
export type CaseInput = z.infer<typeof caseSchema>;
export type StartEvalRunInput = z.infer<typeof startEvalRunSchema>;
