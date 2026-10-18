import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Turns a web page into clean article text. Mozilla Readability (the engine behind Firefox's
 * Reader View) removes navigation, ads and boilerplate. Scholarly metadata (citation_* meta
 * tags, used by Google Scholar) gives us authors and dates when the page has them.
 */
export type ExtractedPage = {
  title?: string;
  authors?: string[];
  publishedAt?: string;
  siteName?: string;
  text: string;
};

export function extractHtml(html: string): ExtractedPage {
  const { document } = parseHTML(html);
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  const metaAll = (selector: string) =>
    [...document.querySelectorAll(selector)]
      .map((el) => el.getAttribute("content")?.trim())
      .filter((v): v is string => Boolean(v));

  // Read metadata first: Readability modifies the document.
  const title =
    meta('meta[name="citation_title"]') ??
    meta('meta[property="og:title"]') ??
    (document.querySelector("title")?.textContent?.trim() || undefined);
  const authors = metaAll('meta[name="citation_author"]');
  const publishedAt =
    meta('meta[name="citation_publication_date"]') ??
    meta('meta[property="article:published_time"]');
  const siteName = meta('meta[property="og:site_name"]');

  let text = "";
  try {
    // linkedom's document is close enough to the DOM Readability expects.
    const readable = document as unknown as ConstructorParameters<typeof Readability>[0];
    const article = new Readability(readable, { charThreshold: 200 }).parse();
    if (article?.content) text = htmlToText(article.content);
  } catch {
    // fall back to the whole body below
  }
  if (text.length < 200) {
    const { document: fresh } = parseHTML(html);
    fresh
      .querySelectorAll("script,style,noscript,nav,header,footer,aside,form")
      .forEach((el: { remove(): void }) => el.remove());
    text = htmlToText(fresh.body?.innerHTML ?? "");
  }

  return {
    title,
    authors: authors.length ? authors : undefined,
    publishedAt,
    siteName,
    text,
  };
}

/** Block elements become paragraph breaks so the chunker sees real paragraphs. */
function htmlToText(html: string): string {
  const spaced = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr|section|article|figcaption)>/gi, "$&\n\n");
  const { document } = parseHTML(`<!doctype html><html><body>${spaced}</body></html>`);
  return (document.body?.textContent ?? "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
