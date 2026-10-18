import { describe, expect, it } from "vitest";
import { fakeClaimJudgments, fakeTaskCompletion, overlap } from "./fakes.js";
import {
  buildClaimJudgeInput,
  claimJudgmentsSchema,
  parseClaimJudgments,
} from "./prompts/claim-judge.js";
import { buildTaskJudgeInput } from "./prompts/task-judge.js";

describe("parseClaimJudgments", () => {
  const claims = [
    { number: 1, citations: [3, 4] },
    { number: 2, citations: [5] },
    { number: 3, citations: [6] },
  ];

  it("maps judgments to claims and citations", () => {
    const parsed = parseClaimJudgments(
      {
        judgments: [
          {
            claim: 1,
            verdict: "supported",
            citations: [
              { number: 3, supports: true },
              { number: 4, supports: false },
            ],
            rationale: "Quote [3] states it.",
          },
          {
            claim: 2,
            verdict: "unsupported",
            citations: [{ number: 5, supports: false }],
            rationale: "Off topic.",
          },
          {
            claim: 3,
            verdict: "supported",
            citations: [{ number: 6, supports: true }],
            rationale: "Yes.",
          },
        ],
      },
      claims,
    );
    expect(parsed.get(1)).toEqual({
      verdict: "supported",
      citations: [
        { number: 3, supports: true },
        { number: 4, supports: false },
      ],
      citationAccurate: false,
      rationale: "Quote [3] states it.",
    });
    expect(parsed.get(2)).toMatchObject({ verdict: "unsupported", citationAccurate: false });
    expect(parsed.get(3)).toMatchObject({ verdict: "supported", citationAccurate: true });
  });

  it("treats skipped claims as unsupported and ignores unknown or duplicate ones", () => {
    const parsed = parseClaimJudgments(
      {
        judgments: [
          { claim: 9, verdict: "supported", citations: [], rationale: "Not asked." },
          {
            claim: 2,
            verdict: "partial",
            citations: [{ number: 5, supports: true }],
            rationale: "First.",
          },
          {
            claim: 2,
            verdict: "supported",
            citations: [{ number: 5, supports: true }],
            rationale: "Dup.",
          },
        ],
      },
      claims,
    );
    expect([...parsed.keys()]).toEqual([1, 2, 3]);
    expect(parsed.get(1)).toEqual({
      verdict: "unsupported",
      citations: [
        { number: 3, supports: false },
        { number: 4, supports: false },
      ],
      citationAccurate: false,
      rationale: "The judge returned no verdict for this claim.",
    });
    expect(parsed.get(2)).toMatchObject({ verdict: "partial", rationale: "First." });
  });

  it("ignores citations the claim doesn't have and downgrades inconsistent verdicts", () => {
    const parsed = parseClaimJudgments(
      {
        judgments: [
          {
            claim: 2,
            verdict: "supported",
            citations: [{ number: 99, supports: true }],
            rationale: "Sure.",
          },
        ],
      },
      [{ number: 2, citations: [5] }],
    );
    expect(parsed.get(2)).toEqual({
      verdict: "partial",
      citations: [{ number: 5, supports: false }],
      citationAccurate: false,
      rationale: "Sure. (No single cited quote supports it on its own.)",
    });
  });

  it("rejects malformed judge output at the schema", () => {
    expect(
      claimJudgmentsSchema.safeParse({ judgments: [{ claim: 1, verdict: "maybe" }] }).success,
    ).toBe(false);
  });
});

describe("fake judges", () => {
  const input = buildClaimJudgeInput("How do agents plan?", [
    {
      number: 1,
      text: "ReAct agents interleave reasoning traces with tool calls.",
      citations: [
        {
          number: 1,
          quote:
            "ReAct agents interleave reasoning traces with tool calls, which lets them update plans.",
          source: "notes.md (your documents)",
        },
      ],
    },
    {
      number: 2,
      text: "The brief draws on 7 quotes from 3 sources.",
      citations: [
        {
          number: 1,
          quote: "ReAct agents interleave reasoning traces with tool calls.",
          source: "notes.md (your documents)",
        },
      ],
    },
  ]);

  it("accept a claim its quote states and reject a citation stapled to an unrelated sentence", () => {
    const { judgments } = fakeClaimJudgments(input);
    expect(judgments.map((j) => [j.claim, j.verdict])).toEqual([
      [1, "supported"],
      [2, "unsupported"],
    ]);
    expect(claimJudgmentsSchema.safeParse({ judgments }).success).toBe(true);
  });

  it("measures word overlap on content words only", () => {
    expect(overlap("The agents plan.", "agents plan ahead")).toBe(1);
    expect(overlap("", "anything")).toBe(0);
  });

  it("scores task completion from the answered sub-questions", () => {
    const result = fakeTaskCompletion(
      buildTaskJudgeInput({
        question: "Q",
        instructions: null,
        subQuestions: ["What is A?", "What is B?"],
        report:
          "# T\n\n## Findings\n\n### What is A?\n\nA is a thing [1].\n\n### What is B?\n\nNo evidence was found for this sub-question.",
      }),
    );
    expect(result).toMatchObject({ score: 0.5, missing: ["What is B?"] });
  });
});
