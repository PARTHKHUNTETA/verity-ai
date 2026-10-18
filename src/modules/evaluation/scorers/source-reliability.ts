import type { SourceType } from "../../../infrastructure/database/schema/index.js";

/**
 * Source reliability (deterministic heuristic, 0–1): what kind of publisher is this, and how
 * old is it? A heuristic, not a fact check: a blog post can be right and a journal wrong.
 * It answers "how much should a careful reader trust this source by default?".
 */

export type SourceInfo = {
  type: SourceType;
  domain: string | null;
  doi: string | null;
  publishedAt: string | null;
};

/** Publishers with editorial review or institutional accountability. */
const HIGH = [
  "nature.com",
  "science.org",
  "acm.org",
  "ieee.org",
  "springer.com",
  "sciencedirect.com",
  "wiley.com",
  "nih.gov",
  "who.int",
  "openreview.net",
  "aclanthology.org",
  "neurips.cc",
  "jmlr.org",
  "pnas.org",
  "cell.com",
  "thelancet.com",
  "nejm.org",
];
/** Preprint servers and paper indexes: real research, not yet peer reviewed. */
const PREPRINT = ["arxiv.org", "biorxiv.org", "medrxiv.org", "ssrn.com", "semanticscholar.org"];
/** Self-published or user-generated content. */
const LOW = [
  "medium.com",
  "substack.com",
  "blogspot.com",
  "wordpress.com",
  "reddit.com",
  "quora.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "tumblr.com",
];
const REFERENCE = ["wikipedia.org", "britannica.com"];

const matches = (domain: string, list: string[]) =>
  list.some((d) => domain === d || domain.endsWith(`.${d}`));

function base(source: SourceInfo): { score: number; reason: string } {
  const domain = source.domain?.toLowerCase().replace(/^www\./, "") ?? null;
  if (source.type === "upload")
    return { score: 0.8, reason: "Uploaded by your team (curated, provenance not checked)" };
  if (domain && matches(domain, HIGH)) return { score: 0.9, reason: "Peer-reviewed publisher" };
  if (source.doi) return { score: 0.85, reason: "Published work with a DOI" };
  if (domain && matches(domain, PREPRINT))
    return { score: 0.75, reason: "Preprint (not yet peer reviewed)" };
  if (domain && /(\.gov|\.edu|\.int|\.ac\.[a-z]{2}|\.edu\.[a-z]{2}|\.gov\.[a-z]{2})$/.test(domain))
    return { score: 0.85, reason: "Government, university or intergovernmental site" };
  if (domain && matches(domain, REFERENCE))
    return { score: 0.65, reason: "Reference work (good overview, cite primary sources)" };
  if (domain && matches(domain, LOW))
    return { score: 0.4, reason: "Self-published or user-generated content" };
  if (source.type === "paper") return { score: 0.75, reason: "Academic paper" };
  return { score: 0.6, reason: "General web page" };
}

export function sourceReliability(source: SourceInfo, now = new Date()) {
  const { score, reason } = base(source);
  const years = source.publishedAt
    ? (now.getTime() - new Date(source.publishedAt).getTime()) / (365.25 * 24 * 3600 * 1000)
    : null;
  // Old sources may be outdated; uploads are exempt (the team chose them deliberately).
  if (years !== null && years > 10 && source.type !== "upload") {
    return { score: Math.round((score - 0.1) * 100) / 100, reason: `${reason}; over 10 years old` };
  }
  return { score, reason };
}

/** Mean reliability of the cited sources; null when nothing was cited. */
export function meanReliability(scores: number[]): number | null {
  return scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000
    : null;
}
