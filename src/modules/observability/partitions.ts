import { sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";

/**
 * trace_spans is partitioned by month (trace_spans_YYYY_MM). Partitions are created ahead of time,
 * and retention works by dropping whole old partitions: instant, no slow DELETE, no table bloat.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const monthStart = (year: number, month0: number) => new Date(Date.UTC(year, month0, 1));
const partitionName = (d: Date) => `trace_spans_${d.getUTCFullYear()}_${pad(d.getUTCMonth() + 1)}`;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Creates partitions for the current month and the next `monthsAhead` months (idempotent). */
export async function ensureMonthlyPartitions(
  db: Database,
  { now = new Date(), monthsAhead = 2 }: { now?: Date; monthsAhead?: number } = {},
): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() + i);
    const to = monthStart(from.getUTCFullYear(), from.getUTCMonth() + 1);
    const name = partitionName(from);
    try {
      await db.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "trace_spans" FOR VALUES FROM ('${isoDate(from)}') TO ('${isoDate(to)}')`,
        ),
      );
      created.push(name);
    } catch (err) {
      // Usually: rows for that month already landed in the DEFAULT partition. Harmless; they stay there.
      if (!/would be violated|already exists/i.test(String(err))) throw err;
    }
  }
  return created;
}

/** Drops monthly partitions whose whole month ended more than `retentionDays` ago. */
export async function dropExpiredPartitions(
  db: Database,
  { now = new Date(), retentionDays = 30 }: { now?: Date; retentionDays?: number } = {},
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const children = await db.execute<{ name: string }>(sql`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'trace_spans'
  `);
  const dropped: string[] = [];
  for (const { name } of children.rows) {
    const match = name.match(/^trace_spans_(\d{4})_(\d{2})$/);
    if (!match) continue; // e.g. the DEFAULT partition
    const monthEnd = monthStart(Number(match[1]), Number(match[2])); // first day of the next month
    if (monthEnd <= cutoff) {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS "${name}"`));
      dropped.push(name);
    }
  }
  return dropped;
}
