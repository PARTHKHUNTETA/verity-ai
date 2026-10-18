import type { Request } from "express";

/** Client details recorded in audit logs. */
export type RequestMeta = { ip: string | null; userAgent: string | null };

export function requestMeta(req: Request): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}
