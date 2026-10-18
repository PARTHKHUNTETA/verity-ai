import { asc, eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import {
  claimJudgments,
  claims,
  reports,
  researchRuns,
  runScorecards,
} from "../../infrastructure/database/schema/index.js";
import { LlmError } from "../../infrastructure/llm/index.js";
import { app, bearer, registerUser, resetDatabase } from "../../tests/helpers.js";
import { buildRuntime, ownerWithNotes, queueRun } from "../../tests/research-setup.js";
import { fakeReport, researchFakes } from "../agent/fakes.js";

beforeEach(resetDatabase);

async function scorecardOf(runId: string) {
  const [row] = await db.select().from(runScorecards).where(eq(runScorecards.runId, runId));
  return row!;
}

async function reportsOf(runId: string) {
  return db.select().from(reports).where(eq(reports.runId, runId)).orderBy(asc(reports.version));
}

/** A report that only restates its evidence, citing each quote: every claim is supported. */
function strongReport(input: string): string {
  const quotes = [...input.matchAll(/^\[(\d+)\] \([^)]*\) "(.+)" — /gm)].map(
    ([, n, quote]) => `${quote!.replace(/[.!?]$/, "")} [${n}].`,
  );
  return `# Strong report\n\n## Findings\n\n${quotes.join(" ")}`;
}

/** Claims whose citations have nothing to do with the quotes. */
const JUNK =
  "Quantum annealers will replace every research team by 2027 [1]. Bananas are the leading cause of benchmark inflation [1].";

describe("online evaluation", () => {
  it("gives every completed run a scorecard, judged claims and source reliability", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run).toMatchObject({ status: "completed", stage: "evaluating" });
    const scorecard = await scorecardOf(runId);
    expect(scorecard).toMatchObject({
      citationValidity: 1,
      sourceReliability: 0.8, // the uploaded notes
      policyCompliant: true,
    });
    expect(scorecard.latencyMs).toBeGreaterThan(0);
    expect(scorecard.extra.sources).toEqual([
      expect.objectContaining({ title: "Notes on AI Agents", score: 0.8 }),
    ]);

    // Every claim of the report that is shown has a judgment.
    const shown = (await reportsOf(runId)).find((r) => r.status === "final")!;
    expect(scorecard.reportId).toBe(shown.id);
    const judged = await db
      .select({ verdict: claimJudgments.verdict, judgeModel: claimJudgments.judgeModel })
      .from(claims)
      .leftJoin(claimJudgments, eq(claimJudgments.claimId, claims.id))
      .where(eq(claims.reportId, shown.id));
    expect(judged.length).toBeGreaterThan(0);
    expect(judged.every((j) => j.verdict && j.judgeModel === "fake-model")).toBe(true);

    // The API serves it with the run, and on its own.
    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(detail.body.report.id).toBe(shown.id);
    expect(detail.body.evaluation.scorecard).toMatchObject({ reportId: shown.id });
    expect(detail.body.evaluation.scorecard).not.toHaveProperty("organizationId");
    expect(detail.body.evaluation.claims[0]).toMatchObject({
      citations: [expect.any(Number)],
      judgment: { verdict: expect.any(String), rationale: expect.any(String) },
      myRating: null,
    });
    const card = await request(app)
      .get(`/api/v1/research/runs/${runId}/scorecard`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(card.body.scorecard.id).toBe(scorecard.id);
  });

  it("flags a weak report, revises it once, and keeps the revision when it scores better", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    // First draft: the fake report plus two junk claims. The revision is the fake report,
    // which drops the citations of the claims the judge flagged.
    const { runtime, events } = buildRuntime({
      ...researchFakes,
      answer: (input) =>
        input.includes("Flagged claims:") ? fakeReport(input) : `${fakeReport(input)}\n\n${JUNK}`,
    });
    await runtime.runResearch(runId);

    const [v1, v2] = await reportsOf(runId);
    expect(v1).toMatchObject({ version: 1, status: "superseded" });
    expect(v2).toMatchObject({ version: 2, status: "final" });
    expect(v2!.contentMd).not.toContain("Quantum annealers");

    const scorecard = await scorecardOf(runId);
    expect(scorecard.reportId).toBe(v2!.id);
    const before = scorecard.extra.revision!.before.claimSupportRate!;
    expect(before).toBeLessThan(0.9);
    expect(scorecard.claimSupportRate!).toBeGreaterThan(before);
    expect(scorecard.extra.revision).toMatchObject({ fromReportId: v1!.id, kept: "revised" });

    // The weak draft's judgments are kept: the junk was caught as unsupported.
    const v1Judged = await db
      .select({ text: claims.text, verdict: claimJudgments.verdict })
      .from(claims)
      .innerJoin(claimJudgments, eq(claimJudgments.claimId, claims.id))
      .where(eq(claims.reportId, v1!.id));
    expect(v1Judged.filter((c) => /Quantum|Bananas/.test(c.text))).toEqual([
      expect.objectContaining({ verdict: "unsupported" }),
      expect.objectContaining({ verdict: "unsupported" }),
    ]);

    // The revision streamed as report version 2.
    const versions = new Set(
      events.published.flatMap((e) => (e.type === "delta" ? [e.version] : [])),
    );
    expect(versions).toEqual(new Set([1, 2]));
  });

  it("does not revise a report whose claims are supported", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime({ ...researchFakes, answer: strongReport }).runtime.runResearch(runId);

    expect(await reportsOf(runId)).toHaveLength(1);
    const scorecard = await scorecardOf(runId);
    expect(scorecard).toMatchObject({ claimSupportRate: 1, citationAccuracy: 1 });
    expect(scorecard.extra.revision).toBeUndefined();
  });

  it("keeps the original when the revision scores worse", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime({
      ...researchFakes,
      answer: (input) =>
        input.includes("Flagged claims:") ? `# Worse\n\n${JUNK}` : `${strongReport(input)} ${JUNK}`,
    }).runtime.runResearch(runId);

    const [v1, v2] = await reportsOf(runId);
    expect(v1).toMatchObject({ status: "final" });
    expect(v2).toMatchObject({ status: "superseded" });
    const scorecard = await scorecardOf(runId);
    expect(scorecard.reportId).toBe(v1!.id);
    expect(scorecard.extra.revision).toMatchObject({ kept: "original" });
    expect(scorecard.claimSupportRate).toBe(scorecard.extra.revision!.before.claimSupportRate);

    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(detail.body.report.id).toBe(v1!.id);
    // Coverage follows the version shown (v1 cites the evidence, v2 doesn't).
    expect(detail.body.subQuestions.map((s: { coverage: string }) => s.coverage)).toContain(
      "answered",
    );
  });

  it("still completes with a partial scorecard when the judge fails", async () => {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime({
      ...researchFakes,
      objects: {
        ...researchFakes.objects,
        claim_judgments: () => {
          throw new LlmError("The judge is unavailable", "UPSTREAM", true);
        },
      },
    }).runtime.runResearch(runId);

    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.id, runId));
    expect(run!.status).toBe("completed");
    const scorecard = await scorecardOf(runId);
    expect(scorecard).toMatchObject({
      claimSupportRate: null,
      citationAccuracy: null,
      citationValidity: 1,
      passed: false,
    });
    expect(scorecard.extra.judgeError).toContain("The judge is unavailable");
    expect(await reportsOf(runId)).toHaveLength(1); // no revision without verdicts
  });
});

describe("feedback", () => {
  async function evaluatedRun() {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);
    const detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    return {
      owner,
      runId,
      reportId: detail.body.report.id as string,
      claimId: detail.body.evaluation.claims[0].id as string,
    };
  }

  it("records, updates and removes a rating on a report and on a claim", async () => {
    const { owner, runId, reportId, claimId } = await evaluatedRun();
    const rate = (body: object) =>
      request(app).post("/api/v1/feedback").set("Authorization", bearer(owner)).send(body);

    await rate({ reportId, rating: 1, comment: "Useful" }).expect(200, {
      rating: 1,
      comment: "Useful",
    });
    await rate({ reportId, claimId, rating: -1 }).expect(200);
    await rate({ reportId, claimId, rating: 1 }).expect(200); // changes the same rating

    let detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    expect(detail.body.evaluation.myReportRating).toEqual({ rating: 1, comment: "Useful" });
    expect(detail.body.evaluation.claims[0].myRating).toBe(1);

    await rate({ reportId, claimId, rating: 0 }).expect(200, { rating: null, comment: null });
    detail = await request(app)
      .get(`/api/v1/research/runs/${runId}`)
      .set("Authorization", bearer(owner));
    expect(detail.body.evaluation.claims[0].myRating).toBeNull();
    expect(detail.body.evaluation.myReportRating).toMatchObject({ rating: 1 });
  });

  it("rejects invalid ratings and other organizations' reports", async () => {
    const { reportId } = await evaluatedRun();
    const other = await registerUser("other@example.com");
    await request(app)
      .post("/api/v1/feedback")
      .set("Authorization", bearer(other))
      .send({ reportId, rating: 1 })
      .expect(404);
    await request(app)
      .post("/api/v1/feedback")
      .set("Authorization", bearer(other))
      .send({ reportId, rating: 5 })
      .expect(400);
  });
});
