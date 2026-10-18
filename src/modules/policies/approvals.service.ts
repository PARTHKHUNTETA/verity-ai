import { and, count, desc, eq, lt, sql } from "drizzle-orm";
import type { Database, DbExecutor } from "../../infrastructure/database/client.js";
import {
  approvals,
  researchRuns,
  researchTasks,
  users,
  type Approval,
} from "../../infrastructure/database/schema/index.js";
import type { RunEventPublisher } from "../../infrastructure/events/run-events.js";
import type { ResearchJobQueue } from "../../infrastructure/queue/queue.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import type { RequestMeta } from "../../shared/request-meta.js";
import type { Budget } from "../agent/budget.js";
import type { AuthContext } from "../auth/auth.types.js";
import { recordAudit } from "../audit/audit.repository.js";

/**
 * Human-in-the-loop (docs/system-design.md §4.8). The agent paused a run because a tool call
 * needs approval or its budget ran out; a reviewer (approval:decide) approves or rejects.
 * When the run has no pending approvals left, it is re-queued and continues where it stopped:
 * an approved call runs, a rejected call comes back to the agent as "denied".
 */

export type ApprovalDecisionInput = {
  decision: "approve" | "reject";
  comment?: string;
  /** Budget approvals: the new limit (defaults to double the old one). */
  newLimit?: number;
};

export type ApprovalsDeps = { queue: ResearchJobQueue; events: RunEventPublisher };

type BudgetDetails = { limit: keyof Budget; max: number; used: number };

export function createApprovalsService(db: Database, deps: ApprovalsDeps) {
  /** After a decision: re-queue the run if nothing else is pending (or fail it). */
  async function settleRun(
    tx: DbExecutor,
    runId: string,
    failure?: { code: string; message: string },
  ) {
    const [run] = await tx.select().from(researchRuns).where(eq(researchRuns.id, runId));
    if (!run || run.status !== "awaiting_approval") return null;
    if (failure) {
      await tx
        .update(researchRuns)
        .set({
          status: "failed",
          errorCode: failure.code,
          errorMessage: failure.message,
          completedAt: new Date(),
        })
        .where(eq(researchRuns.id, runId));
      return { runId, status: "failed" as const, stage: run.stage };
    }
    const [pending] = await tx
      .select({ n: count() })
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
    if ((pending?.n ?? 0) > 0) return null;
    await tx.update(researchRuns).set({ status: "queued" }).where(eq(researchRuns.id, runId));
    return { runId, status: "queued" as const, stage: run.stage };
  }

  /** Runs side effects that must happen after the transaction commits. */
  async function announce(outcome: Awaited<ReturnType<typeof settleRun>>) {
    if (!outcome) return;
    if (outcome.status === "queued") await deps.queue.enqueueResearchRun(outcome.runId);
    await deps.events.publish({
      type: "status",
      runId: outcome.runId,
      status: outcome.status,
      stage: outcome.stage,
    });
  }

  async function applyBudgetIncrease(tx: DbExecutor, approval: Approval, newLimit?: number) {
    const details = approval.details as BudgetDetails;
    const value = newLimit ?? details.max * 2;
    if (value <= details.used) {
      throw new ValidationError(
        `The new limit must be higher than what was already used (${details.used})`,
      );
    }
    // Raise just this run's limit (run config overrides the org policy). jsonb_set alone won't
    // create a missing "budget" object, so merge into it (or into {}) explicitly.
    await tx
      .update(researchRuns)
      .set({
        config: sql`jsonb_set(
          coalesce(${researchRuns.config}, '{}'::jsonb),
          '{budget}',
          coalesce(${researchRuns.config}->'budget', '{}'::jsonb)
            || jsonb_build_object(${details.limit}::text, ${value}::numeric)
        )`,
      })
      .where(eq(researchRuns.id, approval.runId));
    return value;
  }

  return {
    async list(actor: AuthContext, status: "pending" | "all") {
      return db
        .select({
          id: approvals.id,
          runId: approvals.runId,
          kind: approvals.kind,
          summary: approvals.summary,
          details: approvals.details,
          status: approvals.status,
          comment: approvals.comment,
          createdAt: approvals.createdAt,
          decidedAt: approvals.decidedAt,
          expiresAt: approvals.expiresAt,
          question: researchTasks.question,
          requestedByEmail: users.email,
        })
        .from(approvals)
        .innerJoin(researchRuns, eq(researchRuns.id, approvals.runId))
        .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
        .leftJoin(users, eq(users.id, approvals.requestedBy))
        .where(
          and(
            eq(approvals.organizationId, actor.organizationId),
            status === "pending" ? eq(approvals.status, "pending") : undefined,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .limit(100);
    },

    async pendingCount(actor: AuthContext): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(approvals)
        .where(
          and(eq(approvals.organizationId, actor.organizationId), eq(approvals.status, "pending")),
        );
      return row?.n ?? 0;
    },

    async decide(
      actor: AuthContext,
      approvalId: string,
      input: ApprovalDecisionInput,
      meta: RequestMeta,
    ) {
      const outcome = await db.transaction(async (tx) => {
        // Lock the approval: two reviewers clicking at once can't both decide it.
        const [approval] = await tx
          .select()
          .from(approvals)
          .where(
            and(eq(approvals.id, approvalId), eq(approvals.organizationId, actor.organizationId)),
          )
          .for("update");
        if (!approval) throw new NotFoundError("Approval not found");
        if (approval.status !== "pending")
          throw new ConflictError(`This request was already ${approval.status}`);
        if (approval.expiresAt < new Date()) {
          await tx.update(approvals).set({ status: "expired" }).where(eq(approvals.id, approvalId));
          throw new ConflictError("This request has expired");
        }

        const approved = input.decision === "approve";
        const newLimit =
          approval.kind === "budget" && approved
            ? await applyBudgetIncrease(tx, approval, input.newLimit)
            : undefined;
        await tx
          .update(approvals)
          .set({
            status: approved ? "approved" : "rejected",
            decidedBy: actor.userId,
            decidedAt: new Date(),
            comment: input.comment ?? null,
          })
          .where(eq(approvals.id, approvalId));
        await recordAudit(tx, {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          action: "approval.decide",
          resourceType: "approval",
          resourceId: approvalId,
          metadata: {
            runId: approval.runId,
            kind: approval.kind,
            decision: input.decision,
            newLimit,
          },
          meta,
        });
        // Declining more budget ends the run; any other decision lets it continue.
        return settleRun(
          tx,
          approval.runId,
          approval.kind === "budget" && !approved
            ? {
                code: "BUDGET_REJECTED",
                message: "A reviewer declined to increase the run's budget",
              }
            : undefined,
        );
      });
      await announce(outcome);
      return { id: approvalId, status: input.decision === "approve" ? "approved" : "rejected" };
    },

    /** Withdraws a run's pending approvals (used when the run is cancelled). */
    async withdrawForRun(runId: string) {
      await db
        .update(approvals)
        .set({ status: "rejected", comment: "Run cancelled", decidedAt: new Date() })
        .where(and(eq(approvals.runId, runId), eq(approvals.status, "pending")));
    },

    /** Expires overdue requests: like a rejection (budget → run fails; tool call → denied). */
    async expireStale(): Promise<number> {
      const stale = await db
        .update(approvals)
        .set({ status: "expired" })
        .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, new Date())))
        .returning();
      for (const approval of stale) {
        const outcome = await settleRun(
          db,
          approval.runId,
          approval.kind === "budget"
            ? { code: "APPROVAL_EXPIRED", message: "Nobody approved more budget in time" }
            : undefined,
        );
        await announce(outcome);
      }
      return stale.length;
    },
  };
}

export type ApprovalsService = ReturnType<typeof createApprovalsService>;
