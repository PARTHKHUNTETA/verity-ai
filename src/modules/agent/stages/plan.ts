import { eq } from "drizzle-orm";
import { subQuestions } from "../../../infrastructure/database/schema/index.js";
import {
  buildPlanInput,
  PLAN_INSTRUCTIONS,
  PLAN_PROMPT_VERSION,
  researchPlanSchema,
} from "../prompts/plan.js";
import type { StageContext } from "./context.js";

/** Planning: question → 2–4 sub-questions with search queries, and a report title. */
export async function planStage(ctx: StageContext): Promise<void> {
  await ctx.db.delete(subQuestions).where(eq(subQuestions.runId, ctx.run.id)); // resume: start clean
  const started = Date.now();
  const input = buildPlanInput(ctx.task.question, ctx.task.instructions);
  const {
    object: plan,
    model,
    usage,
  } = await ctx.llm.generateObject({
    model: ctx.run.model,
    instructions: PLAN_INSTRUCTIONS,
    input,
    schema: researchPlanSchema,
    schemaName: "research_plan",
    signal: ctx.signal,
  });
  const costUsd = ctx.trackUsage(model, usage);

  await ctx.db.insert(subQuestions).values(
    plan.subQuestions.map((sq, i) => ({
      organizationId: ctx.run.organizationId,
      runId: ctx.run.id,
      position: i + 1,
      text: sq.question,
      rationale: sq.rationale,
      searchQueries: sq.searchQueries,
    })),
  );
  ctx.state.title = plan.title;

  await ctx.recordStep({
    stage: "planning",
    type: "llm_call",
    input: { promptVersion: PLAN_PROMPT_VERSION, question: ctx.task.question },
    output: { title: plan.title, subQuestions: plan.subQuestions.map((s) => s.question) },
    model,
    tokensInput: usage.inputTokens,
    tokensOutput: usage.outputTokens,
    costUsd,
    durationMs: Date.now() - started,
  });
}
