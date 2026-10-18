import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A tiny local web server for fetcher/acquisition tests. Routes map a path to a handler. */
export async function startTestServer(
  routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void>,
) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const handler = routes[req.url ?? ""];
    if (handler) handler(req, res);
    else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits,
    /** URL on a fake public hostname; tests resolve it to 127.0.0.1. */
    url: (path: string, host = "site.test") => `http://${host}:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const ARTICLE_HTML = `<!doctype html><html><head>
<title>Agents in practice — Example Blog</title>
<meta property="og:title" content="How Research Agents Work">
<meta name="citation_author" content="Grace Hopper">
<meta name="citation_publication_date" content="2026/03/05">
</head><body>
<nav>Home | About | Subscribe</nav>
<article>
<h1>How Research Agents Work</h1>
<p>Research agents combine web search with document reading. They search for candidate sources, fetch the most promising ones, and extract evidence before writing an answer.</p>
<p>Good research agents cite every claim. Citation accuracy matters more than fluency, because readers need to verify statements quickly against the original passages.</p>
<p>Evaluation of research agents focuses on claim support, source reliability and task completion rather than writing style alone.</p>
</article>
<footer>© Example Blog</footer>
</body></html>`;
