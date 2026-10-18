import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { researchRuns } from "../../infrastructure/database/schema/index.js";

/**
 * Runs still "running" with no progress for this long have lost their worker for good
 * (pg-boss retries a dead worker's job once; if that dies too, nobody resumes it).
 * The run timeout is 10 minutes, so 30 minutes without a checkpoint is safely stuck.
 */
const STALLED_AFTER_MS = 30 * 60 * 1000;

export async function failStalledRuns(db: Database): Promise<string[]> {
  const rows = await db
    .update(researchRuns)
    .set({
      status: "failed",
      errorCode: "STALLED",
      errorMessage: "The run stopped making progress (its worker stopped)",
      completedAt: new Date(),
    })
    .where(
      and(
        eq(researchRuns.status, "running"),
        lt(researchRuns.updatedAt, new Date(Date.now() - STALLED_AFTER_MS)),
      ),
    )
    .returning({ id: researchRuns.id });
  return rows.map((r) => r.id);
}
