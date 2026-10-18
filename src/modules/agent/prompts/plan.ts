import { z } from "zod";

export const PLAN_PROMPT_VERSION = "plan-v1";

export const researchPlanSchema = z.object({
  title: z.string().describe("A short title for the report (max 12 words)"),
  subQuestions: z
    .array(
      z.object({
        question: z
          .string()
          .min(8)
          .describe("A focused question that can be answered from sources"),
        rationale: z.string().describe("Why this sub-question matters for the main question"),
        searchQueries: z
          .array(z.string())
          .min(1)
          .max(2)
          .describe("Short keyword queries (3–6 words) for academic and web search"),
      }),
    )
    .min(2)
    .max(4),
});

export type ResearchPlan = z.infer<typeof researchPlanSchema>;

export const PLAN_INSTRUCTIONS = `You are the planner of VerityAI, an evidence-based research agent.

Break the user's research question into 2–4 sub-questions that together answer it.
- Each sub-question must be answerable from documents (papers, reports, articles).
- Cover what the question asks for: e.g. definitions/state of the art, a comparison of approaches, evaluation results, open problems or gaps.
- Give each sub-question 1–2 short keyword search queries (3–6 words, no quotes or operators).
- Don't answer the question yourself.`;

export function buildPlanInput(question: string, instructions: string | null): string {
  return instructions
    ? `Research question:\n${question}\n\nAdditional instructions:\n${instructions}`
    : `Research question:\n${question}`;
}
