/**
 * Contradiction handling: when the evidence disagrees with itself, a trustworthy report says so.
 * Score = contradicting evidence the report cites ÷ contradicting evidence found.
 * Null when no evidence contradicted anything (nothing to handle).
 */
export function contradictionHandling(
  evidence: Array<{ id: string; stance: string | null }>,
  citedEvidenceIds: ReadonlySet<string>,
) {
  const contradicting = evidence.filter((e) => e.stance === "contradicts");
  if (!contradicting.length) return null;
  return contradicting.filter((e) => citedEvidenceIds.has(e.id)).length / contradicting.length;
}
