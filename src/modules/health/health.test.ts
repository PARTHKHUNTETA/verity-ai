import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.js";

describe("GET /api/v1/health", () => {
  it("returns 200 when the database is reachable", async () => {
    const app = createApp({ pingDatabase: async () => {} });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "ok" });
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  it("returns 503 when the database is unreachable", async () => {
    const app = createApp({
      pingDatabase: async () => {
        throw new Error("connection refused");
      },
    });

    const res = await request(app).get("/api/v1/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "degraded", db: "error" });
  });
});
