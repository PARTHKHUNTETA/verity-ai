import { describe, expect, it } from "vitest";
import {
  citationAccuracy,
  citationValidity,
  claimSupport,
  contradictionHandling,
  coverage,
  meanReliability,
  policyCompliance,
  sourceReliability,
  taskCompletionScore,
} from "./scorers/index.js";

describe("claim support", () => {
  it("counts supported as 1 and partial as 0.5", () => {
    expect(claimSupport(["supported", "partial", "unsupported", "supported"])).toEqual({
      rate: 0.625,
      total: 4,
      supported: 2,
      partial: 1,
      unsupported: 1,
    });
  });

  it("scores a report without cited claims as 0", () => {
    expect(claimSupport([]).rate).toBe(0);
  });
});

describe("citation accuracy", () => {
  it("is computed per citation, not per claim", () => {
    const result = citationAccuracy([
      { citations: [{ supports: true }, { supports: false }] },
      { citations: [{ supports: true }] },
    ]);
    expect(result).toEqual({ rate: 2 / 3, total: 3, supporting: 2 });
  });

  it("is null without citations", () => {
    expect(citationAccuracy([]).rate).toBeNull();
  });
});

describe("citation validity", () => {
  it("is 1 when every citation resolves", () => {
    expect(citationValidity({ linked: 5, unresolvable: 0, invalidNumbers: [] })).toBe(1);
  });

  it("penalizes hallucinated numbers and deleted sources", () => {
    expect(citationValidity({ linked: 4, unresolvable: 1, invalidNumbers: [42] })).toBe(3 / 5);
  });

  it("is null when nothing is cited", () => {
    expect(citationValidity({ linked: 0, unresolvable: 0, invalidNumbers: [] })).toBeNull();
  });
});

describe("coverage", () => {
  it("weights answered 1, partial 0.5, unanswered 0", () => {
    expect(coverage(["answered", "partial", "unanswered", "answered"])).toBe(0.625);
  });

  it("is null without a plan", () => {
    expect(coverage([])).toBeNull();
  });
});

describe("contradiction handling", () => {
  const evidence = [
    { id: "a", stance: "supports" },
    { id: "b", stance: "contradicts" },
    { id: "c", stance: "contradicts" },
  ];

  it("is the share of contradicting evidence the report cites", () => {
    expect(contradictionHandling(evidence, new Set(["a", "b"]))).toBe(0.5);
  });

  it("is null when nothing contradicts", () => {
    expect(contradictionHandling([{ id: "a", stance: "supports" }], new Set())).toBeNull();
  });
});

describe("policy compliance", () => {
  it("accepts allowed calls, approved calls and calls that never ran", () => {
    expect(
      policyCompliance([
        { tool: "rag", status: "succeeded", decisions: ["allow"], approval: null },
        {
          tool: "fetch",
          status: "succeeded",
          decisions: ["require_approval", "allow"],
          approval: "approved",
        },
        { tool: "fetch", status: "denied", decisions: ["deny"], approval: null },
        {
          tool: "run_code",
          status: "awaiting_approval",
          decisions: ["require_approval"],
          approval: "pending",
        },
      ]),
    ).toEqual({ compliant: true, violations: [] });
  });

  it("flags calls that ran after a deny or without any decision", () => {
    const result = policyCompliance([
      { tool: "fetch", status: "succeeded", decisions: ["deny"], approval: null },
      { tool: "web_search", status: "failed", decisions: [], approval: null },
    ]);
    expect(result.compliant).toBe(false);
    expect(result.violations).toEqual([
      "fetch ran although the policy denied it",
      "web_search ran without an allow decision or an approval",
    ]);
  });
});

describe("source reliability", () => {
  const now = new Date("2026-10-18");
  const web = (domain: string, extra: object = {}) =>
    sourceReliability({ type: "web", domain, doi: null, publishedAt: null, ...extra }, now);

  it("ranks publishers by editorial accountability", () => {
    expect(web("www.nature.com").score).toBe(0.9);
    expect(web("arxiv.org").score).toBe(0.75);
    expect(web("cs.stanford.edu").score).toBe(0.85);
    expect(web("en.wikipedia.org").score).toBe(0.65);
    expect(web("example.com").score).toBe(0.6);
    expect(web("someone.medium.com").score).toBe(0.4);
  });

  it("trusts a DOI, and the team's own uploads", () => {
    expect(web("example.com", { doi: "10.1/x" }).score).toBe(0.85);
    expect(
      sourceReliability({ type: "upload", domain: null, doi: null, publishedAt: null }).score,
    ).toBe(0.8);
  });

  it("marks sources older than 10 years down, except uploads", () => {
    const old = web("www.nature.com", { publishedAt: "2010-01-01" });
    expect(old).toEqual({ score: 0.8, reason: "Peer-reviewed publisher; over 10 years old" });
    expect(
      sourceReliability({ type: "upload", domain: null, doi: null, publishedAt: "2001-01-01" }, now)
        .score,
    ).toBe(0.8);
  });

  it("averages cited sources", () => {
    expect(meanReliability([0.9, 0.6])).toBe(0.75);
    expect(meanReliability([])).toBeNull();
  });
});

describe("task completion", () => {
  it("clamps and normalizes the judge's score", () => {
    expect(taskCompletionScore({ score: 0.834, missing: [], rationale: "" })).toBe(0.83);
    expect(taskCompletionScore({ score: 80, missing: [], rationale: "" })).toBe(0.8);
  });
});
