import { z } from "zod";

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Must be a valid email address" }))
  .pipe(z.string().max(254));

// Length matters far more than character rules; 128 caps the cost of hashing huge inputs.
const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters");

export const registerSchema = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(100).optional(),
  organizationName: z.string().trim().min(2).max(100),
});

export const loginSchema = z.object({
  email,
  // No length rules on login: just check it against the stored hash.
  password: z.string().min(1).max(128),
  /** Which organization to sign in to; defaults to the user's oldest membership. */
  organizationId: z.uuid().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
