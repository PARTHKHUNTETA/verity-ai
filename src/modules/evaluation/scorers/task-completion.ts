import { z } from "zod";

/** Task completion: the judge's 0–1 score of how fully the report does what was asked. */
export const taskCompletionSchema = z.object({
  score: z.number().min(0).max(1).describe("0 = ignores the request, 1 = fully does it"),
  missing: z
    .array(z.string())
    .max(5)
    .describe("Parts of the request the report does not address (empty if none)"),
  rationale: z.string().describe("One or two sentences explaining the score"),
});

export type TaskCompletionJudgment = z.infer<typeof taskCompletionSchema>;

/** Clamps and rounds the judge's score; models occasionally return 0–100 instead of 0–1. */
export function taskCompletionScore(judgment: TaskCompletionJudgment): number {
  const raw = judgment.score > 1 ? judgment.score / 100 : judgment.score;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}
