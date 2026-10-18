import type { ClaimJudgmentsOutput } from "./prompts/claim-judge.js";
import type { RequiredPointsOutput } from "./prompts/points-judge.js";
import type { TaskCompletionJudgment } from "./scorers/task-completion.js";

/**
 * Deterministic stand-in judges for LLM_PROVIDER=fake and tests. A real judge reads for
 * meaning; this one measures word overlap: how many of the claim's content words appear in
 * the quote. Crude, but it reliably catches the classic failure: a citation stapled to a
 * sentence the quote never says.
 */

const STOP = new Set(
  "a an and are as at be been but by can for from has have in into is it its of on or that the their them they this to was were which with not also than then these those there such more most other only over about after before between both each very will would could should what when where while how".split(
    " ",
  ),
);

export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/** Share of the claim's content words found in the quote, 0–1. */
export function overlap(claim: string, quote: string): number {
  const c = contentWords(claim);
  if (!c.size) return 0;
  const q = contentWords(quote);
  return [...c].filter((w) => q.has(w)).length / c.size;
}

export function fakeClaimJudgments(input: string): ClaimJudgmentsOutput {
  const blocks = [...input.matchAll(/^\[C(\d+)\] (.+)\n((?: {2}\[\d+\] .+\n?)+)/gm)];
  return {
    judgments: blocks.map(([, n, text, quoteLines]) => {
      const citations = [...quoteLines!.matchAll(/^ {2}\[(\d+)\] "(.*)" — /gm)].map(
        ([, num, quote]) => {
          const score = overlap(text!, quote!);
          return { number: Number(num), supports: score >= 0.5, score };
        },
      );
      const best = Math.max(0, ...citations.map((c) => c.score));
      const verdict = best >= 0.5 ? "supported" : best >= 0.25 ? "partial" : "unsupported";
      return {
        claim: Number(n),
        verdict,
        citations: citations.map(({ number, supports }) => ({ number, supports })),
        rationale: `${Math.round(best * 100)}% of the claim's key words appear in the best cited quote (fake judge).`,
      };
    }),
  };
}

export function fakeTaskCompletion(input: string): TaskCompletionJudgment {
  const planned = [...input.matchAll(/^Q(\d+)\. (.+)$/gm)].map(([, , q]) => q!);
  const report = input.match(/Report:\n<<<\n([\s\S]*)\n>>>/)?.[1] ?? "";
  // The fake report writes this sentence under every sub-question it has nothing for.
  const sections = report.split(/^### /m).slice(1);
  const missing = planned.filter((q) => {
    const section = sections.find((s) => s.startsWith(q));
    return !section || /No evidence was found/.test(section);
  });
  const score = planned.length ? (planned.length - missing.length) / planned.length : 0;
  return {
    score,
    missing: missing.slice(0, 5),
    rationale: `${planned.length - missing.length} of ${planned.length} planned sub-questions are answered (fake judge).`,
  };
}

/** A point counts as covered when most of its content words appear in one report sentence. */
export function fakeRequiredPoints(input: string): RequiredPointsOutput {
  const points = [...input.matchAll(/^\[R(\d+)\] (.+)$/gm)].map(([, n, text]) => ({
    n: Number(n),
    text: text!,
  }));
  const report = input.match(/Report:\n<<<\n([\s\S]*)\n>>>/)?.[1] ?? "";
  const sentences = report.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  return {
    points: points.map(({ n, text }) => {
      const best = sentences
        .map((s) => ({ s, score: overlap(text, s) }))
        .sort((a, b) => b.score - a.score)[0];
      const covered = (best?.score ?? 0) >= 0.6;
      return { point: n, covered, quote: covered ? best!.s.trim() : "" };
    }),
  };
}
