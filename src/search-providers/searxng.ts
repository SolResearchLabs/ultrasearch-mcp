import { SEARXNG_URL } from "../config.js";
import { withSpan } from "../observability.js";
import { runSearxng } from "../provider-control.js";
import { ProviderHttpError, parseRetryAfterMs } from "../provider-errors.js";
import { collectSearchEngines } from "../research-route.js";
import {
  type LocalSearchMetadata,
  type LocalSearchResult,
  localSearchResultToSearxSearchResult,
  type SearxMeta,
  type SearxResponse,
  type SearxResult,
  type SearxSearchResult,
} from "../types.js";
import type { LocalSearchProvider, LocalSearchRequest } from "./local.js";

function siteFilterPrefix(siteFilter?: string | string[]): string {
  if (!siteFilter) return "";
  const domains = (Array.isArray(siteFilter) ? siteFilter : [siteFilter])
    .map((domain) => domain.trim())
    .filter(Boolean);
  if (domains.length === 0) return "";
  if (domains.length === 1) return `site:${domains[0]} `;
  return `(${domains.map((domain) => `site:${domain}`).join(" OR ")}) `;
}

// Collapse SearXNG's version-varying answers/infoboxes/corrections/suggestions
// into the normalized SearxMeta shape. Silently drops empty entries.
export function normalizeSearxMeta(data: SearxResponse): SearxMeta {
  const answers = (data.answers ?? [])
    .map((answer) =>
      typeof answer === "string"
        ? { answer }
        : { answer: answer.answer ?? answer.content ?? "", url: answer.url },
    )
    .filter((answer) => answer.answer.trim().length > 0);

  const infoboxes = (data.infoboxes ?? [])
    .map((infobox) => ({
      title: infobox.infobox ?? "",
      content: infobox.content ?? "",
      url: infobox.urls?.[0]?.url,
    }))
    .filter(
      (infobox) =>
        infobox.title.trim().length > 0 || infobox.content.trim().length > 0,
    );

  const corrections = (data.corrections ?? [])
    .map((correction) =>
      typeof correction === "string" ? correction : (correction.title ?? ""),
    )
    .filter((correction) => correction.trim().length > 0);

  const suggestions = (data.suggestions ?? []).filter(
    (suggestion) =>
      typeof suggestion === "string" && suggestion.trim().length > 0,
  );

  return { answers, infoboxes, corrections, suggestions };
}

function normalizeSearxMetadata(data: SearxResponse): LocalSearchMetadata {
  const meta = normalizeSearxMeta(data);
  return {
    directAnswers: meta.answers.map((answer) => ({
      text: answer.answer,
      ...(answer.url === undefined ? {} : { url: answer.url }),
    })),
    knowledgeCards: meta.infoboxes.map((infobox) => ({
      title: infobox.title,
      text: infobox.content,
      ...(infobox.url === undefined ? {} : { url: infobox.url }),
    })),
    queryCorrections: meta.corrections,
    querySuggestions: meta.suggestions,
  };
}

function localSearchItem(result: SearxResult) {
  return {
    title: result.title,
    url: result.url,
    ...(result.content === undefined ? {} : { snippet: result.content }),
    ...(result.engine === undefined ? {} : { source: result.engine }),
    ...(result.engines === undefined ? {} : { sources: result.engines }),
    ...(result.publishedDate === undefined
      ? {}
      : { publishedAt: result.publishedDate }),
  };
}

export const searxngSearchProvider: LocalSearchProvider<"searxng"> = {
  id: "searxng",
  displayName: "SearXNG",
  capabilities: {
    categoryFilter: true,
    timeRangeFilter: true,
    languageFilter: true,
    engineFilter: true,
    siteFilter: true,
    directAnswerMetadata: true,
    knowledgeCardMetadata: true,
    queryCorrectionMetadata: true,
    querySuggestionMetadata: true,
    engineMetadata: true,
  },
  async search(request: LocalSearchRequest): Promise<LocalSearchResult> {
    const controlKey = JSON.stringify([
      request.query,
      request.category,
      request.numResults,
      request.timeRange ?? "",
      request.language ?? "",
      request.engineFilter ?? "",
      Array.isArray(request.siteFilter)
        ? request.siteFilter
        : (request.siteFilter ?? ""),
    ]);

    return runSearxng(controlKey, () =>
      withSpan(
        "searxng_request",
        {
          "search.category": request.category,
          "search.time_range": request.timeRange,
        },
        async () => {
          const params = new URLSearchParams({
            q: siteFilterPrefix(request.siteFilter) + request.query,
            format: "json",
            categories: request.category ?? "general",
            pageno: "1",
          });
          if (request.timeRange) params.set("time_range", request.timeRange);
          if (request.language) params.set("language", request.language);
          // Arbitrary engine selection, forwarded verbatim. Unknown/disabled
          // engine names degrade at SearXNG (empty results), matching how
          // `category` fails soft rather than erroring.
          if (request.engineFilter) {
            params.set("engines", request.engineFilter);
          }

          const response = await fetch(`${SEARXNG_URL}/search?${params}`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            throw new ProviderHttpError(
              "searxng",
              response.status,
              `SearXNG error: ${response.status} ${response.statusText}`,
              parseRetryAfterMs(response.headers.get("Retry-After")),
            );
          }

          const data = (await response.json()) as SearxResponse;
          const results = data.results.slice(0, request.numResults);
          return {
            items: results.map(localSearchItem),
            metadata: {
              ...normalizeSearxMetadata(data),
              engineNames: collectSearchEngines(results),
            },
          };
        },
      ),
    );
  },
};

// Preserve the existing named helper while routing it through the provider
// implementation used by Core.
export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const result = await searxngSearchProvider.search({
    query,
    category,
    numResults: fetchCount,
    timeRange,
    language,
    engineFilter: engines,
    siteFilter: site,
  });
  return localSearchResultToSearxSearchResult(result, {
    provider: "searxng",
    includeDirectAnswerMetadata: true,
    includeKnowledgeCardMetadata: true,
    includeQueryCorrectionMetadata: true,
    includeQuerySuggestionMetadata: true,
    includeEngineMetadata: true,
  });
}
