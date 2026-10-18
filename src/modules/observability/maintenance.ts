import type { Logger } from "pino";
import type { Database } from "../../infrastructure/database/client.js";
import { dropExpiredPartitions, ensureMonthlyPartitions } from "./partitions.js";

/** Keeps trace partitions ahead of time and drops expired months (30-day retention). */
export async function maintainTracePartitions(db: Database, logger: Logger, retentionDays = 30) {
  try {
    const created = await ensureMonthlyPartitions(db);
    const dropped = await dropExpiredPartitions(db, { retentionDays });
    if (dropped.length) logger.info({ dropped }, "Dropped expired trace partitions");
    return { created, dropped };
  } catch (err) {
    logger.error({ err }, "Trace partition maintenance failed");
    return { created: [], dropped: [] };
  }
}
