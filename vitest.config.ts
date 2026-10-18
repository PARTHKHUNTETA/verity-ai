import { defineConfig } from "vitest/config";
import { testEnv } from "./src/tests/test-env.js";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globalSetup: ["src/tests/global-setup.ts"],
    // Integration tests share one test database, so files run one at a time.
    fileParallelism: false,
    env: testEnv,
  },
});
