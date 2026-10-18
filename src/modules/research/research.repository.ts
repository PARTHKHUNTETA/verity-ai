import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  reports,
  researchRuns,
  researchTasks,
  type ResearchRun,
  type ResearchTask,
} from "../../infrastructure/database/schema/index.js";

/** Tenant rule: every function filters by organizationId. */

export async function insertTask(
  db: DbExecutor,
  values: { organizationId: string; createdBy: string; question: string; instructions?: string },
): Promise<ResearchTask> {
  const [task] = await db.insert(researchTasks).values(values).returning();
  return task!;
}

export async function insertRun(
  db: DbExecutor,
  values: {
    organizationId: string;
    taskId: string;
    startedBy: string;
    model: string;
    promptVersion: string;
  },
): Promise<ResearchRun> {
  const [run] = await db.insert(researchRuns).values(values).returning();
  return run!;
}

export async function findTask(db: DbExecutor, organizationId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(researchTasks)
    .where(
      and(
        eq(researchTasks.id, taskId),
        eq(researchTasks.organizationId, organizationId),
        isNull(researchTasks.deletedAt),
      ),
    );
  return task;
}

export async function listTasks(db: DbExecutor, organizationId: string, limit = 50) {
  return db
    .select()
    .from(researchTasks)
    .where(and(eq(researchTasks.organizationId, organizationId), isNull(researchTasks.deletedAt)))
    .orderBy(desc(researchTasks.createdAt))
    .limit(limit);
}

export async function listRunsForTasks(db: DbExecutor, organizationId: string, taskIds: string[]) {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(researchRuns)
    .where(
      and(eq(researchRuns.organizationId, organizationId), inArray(researchRuns.taskId, taskIds)),
    )
    .orderBy(desc(researchRuns.createdAt));
}

export async function findRun(db: DbExecutor, organizationId: string, runId: string) {
  const [row] = await db
    .select({ run: researchRuns, task: researchTasks })
    .from(researchRuns)
    .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
    .where(and(eq(researchRuns.id, runId), eq(researchRuns.organizationId, organizationId)));
  return row;
}

export async function findLatestReport(db: DbExecutor, organizationId: string, runId: string) {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.runId, runId), eq(reports.organizationId, organizationId)))
    .orderBy(desc(reports.version))
    .limit(1);
  return report;
}

/** Cancels only if the run hasn't finished yet. Returns the run when this call cancelled it. */
export async function cancelRun(db: DbExecutor, organizationId: string, runId: string) {
  const [run] = await db
    .update(researchRuns)
    .set({ status: "cancelled", errorCode: "CANCELLED", errorMessage: "Cancelled by user" })
    .where(
      and(
        eq(researchRuns.id, runId),
        eq(researchRuns.organizationId, organizationId),
        inArray(researchRuns.status, ["queued", "running", "awaiting_approval"]),
      ),
    )
    .returning();
  return run;
}

export async function markRunFailed(db: DbExecutor, runId: string, code: string, message: string) {
  await db
    .update(researchRuns)
    .set({ status: "failed", errorCode: code, errorMessage: message, completedAt: new Date() })
    .where(eq(researchRuns.id, runId));
}
