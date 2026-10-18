import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbExecutor } from "../../infrastructure/database/client.js";
import {
  claimEvidence,
  claimJudgments,
  claims,
  feedback,
  runScorecards,
} from "../../infrastructure/database/schema/index.js";

/** Reads for the report view: the scorecard, each claim with its verdict, and my feedback. */

export async function findScorecard(db: DbExecutor, organizationId: string, runId: string) {
  const [row] = await db
    .select()
    .from(runScorecards)
    .where(and(eq(runScorecards.runId, runId), eq(runScorecards.organizationId, organizationId)));
  if (!row) return null;
  return {
    id: row.id,
    runId: row.runId,
    reportId: row.reportId,
    claimSupportRate: row.claimSupportRate,
    citationAccuracy: row.citationAccuracy,
    citationValidity: row.citationValidity,
    sourceReliability: row.sourceReliability,
    coverage: row.coverage,
    taskCompletion: row.taskCompletion,
    policyCompliant: row.policyCompliant,
    passed: row.passed,
    latencyMs: row.latencyMs,
    costUsd: row.costUsd,
    extra: row.extra,
    createdAt: row.createdAt,
  };
}

/** The claims of one report in order, with citations, the judge's verdict and the user's rating. */
export async function listJudgedClaims(
  db: DbExecutor,
  organizationId: string,
  reportId: string,
  userId: string,
) {
  const rows = await db
    .select({
      id: claims.id,
      position: claims.position,
      section: claims.section,
      text: claims.text,
    })
    .from(claims)
    .where(and(eq(claims.reportId, reportId), eq(claims.organizationId, organizationId)))
    .orderBy(asc(claims.position));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [links, judgments, ratings] = await Promise.all([
    db
      .select({ claimId: claimEvidence.claimId, number: claimEvidence.citationNumber })
      .from(claimEvidence)
      .where(inArray(claimEvidence.claimId, ids))
      .orderBy(asc(claimEvidence.citationNumber)),
    db
      .select()
      .from(claimJudgments)
      .where(inArray(claimJudgments.claimId, ids))
      .orderBy(asc(claimJudgments.createdAt)),
    db
      .select({ claimId: feedback.claimId, rating: feedback.rating })
      .from(feedback)
      .where(and(inArray(feedback.claimId, ids), eq(feedback.userId, userId))),
  ]);
  return rows.map((claim) => {
    // The latest judgment wins (a resumed run may have judged twice before cleanup).
    const j = judgments.filter((x) => x.claimId === claim.id).at(-1);
    return {
      ...claim,
      citations: links.filter((l) => l.claimId === claim.id).map((l) => l.number),
      judgment: j
        ? {
            verdict: j.verdict,
            citationAccurate: j.citationAccurate,
            citations: j.citations,
            rationale: j.rationale,
            judgeModel: j.judgeModel,
          }
        : null,
      myRating: ratings.find((r) => r.claimId === claim.id)?.rating ?? null,
    };
  });
}

export async function findReportRating(db: DbExecutor, reportId: string, userId: string) {
  const [row] = await db
    .select({ rating: feedback.rating, comment: feedback.comment })
    .from(feedback)
    .where(
      and(eq(feedback.reportId, reportId), eq(feedback.userId, userId), isNull(feedback.claimId)),
    );
  return row ?? null;
}
