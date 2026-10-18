import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  evidence,
  reports,
  researchRuns,
  researchTasks,
  runScorecards,
  sourceChunks,
  sources,
} from "../../infrastructure/database/schema/index.js";
import { NotFoundError } from "../../shared/errors.js";
import type { AuthContext } from "../auth/auth.types.js";
import { listCitations } from "../research/research.repository.js";
import type { CitationInput } from "./bibliography.js";
import { renderMarkdownExport } from "./markdown-export.js";
import { renderPdf } from "./pdf.js";

/**
 * The Reports area: every finished report in the organization, each version of a report, and
 * exports (Markdown and PDF with evidence notes and a bibliography).
 */
export function createReportsService(db: Database) {
  async function findReport(actor: AuthContext, reportId: string) {
    const [row] = await db
      .select({ report: reports, run: researchRuns, task: researchTasks })
      .from(reports)
      .innerJoin(researchRuns, eq(researchRuns.id, reports.runId))
      .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
      .where(
        and(
          eq(reports.id, reportId),
          eq(reports.organizationId, actor.organizationId),
          isNull(researchTasks.deletedAt),
        ),
      );
    if (!row) throw new NotFoundError("Report not found");
    return row;
  }

  async function citationsOf(runId: string): Promise<CitationInput[]> {
    const rows = await db
      .select({
        number: evidence.rank,
        quote: evidence.quote,
        pageStart: sourceChunks.pageStart,
        pageEnd: sourceChunks.pageEnd,
        source: sources,
      })
      .from(evidence)
      .innerJoin(sources, eq(sources.id, evidence.sourceId))
      .leftJoin(sourceChunks, eq(sourceChunks.id, evidence.chunkId))
      .where(eq(evidence.runId, runId))
      .orderBy(asc(evidence.rank));
    return rows.map((r) => ({
      number: r.number,
      quote: r.quote,
      pageStart: r.pageStart,
      pageEnd: r.pageEnd,
      source: {
        id: r.source.id,
        type: r.source.type,
        title: r.source.title,
        authors: r.source.authors,
        publishedAt: r.source.publishedAt,
        url: r.source.url,
        doi: r.source.doi,
        domain: r.source.domain,
        fileName: r.source.fileName,
      },
    }));
  }

  return {
    /** The latest shown report of every completed user run (eval runs excluded), newest first. */
    async list(actor: AuthContext, query: { q?: string; limit: number }) {
      const rows = await db
        .select({
          id: reports.id,
          runId: reports.runId,
          taskId: researchTasks.id,
          title: reports.title,
          version: reports.version,
          question: researchTasks.question,
          model: researchRuns.model,
          completedAt: researchRuns.completedAt,
          claimSupportRate: runScorecards.claimSupportRate,
          passed: runScorecards.passed,
          revised: sql<boolean>`${runScorecards.extra}->'revision'->>'kept' = 'revised'`,
        })
        .from(reports)
        .innerJoin(researchRuns, eq(researchRuns.id, reports.runId))
        .innerJoin(researchTasks, eq(researchTasks.id, researchRuns.taskId))
        .leftJoin(runScorecards, eq(runScorecards.reportId, reports.id))
        .where(
          and(
            eq(reports.organizationId, actor.organizationId),
            eq(reports.status, "final"),
            eq(researchRuns.status, "completed"),
            eq(researchTasks.origin, "user"),
            isNull(researchTasks.deletedAt),
            query.q
              ? sql`(${researchTasks.question} ilike ${`%${query.q}%`} or ${reports.title} ilike ${`%${query.q}%`})`
              : undefined,
          ),
        )
        .orderBy(desc(researchRuns.completedAt))
        .limit(query.limit);
      return rows.map((r) => ({ ...r, revised: r.revised ?? false }));
    },

    /** One report version, with the other versions of the same run. */
    async get(actor: AuthContext, reportId: string) {
      const { report, run, task } = await findReport(actor, reportId);
      const versions = await db
        .select({ id: reports.id, version: reports.version, status: reports.status })
        .from(reports)
        .where(eq(reports.runId, run.id))
        .orderBy(asc(reports.version));
      const [scorecard] = await db
        .select({ reportId: runScorecards.reportId })
        .from(runScorecards)
        .where(eq(runScorecards.runId, run.id));
      return {
        id: report.id,
        runId: run.id,
        version: report.version,
        status: report.status,
        title: report.title,
        contentMd: report.contentMd,
        createdAt: report.createdAt,
        question: task.question,
        model: run.model,
        completedAt: run.completedAt,
        /** Which version the scorecard judged as the one to show. */
        scoredReportId: scorecard?.reportId ?? null,
        versions,
        /** Evidence the report can cite, for clickable citations. */
        citations: await listCitations(db, actor.organizationId, run.id),
      };
    },

    async export(actor: AuthContext, reportId: string, format: "md" | "pdf") {
      const { report, run, task } = await findReport(actor, reportId);
      const [scorecard] = await db
        .select()
        .from(runScorecards)
        .where(and(eq(runScorecards.runId, run.id), eq(runScorecards.reportId, report.id)));
      const markdown = renderMarkdownExport({
        question: task.question,
        instructions: task.instructions,
        contentMd: report.contentMd,
        version: report.version,
        status: report.status,
        model: run.model,
        pipelineVersion: run.promptVersion,
        completedAt: run.completedAt,
        citations: await citationsOf(run.id),
        scorecard: scorecard ?? null,
      });
      const title = report.title ?? task.question;
      const fileName = `${slugify(title)}-v${report.version}.${format}`;
      if (format === "md") {
        return {
          fileName,
          contentType: "text/markdown; charset=utf-8",
          body: Buffer.from(markdown),
        };
      }
      return {
        fileName,
        contentType: "application/pdf",
        body: await renderPdf(markdown, { title, subject: task.question }),
      };
    },
  };
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 60)
      .replace(/-+$/, "") || "report"
  );
}
