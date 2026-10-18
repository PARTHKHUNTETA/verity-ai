import { eq } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { auditLogs } from "../../infrastructure/database/schema/index.js";
import {
  app,
  bearer,
  login,
  PASSWORD,
  refreshCookie,
  registerUser,
  resetDatabase,
} from "../../tests/helpers.js";

beforeEach(resetDatabase);

describe("register", () => {
  it("creates user, organization and owner membership, and starts a session", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "  Ada@Example.com ", password: PASSWORD, organizationName: "Ada Labs" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tokenType: "Bearer",
      user: { email: "ada@example.com" },
      organization: { name: "Ada Labs", slug: "ada-labs" },
      role: "owner",
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    // The refresh token is only ever in the httpOnly cookie.
    expect(res.body).not.toHaveProperty("refreshToken");
    const cookie = (res.headers["set-cookie"] as unknown as string[]).join(";");
    expect(cookie).toMatch(/verity_refresh=.+HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it("rejects a duplicate email (case-insensitive) with 409", async () => {
    await registerUser("ada@example.com");
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "ADA@example.com", password: PASSWORD, organizationName: "Other" });

    expect(res.status).toBe(409);
  });

  it("validates input and reports each problem", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: "short", organizationName: "X" });

    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(["email", "password", "organizationName"]));
  });

  it("gives organizations with the same name different slugs", async () => {
    const a = await registerUser("a@example.com", "Same Name");
    const b = await registerUser("b@example.com", "Same Name");
    const slugA = (await request(app).get("/api/v1/organization").set("Authorization", bearer(a)))
      .body.slug;
    const slugB = (await request(app).get("/api/v1/organization").set("Authorization", bearer(b)))
      .body.slug;
    expect(slugA).toBe("same-name");
    expect(slugB).toMatch(/^same-name-/);
  });
});

describe("login", () => {
  beforeEach(async () => {
    await registerUser("ada@example.com");
  });

  it("returns a session for correct credentials", async () => {
    const session = await login("ada@example.com");
    expect(session.accessToken).toBeTruthy();
  });

  it("returns the same 401 for a wrong password and an unknown email", async () => {
    const wrong = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "ada@example.com", password: "wrong-password" });
    const unknown = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nobody@example.com", password: PASSWORD });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("records failed logins in the audit log", async () => {
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "ada@example.com", password: "wrong-password" });

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "auth.login_failed"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toEqual({ email: "ada@example.com" });
  });

  it("refuses an organization the user doesn't belong to", async () => {
    const other = await registerUser("bob@example.com");
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "ada@example.com", password: PASSWORD, organizationId: other.organizationId });

    expect(res.status).toBe(403);
  });
});

describe("GET /me", () => {
  it("returns the user, organization, role and allowed actions", async () => {
    const session = await registerUser("ada@example.com", "Ada Labs");
    const res = await request(app).get("/api/v1/me").set("Authorization", bearer(session));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: { email: "ada@example.com" },
      organization: { name: "Ada Labs" },
      role: "owner",
    });
    expect(res.body.permissions).toContain("member:manage");
    expect(res.body.memberships).toHaveLength(1);
  });

  it("requires a valid access token", async () => {
    expect((await request(app).get("/api/v1/me")).status).toBe(401);
    const tampered = await request(app)
      .get("/api/v1/me")
      .set("Authorization", "Bearer abc.def.ghi");
    expect(tampered.status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it("issues a new access token and a new refresh token each time", async () => {
    const session = await registerUser("ada@example.com");
    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", session.cookie);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(res)).not.toBe(session.cookie);
  });

  it("detects reuse of an old refresh token and revokes the whole session", async () => {
    const session = await registerUser("ada@example.com");
    const first = await request(app).post("/api/v1/auth/refresh").set("Cookie", session.cookie);
    const rotatedCookie = refreshCookie(first);

    // An attacker replays the original (already used) token...
    const replay = await request(app).post("/api/v1/auth/refresh").set("Cookie", session.cookie);
    expect(replay.status).toBe(401);

    // ...so the legitimate, rotated token is revoked too: everyone must log in again.
    const legit = await request(app).post("/api/v1/auth/refresh").set("Cookie", rotatedCookie);
    expect(legit.status).toBe(401);

    const audit = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "auth.refresh_reuse_detected"));
    expect(audit).toHaveLength(1);
  });

  it("rejects a missing or unknown refresh token", async () => {
    expect((await request(app).post("/api/v1/auth/refresh")).status).toBe(401);
    const unknown = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", "verity_refresh=made-up-token");
    expect(unknown.status).toBe(401);
  });
});

describe("logout", () => {
  it("ends the session so the refresh token stops working", async () => {
    const session = await registerUser("ada@example.com");
    const res = await request(app).post("/api/v1/auth/logout").set("Cookie", session.cookie);
    expect(res.status).toBe(204);

    const after = await request(app).post("/api/v1/auth/refresh").set("Cookie", session.cookie);
    expect(after.status).toBe(401);
  });

  it("succeeds even without a session", async () => {
    expect((await request(app).post("/api/v1/auth/logout")).status).toBe(204);
  });
});
