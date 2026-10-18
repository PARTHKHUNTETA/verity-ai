import type { MemberRole } from "../../infrastructure/database/schema/enums.js";

/**
 * Role-based access control: WHO may do WHAT (docs/system-design.md §4.7).
 * This is checked server-side on every protected route. Hiding a button in React is only UX.
 * The policy gateway (Phase 8) adds checks for individual agent tool calls on top of this.
 */
export const actions = [
  "report:read", // view reports, runs and scorecards
  "run:create", // start research runs
  "source:create", // upload / manage own sources
  "collection:manage", // manage org-wide collections
  "approval:decide", // approve over-budget or restricted agent actions
  "policy:manage", // edit org policies
  "eval:manage", // manage eval datasets and run evaluations
  "member:read", // see who is in the organization
  "member:manage", // add, remove and change roles of members
] as const;

export type Action = (typeof actions)[number];

const researcher: readonly Action[] = [
  "report:read",
  "run:create",
  "source:create",
  "eval:manage",
  "member:read",
];

const admin: readonly Action[] = [
  ...researcher,
  "collection:manage",
  "approval:decide",
  "policy:manage",
  "member:manage",
];

const rolePermissions: Record<MemberRole, ReadonlySet<Action>> = {
  owner: new Set(actions),
  admin: new Set(admin),
  researcher: new Set(researcher),
  viewer: new Set<Action>(["report:read", "member:read"]),
};

export function can(role: MemberRole, action: Action): boolean {
  return rolePermissions[role].has(action);
}

/** Owner-only rules that a flat permission list can't express (see members.service.ts). */
export function canAssignRole(actorRole: MemberRole, targetRole: MemberRole): boolean {
  if (!can(actorRole, "member:manage")) return false;
  // Only owners can create owners; admins can assign admin and below.
  return targetRole !== "owner" || actorRole === "owner";
}
