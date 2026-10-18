/**
 * Citation validity (deterministic): does every [n] in the report point at real evidence?
 * Invalid: numbers the model was never given (a hallucinated citation). Unresolvable: the
 * cited source has since been deleted or failed. Target: 1.00.
 */
export function citationValidity(input: {
  /** Citations linked to evidence (claim_evidence rows). */
  linked: number;
  /** Of those, citations whose source can no longer be opened. */
  unresolvable: number;
  /** Distinct citation numbers in the text that match no evidence. */
  invalidNumbers: number[];
}) {
  const total = input.linked + input.invalidNumbers.length;
  return total ? (input.linked - input.unresolvable) / total : null;
}
