/**
 * URL helpers for deduplicating sources and applying domain rules.
 *
 * Canonical URLs make the "same page" compare equal even when links differ cosmetically:
 * https://www.Example.com:443/a/?utm_source=x#intro  →  https://example.com/a
 * arXiv links (abs/pdf, with or without version) all map to https://arxiv.org/abs/<id>.
 */

const TRACKING_PARAMS =
  /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|igshid|_hsenc|_hsmi)$/i;

export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.username = "";
  url.password = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  // http and https almost always serve the same document; treat them as one.
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.port === "80" || url.port === "443") url.port = "";

  if (url.hostname === "arxiv.org" || url.hostname === "export.arxiv.org") {
    const id = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/)?.[1];
    if (id) return `https://arxiv.org/abs/${id}`;
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(params).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function domainOf(raw: string): string {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
}

export type DomainPolicy = { blocked: string[]; allowed: string[] };

export function parseDomainList(value: string): string[] {
  return value
    .split(",")
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^www\./, ""),
    )
    .filter(Boolean);
}

const matches = (domain: string, rule: string) => domain === rule || domain.endsWith(`.${rule}`);

/**
 * Simple domain rules (Phase 6). Phase 8 replaces this with versioned org policies checked
 * by the policy gateway. Returns a reason when the URL may not be fetched.
 */
export function checkDomain(raw: string, policy: DomainPolicy): string | null {
  const domain = domainOf(raw);
  if (policy.blocked.some((rule) => matches(domain, rule))) return `Domain ${domain} is blocked`;
  if (policy.allowed.length > 0 && !policy.allowed.some((rule) => matches(domain, rule))) {
    return `Domain ${domain} is not on the allowed list`;
  }
  return null;
}
