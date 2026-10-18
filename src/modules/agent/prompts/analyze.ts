export const ANALYZE_PROMPT_VERSION = "analyze-v1";

/** At most this many model turns and code runs in the analysis tool loop. */
export const MAX_ANALYSIS_TURNS = 4;
export const MAX_CODE_RUNS = 3;

export const ANALYZE_INSTRUCTIONS = `You are the analyst of VerityAI. You get the evidence collected for a research question.

You can call run_code to compute things with JavaScript (the evidence is available as \`data\`): counts per sub-question or stance, how many sources agree, numbers mentioned in quotes, publication years.
- Only run code when a calculation adds something; at most ${MAX_CODE_RUNS} runs.
- Then answer with 3–6 short bullet points of "analysis notes": patterns, agreements, disagreements, and computed numbers. Cite evidence as [n].
- Never invent numbers: use only the evidence and your code's results.`;

export type AnalysisData = {
  question: string;
  subQuestions: Array<{ n: number; text: string }>;
  evidence: Array<{
    n: number;
    subQuestion: number;
    stance: string;
    confidence: number;
    source: string;
    domain: string | null;
    year: number | null;
    quote: string;
  }>;
};

export function buildAnalyzeInput(data: AnalysisData): string {
  const lines = data.evidence.map(
    (e) =>
      `[${e.n}] (Q${e.subQuestion}, ${e.stance}, ${e.confidence}) "${e.quote}" — ${e.source}${e.year ? `, ${e.year}` : ""}`,
  );
  return [
    `Research question:\n${data.question}`,
    `Sub-questions:\n${data.subQuestions.map((q) => `Q${q.n}. ${q.text}`).join("\n")}`,
    `Evidence (also available to code as data.evidence):\n${lines.join("\n")}`,
  ].join("\n\n");
}
