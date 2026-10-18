import type { MemberRole } from "../../infrastructure/database/schema/enums.js";

/** Who is calling, attached to `req.auth` by the authenticate middleware. */
export type AuthContext = {
  userId: string;
  organizationId: string;
  /** Loaded from the database on every request, so role changes apply immediately. */
  role: MemberRole;
};
