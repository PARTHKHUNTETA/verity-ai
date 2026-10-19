import { readFileSync, writeFileSync } from "node:fs";
import { Marked, type Tokens } from "marked";

/**
 * `npm run docs:build`: turns docs/ARCHITECTURE.md into docs/architecture.html, a single page
 * you can open in a browser: sidebar table of contents, styled tables, and Mermaid diagrams
 * rendered client-side (Mermaid is loaded from a pinned CDN build; offline, diagrams show as
 * their source text). The Markdown stays the source of truth: never edit the HTML by hand.
 */

const SOURCE = "docs/ARCHITECTURE.md";
const TARGET = "docs/architecture.html";
const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const toc: Array<{ depth: number; id: string; text: string }> = [];
let title = "VerityAI Backend — Architecture";

const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }: Tokens.Heading) {
      const html = this.parser.parseInline(tokens);
      const text = html.replace(/<[^>]+>/g, "");
      if (depth === 1) {
        title = text;
        return `<h1>${html}</h1>\n`;
      }
      const id = slugify(text);
      if (depth <= 3) toc.push({ depth, id, text });
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}">#</a>${html}</h${depth}>\n`;
    },
    code({ text, lang }: Tokens.Code) {
      if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
      return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>\n`;
    },
    table(token: Tokens.Table) {
      // Wide tables scroll inside their own box instead of widening the page.
      const head = token.header
        .map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`)
        .join("");
      const rows = token.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`,
        )
        .join("\n");
      return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
    },
  },
});

const body = await marked.parse(readFileSync(SOURCE, "utf8"));
const nav = toc
  .map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${t.text}</a></li>`)
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="generator" content="npm run docs:build (from ${SOURCE})">
<style>
  :root {
    --ink: #0f172a; --muted: #475569; --subtle: #94a3b8; --line: #e2e8f0;
    --surface: #ffffff; --canvas: #f8fafc; --brand: #4f46e5; --brand-soft: #eef2ff; --code: #f1f5f9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e2e8f0; --muted: #a8b3c4; --subtle: #64748b; --line: #263042;
      --surface: #111827; --canvas: #0b1120; --brand: #a5b4fc; --brand-soft: #1e1b4b; --code: #1a2233;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 16px; }
  body { margin: 0; background: var(--canvas); color: var(--ink);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); max-width: 1280px; margin: 0 auto; }
  nav { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 24px 16px;
    border-right: 1px solid var(--line); background: var(--surface); }
  nav .brand { font-weight: 700; font-size: 15px; margin: 0 0 4px; }
  nav .brand span { color: var(--brand); }
  nav .tag { color: var(--muted); font-size: 12px; margin: 0 0 16px; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li a { display: block; padding: 4px 8px; border-radius: 6px; color: var(--muted);
    text-decoration: none; font-size: 13px; }
  nav li a:hover { background: var(--brand-soft); color: var(--ink); }
  nav li.d3 a { padding-left: 22px; font-size: 12px; }
  main { padding: 32px 40px 80px; min-width: 0; }
  h1 { font-size: 28px; line-height: 1.25; margin: 0 0 8px; }
  h2 { font-size: 21px; margin: 48px 0 12px; padding-top: 8px; border-top: 1px solid var(--line); }
  h3 { font-size: 16px; margin: 28px 0 8px; }
  h2, h3 { position: relative; }
  .anchor { position: absolute; left: -18px; color: var(--subtle); text-decoration: none; opacity: 0; }
  h2:hover .anchor, h3:hover .anchor { opacity: 1; }
  p, li { color: var(--ink); }
  a { color: var(--brand); }
  blockquote { margin: 0 0 16px; padding: 8px 14px; border-left: 3px solid var(--brand);
    background: var(--brand-soft); border-radius: 0 8px 8px 0; color: var(--muted); }
  blockquote p { margin: 0; color: inherit; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code);
    padding: 1px 5px; border-radius: 4px; }
  pre { background: var(--code); padding: 14px 16px; border-radius: 10px; overflow-x: auto;
    border: 1px solid var(--line); }
  pre code { background: none; padding: 0; }
  pre.mermaid { background: var(--surface); text-align: center; white-space: pre; }
  .table { overflow-x: auto; margin: 12px 0 20px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--surface); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; background: var(--canvas); white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
  .menu { display: none; }
  @media (max-width: 860px) {
    .layout { display: block; }
    nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); padding: 16px; }
    nav ul { display: none; }
    nav.open ul { display: block; }
    .menu { display: inline-block; margin-top: 4px; padding: 6px 12px; font: inherit; font-size: 13px;
      border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink); }
    main { padding: 20px 16px 60px; }
    h1 { font-size: 23px; }
  }
</style>
</head>
<body>
<div class="layout">
  <nav id="toc">
    <p class="brand">Verity<span>AI</span> backend</p>
    <p class="tag">Architecture</p>
    <button class="menu" type="button" onclick="document.getElementById('toc').classList.toggle('open')">Contents</button>
    <ul>
${nav}
    </ul>
  </nav>
  <main>
${body}
  </main>
</div>
<script type="module">
  try {
    const { default: mermaid } = await import("${MERMAID}");
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
    await mermaid.run({ querySelector: "pre.mermaid" });
  } catch (err) {
    console.warn("Diagrams not rendered (offline?):", err);
  }
  // On phones, close the contents after picking a section.
  document.querySelectorAll("#toc a").forEach((a) =>
    a.addEventListener("click", () => document.getElementById("toc").classList.remove("open")),
  );
</script>
</body>
</html>
`;

writeFileSync(TARGET, html);
console.log(`Wrote ${TARGET} (${toc.length} sections) from ${SOURCE}`);
