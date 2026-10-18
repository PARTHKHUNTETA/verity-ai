import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { testKnowledgeDeps, testResearchDeps } from "./helpers.js";
import { db } from "../infrastructure/database/client.js";
import { errorHandler } from "../middleware/error-handler.js";
import { requestId } from "../middleware/request-id.js";
import { ForbiddenError } from "../shared/errors.js";

const app = createApp({
  db,
  research: testResearchDeps,
  knowledge: testKnowledgeDeps,
  pingDatabase: async () => {},
});

describe("app middleware", () => {
  it("returns a JSON 404 with the request id for unknown routes", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.requestId).toBe(res.headers["x-request-id"]);
  });

  it("reuses a safe incoming X-Request-Id and replaces an unsafe one", async () => {
    const safe = await request(app).get("/api/v1/health").set("X-Request-Id", "trace-abc_123");
    expect(safe.headers["x-request-id"]).toBe("trace-abc_123");

    const unsafe = await request(app).get("/api/v1/health").set("X-Request-Id", "bad id <script>");
    expect(unsafe.headers["x-request-id"]).not.toBe("bad id <script>");
  });

  it("returns 400 INVALID_JSON for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/v1/health")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});

describe("error handler", () => {
  function appThatThrows(error: unknown) {
    const testApp = express();
    testApp.use(requestId);
    testApp.get("/boom", () => {
      throw error;
    });
    testApp.use(errorHandler);
    return testApp;
  }

  it("maps AppError subclasses to their status and code", async () => {
    const res = await request(appThatThrows(new ForbiddenError())).get("/boom");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("hides details of unexpected errors behind a 500", async () => {
    const res = await request(appThatThrows(new Error("db password is hunter2"))).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});
