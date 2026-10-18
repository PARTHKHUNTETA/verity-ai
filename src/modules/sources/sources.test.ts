import { eq } from "drizzle-orm";
import { pino } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../infrastructure/database/client.js";
import { sources } from "../../infrastructure/database/schema/index.js";
import { buildPdf } from "../../tests/pdf.js";
import {
  app,
  bearer,
  fakeQueue,
  login,
  memoryStorage,
  registerUser,
  resetDatabase,
  testLlm,
  type TestSession,
} from "../../tests/helpers.js";
import { createIngestionService } from "../retrieval/ingestion.js";

beforeEach(resetDatabase);

const ingestion = createIngestionService({
  db,
  llm: testLlm,
  storage: memoryStorage,
  embeddingModel: "fake-embedding",
  logger: pino({ level: "silent" }),
});

/** Runs the ingestion jobs the API queued (what the worker would do). */
async function ingestQueued() {
  for (const id of fakeQueue.ingests.splice(0)) await ingestion.ingestSource(id);
}

async function createCollection(session: TestSession, body: object = { name: "AI papers" }) {
  const res = await request(app)
    .post("/api/v1/collections")
    .set("Authorization", bearer(session))
    .send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function upload(
  session: TestSession,
  collectionId: string,
  name: string,
  content: Uint8Array | string,
) {
  return request(app)
    .post(`/api/v1/collections/${collectionId}/sources`)
    .set("Authorization", bearer(session))
    .attach("file", Buffer.from(content), name);
}

async function addMember(owner: TestSession, email: string, role: string) {
  await registerUser(email);
  await request(app)
    .post("/api/v1/organization/members")
    .set("Authorization", bearer(owner))
    .send({ email, role })
    .expect(201);
  return login(email, owner.organizationId);
}

const AGENTS_TEXT = [
  "# Notes on AI Agents",
  "",
  "ReAct agents interleave reasoning traces with tool calls, which lets them update plans as they observe results.",
  "",
  "Plan-and-execute agents first write a full plan, then run each step; they are cheaper but adapt less.",
  "",
  "Multi-agent systems split work between specialized agents that critique each other.",
].join("\n");

describe("collections", () => {
  it("creates and lists collections with document counts", async () => {
    const owner = await registerUser("owner@example.com");
    const id = await createCollection(owner);
    await upload(owner, id, "agents.md", AGENTS_TEXT).expect(201);
    await ingestQueued();

    const res = await request(app).get("/api/v1/collections").set("Authorization", bearer(owner));
    expect(res.body.collections).toEqual([
      expect.objectContaining({ id, name: "AI papers", sourceCount: 1, readyCount: 1 }),
    ]);
  });

  it("lets researchers create only private collections", async () => {
    const owner = await registerUser("owner@example.com");
    const researcher = await addMember(owner, "res@example.com", "researcher");

    const orgWide = await request(app)
      .post("/api/v1/collections")
      .set("Authorization", bearer(researcher))
      .send({ name: "Shared", visibility: "organization" });
    expect(orgWide.status).toBe(403);

    await createCollection(researcher, { name: "Mine", visibility: "private" });
  });

  it("hides private collections from other researchers but not from admins", async () => {
    const owner = await registerUser("owner@example.com");
    const alice = await addMember(owner, "alice@example.com", "researcher");
    const bob = await addMember(owner, "bob@example.com", "researcher");
    const privateId = await createCollection(alice, { name: "Alice only", visibility: "private" });

    const bobList = await request(app).get("/api/v1/collections").set("Authorization", bearer(bob));
    expect(bobList.body.collections).toHaveLength(0);
    const bobGet = await request(app)
      .get(`/api/v1/collections/${privateId}`)
      .set("Authorization", bearer(bob));
    expect(bobGet.status).toBe(404);

    const ownerList = await request(app)
      .get("/api/v1/collections")
      .set("Authorization", bearer(owner));
    expect(ownerList.body.collections).toHaveLength(1);
  });

  it("keeps organizations apart", async () => {
    const ownerA = await registerUser("a@example.com");
    const ownerB = await registerUser("b@example.com");
    const id = await createCollection(ownerA);

    const res = await request(app)
      .get(`/api/v1/collections/${id}`)
      .set("Authorization", bearer(ownerB));
    expect(res.status).toBe(404);
    expect((await upload(ownerB, id, "x.txt", "hello")).status).toBe(404);
  });
});

describe("uploading and ingesting", () => {
  it("stores the file, queues ingestion, and produces searchable chunks", async () => {
    const owner = await registerUser("owner@example.com");
    const id = await createCollection(owner);

    const res = await upload(owner, id, "agents.md", AGENTS_TEXT);
    expect(res.status).toBe(201);
    expect(res.body.source).toMatchObject({ status: "pending", fileName: "agents.md" });
    expect(fakeQueue.ingests).toEqual([res.body.source.id]);
    expect(memoryStorage.files.size).toBe(1);

    await ingestQueued();

    const source = await request(app)
      .get(`/api/v1/sources/${res.body.source.id}`)
      .set("Authorization", bearer(owner));
    expect(source.body).toMatchObject({
      status: "ready",
      title: "Notes on AI Agents",
      chunkCount: 1,
    });

    const search = await request(app)
      .post("/api/v1/search")
      .set("Authorization", bearer(owner))
      .send({ query: "plan-and-execute agents" });
    expect(search.body.hits[0]).toMatchObject({ sourceTitle: "Notes on AI Agents" });
    expect(search.body.hits[0].keywordRank).toBe(1);
  });

  it("ingests PDFs with page numbers", async () => {
    const owner = await registerUser("owner@example.com");
    const id = await createCollection(owner);
    const pdf = buildPdf(["Tool use makes agents act.", "Benchmarks measure agent quality."], {
      title: "Agent Survey",
    });
    const res = await upload(owner, id, "survey.pdf", pdf).expect(201);
    await ingestQueued();

    const chunks = await request(app)
      .get(`/api/v1/sources/${res.body.source.id}/chunks`)
      .set("Authorization", bearer(owner));
    expect(chunks.body.chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
    const [row] = await db.select().from(sources).where(eq(sources.id, res.body.source.id));
    expect(row).toMatchObject({ title: "Agent Survey", pageCount: 2, status: "ready" });
  });

  it("stores the same file once and links it to a second collection", async () => {
    const owner = await registerUser("owner@example.com");
    const first = await createCollection(owner, { name: "First" });
    const second = await createCollection(owner, { name: "Second" });

    const a = await upload(owner, first, "agents.md", AGENTS_TEXT).expect(201);
    const b = await upload(owner, second, "copy.md", AGENTS_TEXT);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ duplicate: true, source: { id: a.body.source.id } });
    expect(memoryStorage.files.size).toBe(1);
    expect(fakeQueue.ingests).toHaveLength(1);
  });

  it("rejects unsupported files and files over the size limit", async () => {
    const owner = await registerUser("owner@example.com");
    const id = await createCollection(owner);

    const png = await upload(owner, id, "image.png", "not really a png");
    expect(png.status).toBe(400);

    const big = await upload(owner, id, "big.txt", "x".repeat(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("marks a PDF without text as failed with a helpful message", async () => {
    const owner = await registerUser("owner@example.com");
    const id = await createCollection(owner);
    const res = await upload(owner, id, "scan.pdf", buildPdf([""])).expect(201);
    await ingestQueued();

    const [row] = await db.select().from(sources).where(eq(sources.id, res.body.source.id));
    expect(row!.status).toBe("failed");
    expect(row!.error).toMatch(/OCR/);
  });

  it("does not let viewers upload", async () => {
    const owner = await registerUser("owner@example.com");
    const viewer = await addMember(owner, "viewer@example.com", "viewer");
    const id = await createCollection(owner);
    expect((await upload(viewer, id, "x.txt", "hello")).status).toBe(403);
  });
});
