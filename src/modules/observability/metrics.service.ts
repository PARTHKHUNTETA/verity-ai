import { sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";

/**
 * Org-wide health of the agent over a time window (docs/system-design.md §4.9): how fast and
 * how expensive runs are, what fails, which tools error or get denied, and how LLM latency looks.
 * Percentiles use Postgres's percentile_cont over raw durations.
 */
export function createMetricsService(db: Database) {
  const rows = async <T>(query: ReturnType<typeof sql>) => (await db.execute(query)).rows as T[];

  return {
    async overview(organizationId: string, days: number) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [runs] = await rows<{
        total: number;
        completed: number;
        failed: number;
        cancelled: number;
        awaiting_approval: number;
        p50_ms: number | null;
        p95_ms: number | null;
        avg_cost_usd: number | null;
        total_cost_usd: number | null;
        total_tokens: number | null;
      }>(sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status = 'completed')::int AS completed,
               count(*) FILTER (WHERE status = 'failed')::int AS failed,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
               count(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting_approval,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - started_at) * 1000)
                 FILTER (WHERE status = 'completed') AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - started_at) * 1000)
                 FILTER (WHERE status = 'completed') AS p95_ms,
               avg(cost_usd) FILTER (WHERE status = 'completed')::float AS avg_cost_usd,
               sum(cost_usd)::float AS total_cost_usd,
               sum(tokens_input + tokens_output)::int AS total_tokens
        FROM research_runs
        WHERE organization_id = ${organizationId} AND created_at >= ${since}
      `);

      const failures = await rows<{ code: string; count: number }>(sql`
        SELECT coalesce(error_code, 'UNKNOWN') AS code, count(*)::int AS count
        FROM research_runs
        WHERE organization_id = ${organizationId} AND created_at >= ${since} AND status = 'failed'
        GROUP BY 1 ORDER BY 2 DESC
      `);

      const spanStats = (prefix: string) => sql`
        SELECT name, count(*)::int AS calls,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
               (count(*) FILTER (WHERE status = 'error'))::float / count(*) AS error_rate,
               sum(coalesce((attributes->>'costUsd')::numeric, 0))::float AS cost_usd
        FROM trace_spans
        WHERE organization_id = ${organizationId} AND start_time >= ${since} AND name LIKE ${`${prefix}%`}
        GROUP BY name ORDER BY p95_ms DESC NULLS LAST
      `;
      type SpanRow = {
        name: string;
        calls: number;
        p50_ms: number;
        p95_ms: number;
        error_rate: number;
        cost_usd: number;
      };
      const llm = await rows<SpanRow>(spanStats("llm."));
      const stages = await rows<SpanRow>(spanStats("stage."));

      const tools = await rows<{
        tool: string;
        calls: number;
        succeeded: number;
        failed: number;
        denied: number;
        awaiting: number;
        avg_ms: number | null;
      }>(sql`
        SELECT tc.tool, count(*)::int AS calls,
               count(*) FILTER (WHERE tc.status = 'succeeded')::int AS succeeded,
               count(*) FILTER (WHERE tc.status = 'failed')::int AS failed,
               count(*) FILTER (WHERE tc.status = 'denied')::int AS denied,
               count(*) FILTER (WHERE tc.status = 'awaiting_approval')::int AS awaiting,
               avg(tc.duration_ms)::float AS avg_ms
        FROM tool_calls tc
        WHERE tc.organization_id = ${organizationId} AND tc.created_at >= ${since}
        GROUP BY tc.tool ORDER BY calls DESC
      `);

      const denials = await rows<{ decision: string; rule: string; count: number }>(sql`
        SELECT decision::text, matched_rule AS rule, count(*)::int AS count
        FROM policy_decisions
        WHERE organization_id = ${organizationId} AND created_at >= ${since} AND decision <> 'allow'
        GROUP BY 1, 2 ORDER BY 3 DESC
      `);

      const daily = await rows<{ day: string; runs: number; failed: number; cost_usd: number }>(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               count(*)::int AS runs,
               count(*) FILTER (WHERE status = 'failed')::int AS failed,
               coalesce(sum(cost_usd), 0)::float AS cost_usd
        FROM research_runs
        WHERE organization_id = ${organizationId} AND created_at >= ${since}
        GROUP BY 1 ORDER BY 1
      `);

      const round = (n: number | null | undefined) => (n == null ? null : Math.round(Number(n)));
      return {
        window: { days, since },
        runs: {
          total: runs?.total ?? 0,
          completed: runs?.completed ?? 0,
          failed: runs?.failed ?? 0,
          cancelled: runs?.cancelled ?? 0,
          awaitingApproval: runs?.awaiting_approval ?? 0,
          p50Ms: round(runs?.p50_ms),
          p95Ms: round(runs?.p95_ms),
          avgCostUsd: runs?.avg_cost_usd ?? null,
          totalCostUsd: runs?.total_cost_usd ?? 0,
          totalTokens: runs?.total_tokens ?? 0,
        },
        failures,
        llm: llm.map((r) => ({
          name: r.name,
          calls: r.calls,
          p50Ms: round(r.p50_ms),
          p95Ms: round(r.p95_ms),
          errorRate: r.error_rate,
          costUsd: r.cost_usd,
        })),
        stages: stages.map((r) => ({
          name: r.name.replace(/^stage\./, ""),
          calls: r.calls,
          p50Ms: round(r.p50_ms),
          p95Ms: round(r.p95_ms),
        })),
        tools: tools.map((t) => ({
          ...t,
          avgMs: round(t.avg_ms),
          errorRate: t.calls ? t.failed / t.calls : 0,
        })),
        denials,
        daily: daily.map((d) => ({
          day: d.day,
          runs: d.runs,
          failed: d.failed,
          costUsd: d.cost_usd,
        })),
      };
    },
  };
}

export type MetricsService = ReturnType<typeof createMetricsService>;
