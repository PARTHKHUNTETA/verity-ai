import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  JWT_SECRET: "x".repeat(32),
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(valid);
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 4000, LOG_LEVEL: "info" });
  });

  it("fails with a clear message when DATABASE_URL is missing", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-Postgres DATABASE_URL", () => {
    expect(() => parseEnv({ DATABASE_URL: "mysql://localhost/db" })).toThrow(/postgres/);
  });

  it("requires a JWT_SECRET of at least 32 characters", () => {
    expect(() => parseEnv({ ...valid, JWT_SECRET: "" })).toThrow(/JWT_SECRET is required/);
    expect(() => parseEnv({ ...valid, JWT_SECRET: "too-short" })).toThrow(/at least 32/);
  });

  it("treats empty optional secrets as unset", () => {
    expect(parseEnv({ ...valid, OPENAI_API_KEY: "" }).OPENAI_API_KEY).toBeUndefined();
  });
});
