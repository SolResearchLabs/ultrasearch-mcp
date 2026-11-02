import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import { providerApiKey, providerOption } from "../runtime-config.js";
import type { SearxResult } from "../types.js";
import { runHostedSearchProvider } from "./control.js";
import type { HostedSearchProvider, HostedSearchRequest } from "./types.js";
import { clampResults, siteList, timeRangeStartIso } from "./utils.js";

interface DeepSeekResult {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  date?: string | null;
  authority?: number;
}

interface DeepSeekResponse {
  results?: DeepSeekResult[];
}

function apiKey(): string | undefined {
  return providerApiKey("deepseek", [
    "ULTRASEARCH_DEEPSEEK_API_KEY",
    "DEEPSEEK_API_KEY",
  ]);
}

function needContent(): boolean {
  const raw = providerOption("deepseek", "needContent", [
    "ULTRASEARCH_DEEPSEEK_SEARCH_NEED_CONTENT",
    "DEEPSEEK_SEARCH_NEED_CONTENT",
  ])
    ?.trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw ?? "");
}

function languageOperator(language?: string): string | undefined {
  if (!language || language === "all") return undefined;
  const primary = language.toLowerCase().split("-")[0];
  return /^[a-z]{2,3}$/.test(primary) ? `lang:${primary}` : undefined;
}

function fitQuery(base: string, operators: string[]): string {
  let query = base.trim().slice(0, 128);
  for (const operator of operators) {
    const candidate = `${query} ${operator}`;
    if (candidate.length <= 128) query = candidate;
  }
  return query;
}

function searchQuery(request: HostedSearchRequest): string {
  const operators: string[] = [];
  const sites = siteList(request.site);
  if (sites.length === 1) {
    operators.push(`site:${sites[0]}`);
  } else if (sites.length > 1) {
    operators.push(sites.map((site) => `site:${site}`).join(" OR "));
  }

  const language = languageOperator(request.language);
  if (language) operators.push(language);

  const after = timeRangeStartIso(request.timeRange)?.slice(0, 10);
  if (after) operators.push(`after:${after}`);

  return fitQuery(request.query, operators);
}

export const deepseekSearchProvider: HostedSearchProvider = {
  id: "deepseek",
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
    return runHostedSearchProvider("deepseek", controlKey, async () => {
      const res = await fetch("https://api.deepseek.com/v1/tools/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: searchQuery(request),
          count: clampResults(request.numResults, 50),
          need_content: needContent(),
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new ProviderHttpError(
          "deepseek",
          res.status,
          `DeepSeek search error: ${res.status} ${res.statusText}`,
          parseRetryAfterMs(res.headers.get("Retry-After")),
        );
      }

      const data = (await res.json()) as DeepSeekResponse;
      return (data.results ?? [])
        .filter((result) => Boolean(result.url))
        .slice(0, request.numResults)
        .map((result) => ({
          title: result.title || result.url || "Untitled",
          url: result.url as string,
          content:
            result.content?.trim() ||
            result.summary?.trim() ||
            result.snippet?.trim(),
          engine: "deepseek",
          engines: ["deepseek"],
          publishedDate: result.date ?? undefined,
        }));
    });
  },
};
