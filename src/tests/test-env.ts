/**
 * Environment for tests. Shared by vitest.config.ts (applied to test files) and
 * global-setup.ts (which runs before Vitest applies `test.env`).
 */
export const testEnv = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://verity:verity@localhost:5433/verity_test",
  JWT_SECRET: "test-secret-that-is-at-least-32-characters-long",
};
