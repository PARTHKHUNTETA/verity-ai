import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { claims, feedback, reports } from "../../infrastructure/database/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";
import type { AuthContext } from "../auth/auth.types.js";

/**
 * Thumbs up/down from readers, on a whole report or on one claim. Human feedback is the check
 * on the judge: claims the judge accepted but readers reject are where the judge is too lenient.
 * One rating per user and target; rating 0 removes it.
 */
export type FeedbackInput = {
  reportId: string;
  claimId?: string | null;
  rating: -1 | 0 | 1;
  comment?: string | null;
};

export function createFeedbackService(db: Database) {
  return {
    async rate(actor: AuthContext, input: FeedbackInput) {
      const [report] = await db
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(eq(reports.id, input.reportId), eq(reports.organizationId, actor.organizationId)),
        );
      if (!report) throw new NotFoundError("Report not found");
      const claimId = input.claimId ?? null;
      if (claimId) {
        const [claim] = await db
          .select({ id: claims.id })
          .from(claims)
          .where(and(eq(claims.id, claimId), eq(claims.reportId, report.id)));
        if (!claim) throw new NotFoundError("Claim not found in this report");
      }

      const target = and(
        eq(feedback.userId, actor.userId),
        eq(feedback.reportId, report.id),
        claimId ? eq(feedback.claimId, claimId) : isNull(feedback.claimId),
      );
      if (input.rating === 0) {
        await db.delete(feedback).where(target);
        return { rating: null, comment: null };
      }
      const [row] = await db
        .insert(feedback)
        .values({
          organizationId: actor.organizationId,
          userId: actor.userId,
          reportId: report.id,
          claimId,
          rating: input.rating,
          comment: input.comment ?? null,
        })
        .onConflictDoUpdate({
          target: [feedback.userId, feedback.reportId, feedback.claimId],
          set: { rating: input.rating, comment: input.comment ?? null, updatedAt: new Date() },
        })
        .returning({ rating: feedback.rating, comment: feedback.comment });
      return row!;
    },
  };
}
