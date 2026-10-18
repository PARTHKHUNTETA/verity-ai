import { defineConfig } from "vitest/config";
import { testEnv } from "./src/tests/test-env.js";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["src/tests/global-setup.ts"],
    // Integration tests share one test database, so files run one at a time.
    fileParallelism: false,
    // Integration tests hash passwords with argon2 (slow on purpose) and hit Postgres;
    // 5 s (the default) is too tight when the machine is also running the dev servers.
    testTimeout: 15_000,
    env: testEnv,
  },
});
