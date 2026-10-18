import type { ClaimVerdict } from "../../../infrastructure/database/schema/index.js";

/**
 * Claim support rate: supported claims ÷ all claims, a partially supported claim counts half.
 * A report without a single cited claim scores 0: nothing in it is backed by evidence.
 */
export function claimSupport(verdicts: ClaimVerdict[]) {
  const supported = verdicts.filter((v) => v === "supported").length;
  const partial = verdicts.filter((v) => v === "partial").length;
  return {
    rate: verdicts.length ? (supported + partial * 0.5) / verdicts.length : 0,
    total: verdicts.length,
    supported,
    partial,
    unsupported: verdicts.length - supported - partial,
  };
}
