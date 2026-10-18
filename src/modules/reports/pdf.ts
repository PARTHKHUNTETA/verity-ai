import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { marked, type Token, type Tokens } from "marked";
import PDFDocument from "pdfkit";

/**
 * Markdown → PDF without a headless browser: marked turns the Markdown into tokens, and we
 * draw each token with pdfkit. Fonts are DejaVu (embedded), which cover the Unicode that
 * shows up in papers (→, ≥, Greek letters, accents) — the 14 built-in PDF fonts don't.
 * Raw HTML in the Markdown is printed as text, never interpreted.
 */

const require = createRequire(import.meta.url);
const FONT_DIR = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
const FONTS = {
  regular: join(FONT_DIR, "DejaVuSans.ttf"),
  bold: join(FONT_DIR, "DejaVuSans-Bold.ttf"),
  italic: join(FONT_DIR, "DejaVuSans-Oblique.ttf"),
  mono: join(FONT_DIR, "DejaVuSansMono.ttf"),
};

const INK = "#0f172a";
const MUTED = "#475569";
const LINE = "#e2e8f0";
const BODY = 10;
const HEADING_SIZES = [18, 14, 12, 11, 10, 10];
const MARGIN = 56;

type Doc = PDFKit.PDFDocument;
type Style = { font: keyof typeof FONTS; color?: string };

export type PdfMeta = { title: string; subject: string };

export async function renderPdf(markdown: string, meta: PdfMeta): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: { Title: meta.title, Subject: meta.subject, Creator: "VerityAI", Producer: "VerityAI" },
    bufferPages: true,
  });
  for (const [name, path] of Object.entries(FONTS)) doc.registerFont(name, path);
  doc.font("regular").fontSize(BODY).fillColor(INK);

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  for (const token of marked.lexer(markdown)) block(doc, token, 0);
  footer(doc, meta.title);
  doc.end();
  return done;
}

const width = (doc: Doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

function ensureSpace(doc: Doc, height: number) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Inline tokens → styled text runs, drawn as one flowing paragraph. */
function inline(
  doc: Doc,
  tokens: Token[] | undefined,
  base: Style,
  options: PDFKit.Mixins.TextOptions = {},
) {
  const runs: Array<{ text: string; style: Style; link?: string }> = [];
  const walk = (list: Token[] | undefined, style: Style, link?: string) => {
    for (const t of list ?? []) {
      switch (t.type) {
        case "strong":
          walk((t as Tokens.Strong).tokens, { ...style, font: "bold" }, link);
          break;
        case "em":
          walk(
            (t as Tokens.Em).tokens,
            { ...style, font: style.font === "bold" ? "bold" : "italic" },
            link,
          );
          break;
        case "codespan":
          runs.push({
            text: decode((t as Tokens.Codespan).text),
            style: { ...style, font: "mono" },
            link,
          });
          break;
        case "link": {
          const l = t as Tokens.Link;
          // Only real web links become clickable.
          const href = /^https?:\/\//.test(l.href) ? l.href : undefined;
          walk(l.tokens, { ...style, color: href ? "#4338ca" : style.color }, href);
          break;
        }
        case "br":
          runs.push({ text: "\n", style, link });
          break;
        case "text":
        case "escape":
        case "html":
        case "del": {
          const withTokens = t as Tokens.Text;
          if (withTokens.tokens?.length) walk(withTokens.tokens, style, link);
          else runs.push({ text: decode(withTokens.text ?? t.raw ?? ""), style, link });
          break;
        }
        default:
          runs.push({ text: decode((t as { text?: string }).text ?? t.raw ?? ""), style, link });
      }
    }
  };
  walk(tokens, base);
  if (!runs.length) return;
  runs.forEach((run, i) => {
    doc
      .font(run.style.font)
      .fillColor(run.style.color ?? INK)
      .text(run.text, {
        ...options,
        continued: i < runs.length - 1,
        link: run.link ?? null,
        underline: false,
      });
  });
  doc.font("regular").fillColor(INK);
}

function block(doc: Doc, token: Token, indent: number) {
  const x = doc.page.margins.left + indent;
  const w = width(doc) - indent;
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const size = HEADING_SIZES[h.depth - 1] ?? BODY;
      ensureSpace(doc, size * 3);
      doc.moveDown(h.depth === 1 ? 0.2 : 0.8);
      doc.fontSize(size);
      inline(doc, h.tokens, { font: "bold" }, { width: w });
      doc.fontSize(BODY).moveDown(0.4);
      if (h.depth <= 2) {
        doc
          .moveTo(x, doc.y)
          .lineTo(x + w, doc.y)
          .strokeColor(LINE)
          .lineWidth(0.5)
          .stroke();
        doc.moveDown(0.4);
      }
      break;
    }
    case "paragraph":
      doc.x = x;
      inline(
        doc,
        (token as Tokens.Paragraph).tokens,
        { font: "regular" },
        { width: w, lineGap: 2 },
      );
      doc.moveDown(0.6);
      break;
    case "text":
      doc.x = x;
      inline(
        doc,
        (token as Tokens.Text).tokens ?? [token],
        { font: "regular" },
        { width: w, lineGap: 2 },
      );
      break;
    case "list": {
      const list = token as Tokens.List;
      list.items.forEach((item, i) => {
        ensureSpace(doc, BODY * 2);
        const marker = list.ordered ? `${Number(list.start || 1) + i}.` : "•";
        const top = doc.y;
        doc.font("regular").fillColor(MUTED).text(marker, x, top, { width: 18 });
        doc.fillColor(INK);
        doc.y = top;
        for (const child of item.tokens) {
          if (child.type === "text" || child.type === "paragraph") {
            doc.x = x + 18;
            inline(
              doc,
              (child as Tokens.Text).tokens ?? [child],
              { font: "regular" },
              { width: w - 18, lineGap: 2 },
            );
          } else {
            block(doc, child, indent + 18);
          }
        }
        doc.moveDown(0.2);
      });
      doc.x = doc.page.margins.left;
      doc.moveDown(0.4);
      break;
    }
    case "table":
      table(doc, token as Tokens.Table, x, w);
      break;
    case "code": {
      const code = token as Tokens.Code;
      ensureSpace(doc, BODY * 3);
      doc
        .font("mono")
        .fontSize(BODY - 1)
        .fillColor(INK)
        .text(code.text, x + 8, doc.y, { width: w - 16 });
      doc.font("regular").fontSize(BODY).moveDown(0.6);
      doc.x = doc.page.margins.left;
      break;
    }
    case "blockquote": {
      const top = doc.y;
      for (const child of (token as Tokens.Blockquote).tokens) block(doc, child, indent + 14);
      doc
        .moveTo(x + 4, top)
        .lineTo(x + 4, doc.y - 6)
        .strokeColor(LINE)
        .lineWidth(2)
        .stroke();
      break;
    }
    case "hr":
      doc.moveDown(0.3);
      doc
        .moveTo(x, doc.y)
        .lineTo(x + w, doc.y)
        .strokeColor(LINE)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.6);
      break;
    case "html":
      doc.x = x;
      doc.font("regular").text(decode((token as Tokens.HTML).text), { width: w });
      break;
    case "space":
      break;
    default:
      if ("text" in token && typeof token.text === "string") {
        doc.x = x;
        doc.text(decode(token.text), { width: w });
      }
  }
}

/**
 * A simple grid table: header in bold, rows that grow with their text. Column widths follow
 * the length of their content (each column gets at least 12% of the width).
 */
function table(doc: Doc, t: Tokens.Table, x: number, w: number) {
  const pad = 4;
  const cellText = (cell: Tokens.TableCell) => decode(cell.text.replace(/\*\*|__|`/g, ""));
  const weights = t.header.map((h, i) => {
    const cells = [h, ...t.rows.map((r) => r[i]).filter((c) => c !== undefined)];
    return Math.max(...cells.map((c) => Math.min(cellText(c).length, 120)), 4);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const minShare = Math.min(0.12, 1 / weights.length);
  const shares = weights.map((wt) => Math.max(minShare, wt / total));
  const norm = shares.reduce((a, b) => a + b, 0);
  const widths = shares.map((s) => (s / norm) * w);
  const offsets = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  const rowHeight = (cells: Tokens.TableCell[], font: keyof typeof FONTS) => {
    doc.font(font).fontSize(BODY - 1);
    return (
      Math.max(
        ...cells.map((c, i) =>
          doc.heightOfString(cellText(c), { width: (widths[i] ?? w) - pad * 2 }),
        ),
      ) +
      pad * 2
    );
  };
  const drawRow = (cells: Tokens.TableCell[], font: keyof typeof FONTS) => {
    const h = rowHeight(cells, font);
    ensureSpace(doc, h);
    const top = doc.y;
    cells.forEach((cell, i) => {
      doc
        .font(font)
        .fontSize(BODY - 1)
        .fillColor(INK)
        .text(cellText(cell), x + (offsets[i] ?? 0) + pad, top + pad, {
          width: (widths[i] ?? w) - pad * 2,
        });
    });
    doc
      .moveTo(x, top + h)
      .lineTo(x + w, top + h)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke();
    doc.y = top + h;
  };
  doc.moveDown(0.2);
  drawRow(t.header, "bold");
  for (const row of t.rows) drawRow(row, "regular");
  doc.font("regular").fontSize(BODY);
  doc.x = doc.page.margins.left;
  doc.moveDown(0.8);
}

/** Page numbers and the title in small print at the bottom of every page. */
function footer(doc: Doc, title: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 20;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // let the footer sit in the margin
    doc.font("regular").fontSize(8).fillColor(MUTED);
    doc.text(title.length > 80 ? `${title.slice(0, 77)}…` : title, doc.page.margins.left, y, {
      width: width(doc) - 60,
      lineBreak: false,
    });
    doc.text(`${i + 1} / ${range.count}`, doc.page.margins.left, y, {
      width: width(doc),
      align: "right",
      lineBreak: false,
    });
    doc.page.margins.bottom = bottom;
  }
}

/** marked keeps HTML entities escaped in token text; turn the common ones back into characters. */
function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
