import { z } from "zod";

export const createTaskSchema = z.object({
  question: z.string().trim().min(10, "Ask a question of at least 10 characters").max(2000),
  instructions: z.string().trim().max(2000).optional(),
  /** Collections to search. Defaults to every collection the user can read. */
  collectionIds: z.array(z.uuid()).max(50).optional(),
});

export const taskParamsSchema = z.object({ taskId: z.uuid() });
export const runParamsSchema = z.object({ runId: z.uuid() });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
