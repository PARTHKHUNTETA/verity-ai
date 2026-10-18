import type { FakeOptions, ToolLoopItem } from "../../infrastructure/llm/index.js";
import { fakeClaimJudgments, fakeTaskCompletion } from "../evaluation/fakes.js";
import { keywords } from "../tools/search.tool.js";
import type { EvidenceExtraction } from "./prompts/extract.js";
import type { ResearchPlan } from "./prompts/plan.js";

/**
 * Deterministic stand-ins for every LLM step of the pipeline, used when LLM_PROVIDER=fake
 * (local development without an API key) and in tests. They read the same prompt formats the
 * real model gets, so the whole pipeline (planning, extraction, the code tool loop, the report)
 * runs end to end. They don't reason; they make the plumbing visible.
 */

export function fakePlan(input: string): ResearchPlan {
  const question = input.match(/Research question:\n(.+)/)?.[1]?.trim() ?? input;
  const topic = keywords(question, 4).join(" ") || question.slice(0, 40);
  return {
    title: `Research brief: ${topic}`,
    subQuestions: [
      {
        question: `What is the current state of ${topic}?`,
        rationale: "Establishes the baseline.",
        searchQueries: [topic],
      },
      {
        question: `Which approaches to ${topic} exist and how do they compare?`,
        rationale: "The comparison the question asks for.",
        searchQueries: [`${topic} comparison`],
      },
      {
        question: `What open problems and research gaps remain in ${topic}?`,
        rationale: "Identifies gaps.",
        searchQueries: [`${topic} challenges`],
      },
    ],
  };
}

/** Quotes the first real sentence of each passage, verbatim. */
export function fakeEvidence(input: string): EvidenceExtraction {
  const blocks = [...input.matchAll(/^\[P(\d+)\][^\n]*\n([\s\S]*?)(?=\n\n\[P\d+\]|(?![\s\S]))/gm)];
  const evidence = blocks.slice(0, 3).flatMap(([, n, text], i) => {
    const sentence = text!
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join(" ")
      .match(/[A-Z][^.!?]{20,280}[.!?]/)?.[0];
    return sentence
      ? [
          {
            passage: Number(n),
            quote: sentence,
            stance: "supports" as const,
            confidence: Math.max(0.5, 0.8 - i * 0.1),
            note: "First claim of the passage.",
          },
        ]
      : [];
  });
  return { evidence };
}

const FAKE_ANALYSIS_CODE = `({
  evidencePerSubQuestion: countBy(data.evidence, "subQuestion"),
  stances: countBy(data.evidence, "stance"),
  distinctSources: Object.keys(countBy(data.evidence, "source")).length,
  averageConfidence: round(mean(data.evidence.map((e) => e.confidence)))
})`;

/** Calls run_code once, then summarizes the result. */
export function fakeToolTurn(items: ToolLoopItem[]) {
  const lastResult = [...items].reverse().find((i) => i.type === "tool_result");
  if (!lastResult) {
    return {
      text: "",
      toolCalls: [
        {
          name: "run_code",
          arguments: {
            purpose: "Count evidence per sub-question and stance",
            code: FAKE_ANALYSIS_CODE,
          },
        },
      ],
    };
  }
  const outcome = JSON.parse(lastResult.output) as {
    ok: boolean;
    result?: Record<string, unknown>;
  };
  const r = (outcome.result ?? {}) as {
    distinctSources?: number;
    averageConfidence?: number;
    stances?: Record<string, number>;
  };
  return {
    text: outcome.ok
      ? [
          `- The evidence comes from ${r.distinctSources ?? "?"} distinct sources (computed with run_code) [1].`,
          `- Stances: ${JSON.stringify(r.stances ?? {})}; average confidence ${r.averageConfidence ?? "?"}.`,
        ].join("\n")
      : "- The analysis code failed, so no numbers were computed.",
    toolCalls: [],
  };
}

/** Builds the report structure from the evidence block of the report prompt. */
export function fakeReport(input: string): string {
  const title = input.match(/Report title:\n(.+)/)?.[1] ?? "Research report";
  const subQuestions = [...input.matchAll(/^Q(\d+)\. (.+)$/gm)].map(([, n, q]) => ({
    n: Number(n),
    q: q!,
  }));
  const evidence = [
    ...input.matchAll(/^\[(\d+)\] \(Q(\d+), (\w+), [\d.]+\) "(.+)" — ([^,\n]+)/gm),
  ].map(([, n, q, stance, quote, source]) => ({
    n: Number(n),
    q: Number(q),
    stance: stance!,
    quote: quote!,
    source: source!,
  }));
  const analysis = input.match(/Analysis notes:\n([\s\S]+)$/)?.[1]?.trim();

  const findings = subQuestions.map(({ n, q }) => {
    const items = evidence.filter((e) => e.q === n);
    const body = items.length
      ? items
          .map((e) => `${e.source} reports: ${e.quote.replace(/[.!?]$/, "")} [${e.n}].`)
          .join(" ")
      : "No evidence was found for this sub-question.";
    return `### ${q}\n\n${body}`;
  });
  const sources = [...new Set(evidence.map((e) => e.source))];
  const table = sources.length
    ? [
        "| Source | Evidence | Stance |",
        "|---|---|---|",
        ...sources.map((s) => {
          const items = evidence.filter((e) => e.source === s);
          return `| ${s} | ${items.map((e) => `[${e.n}]`).join(" ")} | ${[...new Set(items.map((e) => e.stance))].join(", ")} |`;
        }),
      ].join("\n")
    : "Nothing to compare: no evidence was found.";
  const missing = subQuestions.filter(({ n }) => !evidence.some((e) => e.q === n));

  const report = [
    `# ${title}`,
    "## Summary",
    evidence.length
      ? `This brief draws on ${evidence.length} quotes from ${sources.length} sources [${evidence[0]!.n}]. It was written by the fake LLM provider, which restates evidence instead of reasoning about it.`
      : "No evidence was found in the available sources. This brief was written by the fake LLM provider.",
    "## Findings",
    ...findings,
    "## Comparison",
    table,
    ...(analysis ? ["", "**Analysis notes**", analysis] : []),
    "## Research gaps",
    missing.length
      ? missing.map((m) => `- No evidence found for: ${m.q}`).join("\n")
      : "- Every sub-question has some evidence, but a real model would weigh conflicting sources here.",
    "## Limitations",
    "- Generated by the fake provider (LLM_PROVIDER=fake). Set LLM_PROVIDER=openai for real analysis.",
  ].join("\n\n");

  // Revision (Phase 10): a real model rewrites flagged claims; the fake just stops citing them.
  const flagged = [...input.matchAll(/^- "(.+)" \((?:partial|unsupported): /gm)].map((m) => m[1]!);
  return flagged.length ? uncite(report, flagged) : report;
}

const CITATION_MARK = /\s*\[\d+(?:\s*,\s*\d+)*\]/g;
const normalize = (s: string) =>
  s
    .replace(CITATION_MARK, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
    .replace(/[*_`]/g, "") // as claim extraction strips Markdown
    .replace(/\|/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Removes the citation markers from every sentence whose text is one of `claims`. */
function uncite(report: string, claims: string[]): string {
  const targets = new Set(claims.map(normalize));
  return report
    .split("\n")
    .map((line) => {
      if (targets.has(normalize(line))) return line.replace(CITATION_MARK, "");
      return line
        .split(/(?<=[.!?](?:\s*\[\d+(?:\s*,\s*\d+)*\])*)\s+(?=[A-Z0-9"'(*_])/)
        .map((sentence) =>
          targets.has(normalize(sentence)) ? sentence.replace(CITATION_MARK, "") : sentence,
        )
        .join(" ");
    })
    .join("\n");
}

export const researchFakes: FakeOptions = {
  answer: fakeReport,
  objects: {
    research_plan: fakePlan,
    evidence_extraction: fakeEvidence,
    claim_judgments: fakeClaimJudgments,
    task_completion: fakeTaskCompletion,
  },
  toolTurn: fakeToolTurn,
};
