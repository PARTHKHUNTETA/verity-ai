import type {
  ApprovalStatus,
  PolicyDecisionValue,
  ToolCallStatus,
} from "../../../infrastructure/database/schema/index.js";

/**
 * Policy compliance (deterministic): every tool call that actually ran must have been allowed
 * by the policy gateway, or approved by a human. A call that ran after a "deny", or without
 * any decision, is a violation. The gateway makes this impossible by construction; this check
 * verifies the construction.
 */
export function policyCompliance(
  calls: Array<{
    tool: string;
    status: ToolCallStatus;
    decisions: PolicyDecisionValue[];
    approval: ApprovalStatus | null;
  }>,
) {
  const ran: ToolCallStatus[] = ["running", "succeeded", "failed"];
  const violations = calls
    .filter((c) => ran.includes(c.status))
    .flatMap((c) => {
      if (c.decisions.includes("deny")) return [`${c.tool} ran although the policy denied it`];
      const last = c.decisions.at(-1);
      if (last === "allow") return [];
      if (last === "require_approval" && c.approval === "approved") return [];
      return [`${c.tool} ran without an allow decision or an approval`];
    });
  return { compliant: violations.length === 0, violations };
}
