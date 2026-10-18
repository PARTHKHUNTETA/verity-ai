import { and, asc, eq } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import { traceSpans, type TraceSpan } from "../../infrastructure/database/schema/index.js";

/**
 * A run's trace plus a summary computed from it, built to answer two questions from the UI:
 * "why was this run slow?" (where the time went, slowest operations) and "what did it cost?"
 * (cost and tokens per stage, from the LLM spans).
 */

export type TraceSummary = {
  totalMs: number;
  llm: {
    calls: number;
    ms: number;
    costUsd: number | null;
    tokensInput: number;
    tokensOutput: number;
  };
  tools: { calls: number; ms: number; denied: number; failed: number; cached: number };
  stages: Array<{
    stage: string;
    ms: number;
    llmMs: number;
    toolMs: number;
    costUsd: number | null;
  }>;
  slowest: Array<{ spanId: string; name: string; ms: number; detail: string | null }>;
  errors: Array<{ spanId: string; name: string; message: string | null }>;
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function summarizeTrace(spans: TraceSpan[]): TraceSummary {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  /** The nearest "stage.*" ancestor of a span (its stage). */
  const stageOf = (span: TraceSpan): string | null => {
    for (
      let cur: TraceSpan | undefined = span;
      cur;
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined
    ) {
      if (cur.name.startsWith("stage.")) return cur.name.slice("stage.".length);
    }
    return null;
  };

  /** LLM calls made by a tool (e.g. embeddings inside retrieval) are already in the tool's time. */
  const insideTool = (span: TraceSpan): boolean => {
    for (
      let cur = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
      cur;
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined
    ) {
      if (cur.name.startsWith("tool.")) return true;
    }
    return false;
  };

  const start = Math.min(...spans.map((s) => s.startTime.getTime()));
  const end = Math.max(...spans.map((s) => (s.endTime ?? s.startTime).getTime()));
  const llmSpans = spans.filter((s) => s.name.startsWith("llm."));
  const toolSpans = spans.filter((s) => s.name.startsWith("tool."));
  const sumCost = (list: TraceSpan[]) =>
    list.some((s) => s.attributes.costUsd === null)
      ? null
      : Math.round(list.reduce((sum, s) => sum + num(s.attributes.costUsd), 0) * 1e6) / 1e6;

  const stageNames = [
    ...new Set(spans.filter((s) => s.name.startsWith("stage.")).map((s) => s.name.slice(6))),
  ];
  const stages = stageNames.map((stage) => {
    const stageSpans = spans.filter((s) => s.name === `stage.${stage}`);
    const inStage = (list: TraceSpan[]) => list.filter((s) => stageOf(s) === stage);
    return {
      stage,
      ms: stageSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      // Direct LLM calls only, so llmMs + toolMs never counts the same time twice.
      llmMs: inStage(llmSpans)
        .filter((s) => !insideTool(s))
        .reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      toolMs: inStage(toolSpans).reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      costUsd: sumCost(inStage(llmSpans)),
    };
  });

  const detailOf = (s: TraceSpan) =>
    (s.attributes.model ??
      s.attributes.target ??
      s.attributes.url ??
      s.attributes.query ??
      null) as string | null;
  const slowest = spans
    .filter((s) => s.name !== "run" && !s.name.startsWith("stage."))
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 5)
    .map((s) => ({ spanId: s.spanId, name: s.name, ms: s.durationMs ?? 0, detail: detailOf(s) }));

  return {
    totalMs: spans.length ? end - start : 0,
    llm: {
      calls: llmSpans.length,
      ms: llmSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      costUsd: sumCost(llmSpans),
      tokensInput: llmSpans.reduce((sum, s) => sum + num(s.attributes.tokensInput), 0),
      tokensOutput: llmSpans.reduce((sum, s) => sum + num(s.attributes.tokensOutput), 0),
    },
    tools: {
      calls: toolSpans.length,
      ms: toolSpans.reduce((sum, s) => sum + (s.durationMs ?? 0), 0),
      denied: toolSpans.filter((s) => s.attributes.outcome === "denied").length,
      failed: toolSpans.filter((s) => s.attributes.outcome === "failed").length,
      cached: toolSpans.filter((s) => s.attributes.cached === true).length,
    },
    stages,
    slowest,
    errors: spans
      .filter((s) => s.status === "error")
      .map((s) => ({ spanId: s.spanId, name: s.name, message: s.errorMessage })),
  };
}

export async function getRunTrace(db: DbExecutor, organizationId: string, runId: string) {
  const spans = await db
    .select()
    .from(traceSpans)
    .where(and(eq(traceSpans.traceId, runId), eq(traceSpans.organizationId, organizationId)))
    .orderBy(asc(traceSpans.startTime));
  return { traceId: runId, spans, summary: summarizeTrace(spans) };
}
