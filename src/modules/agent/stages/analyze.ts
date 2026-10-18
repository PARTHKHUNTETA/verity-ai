import { asc, eq } from "drizzle-orm";
import {
  evidence,
  sources,
  subQuestions,
  toolCalls,
} from "../../../infrastructure/database/schema/index.js";
import type { ToolLoopItem } from "../../../infrastructure/llm/index.js";
import { runCodeParameters } from "../../tools/code.tool.js";
import {
  ANALYZE_INSTRUCTIONS,
  ANALYZE_PROMPT_VERSION,
  buildAnalyzeInput,
  MAX_ANALYSIS_TURNS,
  MAX_CODE_RUNS,
  type AnalysisData,
} from "../prompts/analyze.js";
import type { StageContext } from "./context.js";

const RUN_CODE_TOOL = {
  name: "run_code",
  description:
    "Run JavaScript in a sandbox to compute something from the evidence (available as `data`). Returns the value of the last expression and any console.log output.",
  parameters: runCodeParameters,
};

/**
 * Analyzing: the agent loop. The model sees the evidence and either calls run_code (executed in
 * the QuickJS sandbox, result fed back) or writes its final analysis notes. Bounded by
 * MAX_ANALYSIS_TURNS model turns and MAX_CODE_RUNS executions, plus the run budget.
 */
export async function analyzeStage(ctx: StageContext): Promise<void> {
  await ctx.db.delete(toolCalls).where(eq(toolCalls.runId, ctx.run.id)); // resume: start clean
  const data = await analysisData(ctx);
  if (data.evidence.length === 0) {
    ctx.state.analysis = null;
    return;
  }

  const items: ToolLoopItem[] = [{ type: "user", content: buildAnalyzeInput(data) }];
  let codeRuns = 0;
  let analysis: string | null = null;

  for (let turn = 0; turn < MAX_ANALYSIS_TURNS; turn++) {
    ctx.checkCancelled();
    const started = Date.now();
    const result = await ctx.llm.chatWithTools({
      model: ctx.run.model,
      instructions: ANALYZE_INSTRUCTIONS,
      items,
      // After the last allowed run, offer no tools: the model has to answer.
      tools: codeRuns < MAX_CODE_RUNS ? [RUN_CODE_TOOL] : [],
      signal: ctx.signal,
    });
    const costUsd = ctx.trackUsage(result.model, result.usage);
    await ctx.recordStep({
      stage: "analyzing",
      type: "llm_call",
      input: { promptVersion: ANALYZE_PROMPT_VERSION, turn: turn + 1 },
      output: { toolCalls: result.toolCalls.length, text: result.text.slice(0, 500) },
      model: result.model,
      tokensInput: result.usage.inputTokens,
      tokensOutput: result.usage.outputTokens,
      costUsd,
      durationMs: Date.now() - started,
    });
    items.push(result.assistant);

    if (result.toolCalls.length === 0) {
      analysis = result.text.trim() || null;
      break;
    }

    for (const call of result.toolCalls) {
      const args = runCodeParameters.safeParse(call.arguments);
      if (call.name !== "run_code" || !args.success || codeRuns >= MAX_CODE_RUNS) {
        const error =
          call.name !== "run_code"
            ? `Unknown tool ${call.name}`
            : !args.success
              ? "Invalid arguments"
              : "Code run limit reached";
        items.push({
          type: "tool_result",
          callId: call.callId,
          output: JSON.stringify({ ok: false, error }),
        });
        continue;
      }
      codeRuns++;
      const [row] = await ctx.db
        .insert(toolCalls)
        .values({
          organizationId: ctx.run.organizationId,
          runId: ctx.run.id,
          tool: "run_code",
          args: args.data,
          status: "running",
        })
        .returning({ id: toolCalls.id });
      const outcome = await ctx.sandbox.run(args.data.code, data);
      const stepId = await ctx.recordStep({
        stage: "analyzing",
        type: "tool_call",
        input: { tool: "run_code", purpose: args.data.purpose },
        output: outcome.ok
          ? { ok: true, result: outcome.result }
          : { ok: false, error: outcome.error },
        durationMs: outcome.durationMs,
      });
      await ctx.db
        .update(toolCalls)
        .set({
          stepId,
          status: outcome.ok ? "succeeded" : "failed",
          result: outcome.ok
            ? { value: outcome.result, logs: outcome.logs }
            : { logs: outcome.logs },
          error: outcome.ok ? null : outcome.error,
          durationMs: outcome.durationMs,
        })
        .where(eq(toolCalls.id, row!.id));
      items.push({ type: "tool_result", callId: call.callId, output: JSON.stringify(outcome) });
    }
  }
  ctx.state.analysis = analysis;
}

/** The evidence as plain JSON, for the prompt and for code (`data`). */
async function analysisData(ctx: StageContext): Promise<AnalysisData> {
  const sqs = await ctx.db
    .select()
    .from(subQuestions)
    .where(eq(subQuestions.runId, ctx.run.id))
    .orderBy(asc(subQuestions.position));
  const rows = await ctx.db
    .select({
      evidence,
      sourceTitle: sources.title,
      domain: sources.domain,
      publishedAt: sources.publishedAt,
    })
    .from(evidence)
    .innerJoin(sources, eq(sources.id, evidence.sourceId))
    .where(eq(evidence.runId, ctx.run.id))
    .orderBy(asc(evidence.rank));
  const position = new Map(sqs.map((sq) => [sq.id, sq.position]));
  return {
    question: ctx.task.question,
    subQuestions: sqs.map((sq) => ({ n: sq.position, text: sq.text })),
    evidence: rows.map((r) => ({
      n: r.evidence.rank,
      subQuestion: position.get(r.evidence.subQuestionId ?? "") ?? 0,
      stance: r.evidence.stance ?? "neutral",
      confidence: r.evidence.confidence ?? 0,
      source: r.sourceTitle,
      domain: r.domain,
      year: r.publishedAt ? Number(r.publishedAt.slice(0, 4)) : null,
      quote: r.evidence.quote,
    })),
  };
}
