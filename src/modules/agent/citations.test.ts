import { describe, expect, it } from "vitest";
import { extractClaims } from "./citations.js";

const valid = new Set([1, 2, 3]);

describe("extractClaims", () => {
  it("turns cited sentences into claims with their section", () => {
    const md = [
      "## Summary",
      "",
      "RAG grounds answers in documents [1]. It reduces hallucinations [2, 3].",
      "This sentence has no citation.",
      "",
      "## Key points",
      "",
      "- **Hybrid search** beats either method alone [3].",
    ].join("\n");

    const { claims, invalidCitations } = extractClaims(md, valid);
    expect(claims).toEqual([
      {
        position: 1,
        section: "Summary",
        text: "RAG grounds answers in documents.",
        citations: [1],
      },
      { position: 2, section: "Summary", text: "It reduces hallucinations.", citations: [2, 3] },
      {
        position: 3,
        section: "Key points",
        text: "Hybrid search beats either method alone.",
        citations: [3],
      },
    ]);
    expect(invalidCitations).toEqual([]);
  });

  it("handles citations placed after the period", () => {
    const { claims } = extractClaims(
      "Agents plan before acting. [1] They also reflect. [2]",
      valid,
    );
    expect(claims.map((c) => [c.text, c.citations])).toEqual([
      ["Agents plan before acting.", [1]],
      ["They also reflect.", [2]],
    ]);
  });

  it("reports citation numbers the model was never given", () => {
    const { claims, invalidCitations } = extractClaims("A fact [1, 7]. Another [9].", valid);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.citations).toEqual([1]);
    expect(invalidCitations.sort()).toEqual([7, 9]);
  });

  it("ignores code blocks", () => {
    const { claims } = extractClaims("```\narray[1] = 2.\n```\nReal claim [1].", valid);
    expect(claims.map((c) => c.text)).toEqual(["Real claim."]);
  });
});
