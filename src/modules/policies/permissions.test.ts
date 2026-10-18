import { describe, expect, it } from "vitest";
import { memberRoles, type MemberRole } from "../../infrastructure/database/schema/enums.js";
import { actions, can, canAssignRole, type Action } from "./permissions.js";

/** The expected matrix, written out by hand so a change to permissions.ts must be deliberate. */
const expected: Record<Action, MemberRole[]> = {
  "report:read": ["owner", "admin", "researcher", "viewer"],
  "run:create": ["owner", "admin", "researcher"],
  "run:manage": ["owner", "admin"],
  "source:create": ["owner", "admin", "researcher"],
  "collection:manage": ["owner", "admin"],
  "approval:decide": ["owner", "admin"],
  "policy:manage": ["owner", "admin"],
  "eval:manage": ["owner", "admin", "researcher"],
  "member:read": ["owner", "admin", "researcher", "viewer"],
  "member:manage": ["owner", "admin"],
};

describe("permissions matrix", () => {
  for (const action of actions) {
    for (const role of memberRoles) {
      const allowed = expected[action].includes(role);
      it(`${role} ${allowed ? "can" : "cannot"} ${action}`, () => {
        expect(can(role, action)).toBe(allowed);
      });
    }
  }
});

describe("canAssignRole", () => {
  it("lets only owners grant the owner role", () => {
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
  });

  it("lets admins assign admin and below", () => {
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canAssignRole("admin", "viewer")).toBe(true);
  });

  it("never lets researchers or viewers assign roles", () => {
    expect(canAssignRole("researcher", "viewer")).toBe(false);
    expect(canAssignRole("viewer", "viewer")).toBe(false);
  });
});
