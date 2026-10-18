/**
 * Citation accuracy: citations whose passage supports the claim they are attached to ÷ all
 * citations. Stricter than claim support: a claim with one good and one irrelevant citation is
 * supported, but only half of its citations are accurate.
 */
export function citationAccuracy(judged: Array<{ citations: Array<{ supports: boolean }> }>) {
  const all = judged.flatMap((j) => j.citations);
  const supporting = all.filter((c) => c.supports).length;
  return { rate: all.length ? supporting / all.length : null, total: all.length, supporting };
}
