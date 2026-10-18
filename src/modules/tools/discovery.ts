import type { Env } from "../../config/env.js";
import {
  createArxivProvider,
  createSemanticScholarProvider,
  createTavilyProvider,
  type DiscoveryProviders,
} from "./search.tool.js";

/** Builds the discovery providers from configuration. Missing keys simply disable a provider. */
export function discoveryProvidersFrom(
  env: Pick<
    Env,
    "WEB_SEARCH_PROVIDER" | "TAVILY_API_KEY" | "ACADEMIC_SEARCH" | "SEMANTIC_SCHOLAR_API_KEY"
  >,
): DiscoveryProviders {
  const web =
    env.WEB_SEARCH_PROVIDER === "tavily" && env.TAVILY_API_KEY
      ? createTavilyProvider(env.TAVILY_API_KEY)
      : null;
  const academic = env.ACADEMIC_SEARCH.map((name) =>
    name === "arxiv"
      ? createArxivProvider()
      : createSemanticScholarProvider(env.SEMANTIC_SCHOLAR_API_KEY),
  );
  return { web, academic };
}

export function capabilitiesOf(providers: DiscoveryProviders) {
  return {
    webSearch: providers.web?.name ?? null,
    academicSearch: providers.academic.map((p) => p.name),
  };
}
