import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import { providerApiKey } from "../runtime-config.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { clampResults, siteList } from "./utils.js";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

function apiKey(): string | undefined {
  return providerApiKey("tavily", [
    "ULTRASEARCH_TAVILY_API_KEY",
    "TAVILY_API_KEY",
  ]);
}

export const tavilySearchProvider: HostedSearchProvider = {
  id: "tavily",
  capabilities: {
    semantic: true,
    recency: true,
    domains: true,
    news: true,
  },
  configured: () => Boolean(apiKey()),
  async search(request: HostedSearchRequest): Promise<SearxResult[]> {
    const key = apiKey();
    if (!key) return [];

    const controlKey = JSON.stringify(request);
    return runHostedSearchProvider("tavily", controlKey, async () => {
      const body: Record<string, unknown> = {
        query: request.query,
        search_depth: "basic",
        max_results: clampResults(request.numResults, 20),
        include_answer: false,
        include_raw_content: false,
        topic: request.category === "news" ? "news" : "general",
      };

      const sites = siteList(request.site);
      if (sites.length > 0) body.include_domains = sites;
      if (request.timeRange) body.time_range = request.timeRange;

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "tavily",
          res.status,
          `Tavily search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as TavilyResponse;
      return (data.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content: result.content,
          engine: "tavily",
          engines: ["tavily"],
          publishedDate: result.published_date,
        }));
    });
  },
};
