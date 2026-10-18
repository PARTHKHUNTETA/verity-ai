/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = "23505";

/** True if a query failed because of a unique constraint (Drizzle may wrap the pg error). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}
