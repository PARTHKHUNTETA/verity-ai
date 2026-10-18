import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { app, bearer, registerUser, resetDatabase } from "../../tests/helpers.js";
import { buildRuntime, ownerWithNotes, queueRun } from "../../tests/research-setup.js";
import {
  buildReferences,
  citedNumbers,
  formatReference,
  type CitationInput,
} from "./bibliography.js";
import { slugify } from "./reports.service.js";

const source = (over: Partial<CitationInput["source"]> = {}): CitationInput["source"] => ({
  id: "s1",
  type: "paper",
  title: "Blended RAG",
  authors: ["A. One", "B. Two", "C. Three", "D. Four"],
  publishedAt: "2024-05-01",
  url: "https://arxiv.org/abs/1",
  doi: "10.1/x",
  domain: "arxiv.org",
  fileName: null,
  ...over,
});

describe("bibliography", () => {
  it("lists cited numbers in order of first use", () => {
    expect(citedNumbers("A [3]. B [1, 3]. C [2].")).toEqual([3, 1, 2]);
  });

  it("formats references APA-style, tolerating missing fields", () => {
    expect(formatReference(source())).toBe(
      "A. One, B. Two, C. Three et al. (2024). Blended RAG. arxiv.org. https://doi.org/10.1/x",
    );
    expect(formatReference(source({ authors: null, doi: null, title: "7 RAG benchmarks." }))).toBe(
      "7 RAG benchmarks. (2024). arxiv.org. https://arxiv.org/abs/1",
    );
    expect(
      formatReference(
        source({
          type: "upload",
          authors: null,
          publishedAt: null,
          url: null,
          doi: null,
          domain: null,
          fileName: "notes.md",
          title: "Notes",
        }),
      ),
    ).toBe("Notes. Uploaded document (notes.md).");
  });

  it("groups citations by source in order of first citation, skipping uncited evidence", () => {
    const c = (number: number, id: string, pageStart: number | null = null): CitationInput => ({
      number,
      quote: `quote ${number}`,
      pageStart,
      pageEnd: pageStart,
      source: source({ id, title: `Source ${id}` }),
    });
    const { notes, references } = buildReferences("X [2]. Y [1, 3]. [9]", [
      c(1, "a", 4),
      c(2, "b"),
      c(3, "b"),
      c(4, "a"),
    ]);
    expect(references.map((r) => [r.index, r.sourceId, r.citedAs])).toEqual([
      [1, "b", [2, 3]],
      [2, "a", [1]],
    ]);
    expect(notes).toEqual([
      { number: 1, quote: "quote 1", pages: "p. 4", referenceIndex: 2 },
      { number: 2, quote: "quote 2", pages: null, referenceIndex: 1 },
      { number: 3, quote: "quote 3", pages: null, referenceIndex: 1 },
    ]);
  });

  it("makes safe file names", () => {
    expect(slugify("RAG systems: reducing hallucinations & failures!")).toBe(
      "rag-systems-reducing-hallucinations-failures",
    );
    expect(slugify("???")).toBe("report");
  });
});

describe("reports API", () => {
  beforeEach(resetDatabase);

  async function completedReport() {
    const owner = await ownerWithNotes();
    const runId = await queueRun(owner);
    await buildRuntime().runtime.runResearch(runId);
    const list = await request(app)
      .get("/api/v1/reports")
      .set("Authorization", bearer(owner))
      .expect(200);
    return { owner, runId, list: list.body.reports };
  }

  it("lists the shown version of each completed report, with its checks", async () => {
    const { list, runId } = await completedReport();
    expect(list).toHaveLength(1); // the fake run revises: v1 is superseded and not listed
    expect(list[0]).toMatchObject({
      runId,
      version: 2,
      revised: true,
      claimSupportRate: expect.any(Number),
    });
  });

  it("shows a report with all its versions", async () => {
    const { owner, list } = await completedReport();
    const res = await request(app)
      .get(`/api/v1/reports/${list[0].id}`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(
      res.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]),
    ).toEqual([
      [1, "superseded"],
      [2, "final"],
    ]);
    expect(res.body.scoredReportId).toBe(list[0].id);
  });

  it("exports Markdown with evidence, references and how the report was checked", async () => {
    const { owner, list } = await completedReport();
    const res = await request(app)
      .get(`/api/v1/reports/${list[0].id}/export?format=md`)
      .set("Authorization", bearer(owner))
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=".+-v2\.md"/);
    const text = res.text;
    expect(text).toContain("## Evidence");
    expect(text).toMatch(
      /## References\n\n1\. Notes on AI Agents\. Uploaded document \(notes\.md\)\. Cited as \[1\]/,
    );
    expect(text).toContain("## About this report");
    expect(text).toContain("Report version 2 (revised after fact-checking)");
    expect(text).toContain("Automatic checks: claim support");
  });

  it("exports a PDF", async () => {
    const { owner, list } = await completedReport();
    const res = await request(app)
      .get(`/api/v1/reports/${list[0].id}/export?format=pdf`)
      .set("Authorization", bearer(owner))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("hides other organizations' reports", async () => {
    const { list } = await completedReport();
    const other = await registerUser("other@example.com");
    await request(app)
      .get(`/api/v1/reports/${list[0].id}`)
      .set("Authorization", bearer(other))
      .expect(404);
    await request(app)
      .get(`/api/v1/reports/${list[0].id}/export`)
      .set("Authorization", bearer(other))
      .expect(404);
    const empty = await request(app)
      .get("/api/v1/reports")
      .set("Authorization", bearer(other))
      .expect(200);
    expect(empty.body.reports).toEqual([]);
  });
});
