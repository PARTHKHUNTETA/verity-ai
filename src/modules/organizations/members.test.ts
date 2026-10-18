import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  app,
  bearer,
  login,
  registerUser,
  resetDatabase,
  type TestSession,
} from "../../tests/helpers.js";

beforeEach(resetDatabase);

const members = "/api/v1/organization/members";

/** Registers `email` (which gives them their own org) and adds them to `owner`'s org with `role`. */
async function addToOrg(owner: TestSession, email: string, role: string): Promise<TestSession> {
  await registerUser(email);
  const res = await request(app)
    .post(members)
    .set("Authorization", bearer(owner))
    .send({ email, role });
  if (res.status !== 201) throw new Error(`add failed: ${res.status} ${JSON.stringify(res.body)}`);
  return login(email, owner.organizationId);
}

describe("organization members", () => {
  let owner: TestSession;

  beforeEach(async () => {
    owner = await registerUser("owner@example.com", "Acme Research");
  });

  it("lets an owner add an existing user and everyone list members", async () => {
    const researcher = await addToOrg(owner, "res@example.com", "researcher");

    const res = await request(app).get(members).set("Authorization", bearer(researcher));
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { email: string }) => m.email)).toEqual([
      "owner@example.com",
      "res@example.com",
    ]);
  });

  it("returns 404 when adding an email with no account, 409 when already a member", async () => {
    const missing = await request(app)
      .post(members)
      .set("Authorization", bearer(owner))
      .send({ email: "ghost@example.com", role: "viewer" });
    expect(missing.status).toBe(404);

    await addToOrg(owner, "res@example.com", "researcher");
    const dup = await request(app)
      .post(members)
      .set("Authorization", bearer(owner))
      .send({ email: "res@example.com", role: "viewer" });
    expect(dup.status).toBe(409);
  });

  it("forbids researchers and viewers from managing members", async () => {
    const researcher = await addToOrg(owner, "res@example.com", "researcher");
    const viewer = await addToOrg(owner, "view@example.com", "viewer");

    for (const session of [researcher, viewer]) {
      const res = await request(app)
        .patch(`${members}/${owner.userId}`)
        .set("Authorization", bearer(session))
        .send({ role: "viewer" });
      expect(res.status).toBe(403);
    }
  });

  it("stops admins from granting the owner role or touching an owner", async () => {
    const admin = await addToOrg(owner, "admin@example.com", "admin");
    const viewer = await addToOrg(owner, "view@example.com", "viewer");

    const promote = await request(app)
      .patch(`${members}/${viewer.userId}`)
      .set("Authorization", bearer(admin))
      .send({ role: "owner" });
    expect(promote.status).toBe(403);

    const demoteOwner = await request(app)
      .patch(`${members}/${owner.userId}`)
      .set("Authorization", bearer(admin))
      .send({ role: "viewer" });
    expect(demoteOwner.status).toBe(403);

    const removeOwner = await request(app)
      .delete(`${members}/${owner.userId}`)
      .set("Authorization", bearer(admin));
    expect(removeOwner.status).toBe(403);
  });

  it("never leaves an organization without an owner", async () => {
    const res = await request(app)
      .patch(`${members}/${owner.userId}`)
      .set("Authorization", bearer(owner))
      .send({ role: "admin" });
    expect(res.status).toBe(409);
  });

  it("applies role changes immediately, without a new token", async () => {
    const viewer = await addToOrg(owner, "view@example.com", "viewer");
    const before = await request(app)
      .post(members)
      .set("Authorization", bearer(viewer))
      .send({ email: "owner@example.com", role: "viewer" });
    expect(before.status).toBe(403);

    await request(app)
      .patch(`${members}/${viewer.userId}`)
      .set("Authorization", bearer(owner))
      .send({ role: "admin" })
      .expect(204);

    const after = await request(app).get("/api/v1/me").set("Authorization", bearer(viewer));
    expect(after.body.role).toBe("admin");
    expect(after.body.permissions).toContain("member:manage");
  });

  it("cuts off a removed member immediately, including their refresh token", async () => {
    const researcher = await addToOrg(owner, "res@example.com", "researcher");

    await request(app)
      .delete(`${members}/${researcher.userId}`)
      .set("Authorization", bearer(owner))
      .expect(204);

    const me = await request(app).get("/api/v1/me").set("Authorization", bearer(researcher));
    expect(me.status).toBe(401);
    const refresh = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", researcher.cookie);
    expect(refresh.status).toBe(401);
  });
});

describe("tenant isolation", () => {
  it("keeps each organization's members invisible and untouchable to the other", async () => {
    const ownerA = await registerUser("a@example.com", "Org A");
    const ownerB = await registerUser("b@example.com", "Org B");

    const listA = await request(app).get(members).set("Authorization", bearer(ownerA));
    expect(listA.body.members.map((m: { email: string }) => m.email)).toEqual(["a@example.com"]);

    // Org A's owner tries to change and remove Org B's owner using B's real user id.
    const patch = await request(app)
      .patch(`${members}/${ownerB.userId}`)
      .set("Authorization", bearer(ownerA))
      .send({ role: "viewer" });
    expect(patch.status).toBe(404);

    const del = await request(app)
      .delete(`${members}/${ownerB.userId}`)
      .set("Authorization", bearer(ownerA));
    expect(del.status).toBe(404);

    const meB = await request(app).get("/api/v1/me").set("Authorization", bearer(ownerB));
    expect(meB.body.role).toBe("owner");
  });

  it("rejects a malformed user id with 400", async () => {
    const ownerA = await registerUser("a@example.com");
    const res = await request(app)
      .delete(`${members}/not-a-uuid`)
      .set("Authorization", bearer(ownerA));
    expect(res.status).toBe(400);
  });
});
