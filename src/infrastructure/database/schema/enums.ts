import { pgEnum } from "drizzle-orm/pg-core";

/** Roles inside an organization (docs/system-design.md §4.7). Order = most to least powerful. */
export const memberRoles = ["owner", "admin", "researcher", "viewer"] as const;
export type MemberRole = (typeof memberRoles)[number];
export const memberRole = pgEnum("member_role", memberRoles);

/** Why a refresh token stopped working. Only replaying a "rotated" token signals theft. */
export const tokenRevokeReasons = [
  "rotated",
  "logout",
  "reuse_detected",
  "member_removed",
  "session_invalid",
] as const;
export type TokenRevokeReason = (typeof tokenRevokeReasons)[number];
export const tokenRevokeReason = pgEnum("token_revoke_reason", tokenRevokeReasons);
