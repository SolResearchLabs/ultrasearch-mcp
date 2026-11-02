import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import { providerApiKey } from "../runtime-config.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { clampResults, siteList } from "./utils.js";

interface YouSearchResult {
  url?: string;
  title?: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
}

interface YouSearchResponse {
  results?: {
    web?: YouSearchResult[];
  };
}

function apiKey(): string | undefined {
  return providerApiKey("you", [
    "ULTRASEARCH_YOU_API_KEY",
    "YDC_API_KEY",
    "YOU_API_KEY",
  ]);
}

function searchLanguage(language?: string): string | undefined {
  if (!language || language === "all") return undefined;
  return language.toUpperCase();
}

export const youSearchProvider: HostedSearchProvider = {
  id: "you",
  capabilities: {
    semantic: false,
    recency: true,
    domains: true,
    news: true,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("you", controlKey, async () => {
      const body: Record<string, unknown> = {
        query: request.query,
        count: clampResults(request.numResults, 100),
      };

      if (request.timeRange) body.freshness = request.timeRange;

      const language = searchLanguage(request.language);
      if (language) body.language = language;

      const sites = siteList(request.site);
      if (sites.length > 0) body.include_domains = sites;

      const res = await fetch("https://ydc-index.io/v1/search", {
        method: "POST",
        headers: {
          "X-API-Key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "you",
          res.status,
          `You.com search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as YouSearchResponse;
      return (data.results?.web ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content:
            (result.snippets ?? []).filter(Boolean).join("\n") ||
            result.description,
          engine: "you",
          engines: ["you"],
          publishedDate: result.page_age,
        }));
    });
  },
};
