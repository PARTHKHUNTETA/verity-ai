import { z } from "zod";
import { memberRoles } from "../../infrastructure/database/schema/enums.js";

const role = z.enum(memberRoles);

export const addMemberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  role,
});

export const changeRoleSchema = z.object({ role });

export const memberParamsSchema = z.object({ userId: z.uuid() });

export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
