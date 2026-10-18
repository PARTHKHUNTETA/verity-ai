import type { DbExecutor } from "../../infrastructure/database/client.js";
import { auditLogs, type NewAuditLog } from "../../infrastructure/database/schema/index.js";
import type { RequestMeta } from "../../shared/request-meta.js";

export type AuditAction =
  | "auth.register"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.refresh_reuse_detected"
  | "member.add"
  | "member.role_change"
  | "member.remove"
  | "approval.decide"
  | "policy.update";

export type AuditEntry = Omit<NewAuditLog, "id" | "createdAt" | "action" | "ip" | "userAgent"> & {
  action: AuditAction;
  meta?: RequestMeta;
};

/** Append-only: the app never updates or deletes audit rows. */
export async function recordAudit(db: DbExecutor, { meta, ...entry }: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({ ...entry, ip: meta?.ip, userAgent: meta?.userAgent });
}
