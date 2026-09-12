import { cacheGet, cacheSet, searchCacheKey } from "./cache.js";
import {
  CACHE_TTL_SECONDS,
  EXPAND_QUERIES_DEFAULT,
  SEARXNG_URL,
} from "./config.js";
import {
  getControlPlaneConfig,
  type ResolvedRoutingPolicy,
  resolveRoutingPolicy,
} from "./control-plane/index.js";
import { normalizeHostname, recordSearchAppearance } from "./domain-db.js";
import { applyDomainFilters } from "./domains.js";
import { withSpan } from "./observability.js";
import { expandQuery } from "./ollama.js";
import { runSearxng } from "./provider-control.js";
import { ProviderHttpError, parseRetryAfterMs } from "./provider-errors.js";
import {
  collectSearchEngines,
  searchRouteForCacheHit,
} from "./research-route.js";
import {
  describeHostedSearchAttempts,
  hasUsefulPrimarySearch,
  searchHostedFallbackWithAttempts,
} from "./search-providers/index.js";
import type {
  SearchRoute,
  SearxMeta,
  SearxResponse,
  SearxResult,
  SearxSearchResult,
} from "./types.js";

const EMPTY_META: SearxMeta = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

// Fire-and-forget: mark each unique domain among the results as "seen in
// search" so dump-domain can distinguish that from "never seen at all".
// Cheap by design - deduplicated to one write per unique domain (not per
// result URL), no fetch performed, and never awaited on the response path.
function recordSearchAppearances(results: SearxResult[]): void {
  const domains = new Set<string>();
  for (const r of results) {
    const host = normalizeHostname(r.url);
    if (host) domains.add(host);
  }
  for (const host of domains) {
    recordSearchAppearance(host).catch(() => {});
  }
}

// Build a `site:` query prefix from a single domain or a list. Best-effort:
// most engines (Google, Bing, DDG, Brave) honor the site: operator, but some
// ignore it - documented in the tool descriptions, not guaranteed here.
function siteFilterPrefix(site?: string | string[]): string {
  if (!site) return "";
  const domains = (Array.isArray(site) ? site : [site])
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) return "";
  if (domains.length === 1) return `site:${domains[0]} `;
  return `(${domains.map((d) => `site:${d}`).join(" OR ")}) `;
}

// Collapse SearXNG's version-varying answers/infoboxes/corrections/suggestions
// into the normalized SearxMeta shape. Silently drops empty entries.
export function normalizeSearxMeta(data: SearxResponse): SearxMeta {
  const answers = (data.answers ?? [])
    .map((a) =>
      typeof a === "string"
        ? { answer: a }
        : { answer: a.answer ?? a.content ?? "", url: a.url },
    )
    .filter((a) => a.answer.trim().length > 0);

  const infoboxes = (data.infoboxes ?? [])
    .map((ib) => ({
      title: ib.infobox ?? "",
      content: ib.content ?? "",
      url: ib.urls?.[0]?.url,
    }))
    .filter((ib) => ib.title.trim().length > 0 || ib.content.trim().length > 0);

  const corrections = (data.corrections ?? [])
    .map((c) => (typeof c === "string" ? c : (c.title ?? "")))
    .filter((c) => c.trim().length > 0);

  const suggestions = (data.suggestions ?? []).filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );

  return { answers, infoboxes, corrections, suggestions };
}

export async function searxSearchSingle(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const controlKey = JSON.stringify([
    query,
    category,
    fetchCount,
    timeRange ?? "",
    language ?? "",
    engines ?? "",
    Array.isArray(site) ? site : (site ?? ""),
  ]);

  return runSearxng(controlKey, () =>
    withSpan(
      "searxng_request",
      { "search.category": category, "search.time_range": timeRange },
      async () => {
        const params = new URLSearchParams({
          q: siteFilterPrefix(site) + query,
          format: "json",
          categories: category,
          pageno: "1",
        });
        if (timeRange) params.set("time_range", timeRange);
        if (language) params.set("language", language);
        // Arbitrary engine selection, forwarded verbatim. Unknown/disabled engine
        // names degrade at SearXNG (empty results), matching how `category` fails
        // soft rather than erroring.
        if (engines) params.set("engines", engines);

        const res = await fetch(`${SEARXNG_URL}/search?${params}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          throw new ProviderHttpError(
            "searxng",
            res.status,
            `SearXNG error: ${res.status} ${res.statusText}`,
            parseRetryAfterMs(res.headers.get("Retry-After")),
          );
        }

        const data = (await res.json()) as SearxResponse;
        const results = data.results.slice(0, fetchCount);
        return {
          results,
          meta: normalizeSearxMeta(data),
          route: {
            provider: "searxng",
            engines: collectSearchEngines(results),
          },
        };
      },
    ),
  );
}

function hostedFallbackAllowed(
  policy: ResolvedRoutingPolicy,
  engines?: string,
): boolean {
  if (!engines) return true;
  // An explicit SearXNG engine constraint is a caller instruction that hosted
  // providers cannot faithfully reproduce. Preserve it unless an operator
  // consciously opts into best-effort cross-provider escalation through the
  // resolved Control Plane policy.
  return policy.hostedSearch.withEngineFilter;
}

function mergeHybridSupplementResults(
  localResults: SearxResult[],
  hostedResults: SearxResult[],
): SearxResult[] {
  const seenUrls = new Set<string>();
  const merged: SearxResult[] = [];

  for (const result of [...localResults, ...hostedResults]) {
    if (seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    merged.push(result);
  }

  return merged;
}

function hasUsableLocalSearch(primary: SearxSearchResult): boolean {
  return (
    primary.results.length > 0 ||
    primary.meta.answers.length > 0 ||
    primary.meta.infoboxes.length > 0
  );
}

function offlineSourceUnavailable(): SearxSearchResult {
  return {
    results: [],
    meta: EMPTY_META,
    diagnostic: {
      code: "offline_source_unavailable",
      mode: "offline_fetch_only",
      message:
        "Offline fetch mode has no configured offline search source for this query.",
    },
  };
}

async function hostedSearchPrimary(
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const fallback = await searchHostedFallbackWithAttempts({
    query,
    numResults: fetchCount,
    category,
    timeRange,
    language,
    site,
  });

  if (!fallback.result) {
    return { results: [], meta: EMPTY_META };
  }

  return {
    results: fallback.result.results,
    meta: fallback.result.meta,
    route: { provider: fallback.result.provider },
  };
}

async function localSearchWithRoutingPolicy(
  policy: ResolvedRoutingPolicy,
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  let primary: SearxSearchResult | null = null;
  let primaryError: unknown;

  try {
    primary = await searxSearchSingle(
      query,
      category,
      fetchCount,
      timeRange,
      language,
      engines,
      site,
    );
    if (
      policy.hostedSearch.invocation === "never" ||
      (policy.hostedSearch.invocation ===
        "after_local_hard_failure_or_zero_usable_results" &&
        hasUsableLocalSearch(primary)) ||
      (policy.hostedSearch.invocation === "sequential_supplement_or_fallback" &&
        hasUsefulPrimarySearch(primary.results.length, primary.meta))
    ) {
      return primary;
    }
  } catch (err) {
    primaryError = err;
  }

  let fallbackAttemptSummary: string | undefined;

  if (policy.hostedSearch.enabled && hostedFallbackAllowed(policy, engines)) {
    const fallback = await searchHostedFallbackWithAttempts({
      query,
      numResults: fetchCount,
      category,
      timeRange,
      language,
      site,
    });
    fallbackAttemptSummary = fallback.enabled
      ? describeHostedSearchAttempts(fallback.attempts)
      : undefined;
    if (fallback.result) {
      // A hybrid follow-up supplements a weak local result set rather than
      // replacing it. Local results stay first and retain their metadata; the
      // existing route shape records the hosted escalation provider.
      return {
        results:
          policy.hostedSearch.invocation ===
            "sequential_supplement_or_fallback" && primary
            ? mergeHybridSupplementResults(
                primary.results,
                fallback.result.results,
              )
            : fallback.result.results,
        meta: primary?.meta ?? fallback.result.meta,
        route: { provider: fallback.result.provider, fallback: true },
      };
    }
  }

  if (primary) return primary;
  const primaryMessage =
    primaryError instanceof Error
      ? primaryError.message
      : "unknown primary error";
  throw fallbackAttemptSummary
    ? new Error(
        `SearXNG search failed (${primaryMessage}); hosted fallback did not produce results (${fallbackAttemptSummary})`,
      )
    : primaryError instanceof Error
      ? primaryError
      : new Error("SearXNG search failed and no hosted fallback succeeded");
}

export async function searxSearch(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
  domainProfile?: string,
  expand?: boolean,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const policy = resolveRoutingPolicy(getControlPlaneConfig());

  // Offline mode deliberately bypasses even the cache because its current
  // backend may be remote Valkey. This guarantees no live network or provider
  // call until an explicit offline search source is added.
  if (policy.mode === "offline_fetch_only") {
    return offlineSourceUnavailable();
  }

  const shouldExpand =
    policy.localSearch.enabled && (expand ?? EXPAND_QUERIES_DEFAULT);

  // Cache key must discriminate on engines/site - same query text with a
  // different engine set, site filter, or routing mode is a different search.
  const siteKey = Array.isArray(site) ? site.join(",") : (site ?? "");
  const cacheKeyInput = `${query}|engines=${engines ?? ""}|site=${siteKey}|routingMode=${policy.mode}`;
  const key = searchCacheKey(cacheKeyInput, category, timeRange);
  const cached = await cacheGet(key);
  if (cached && !shouldExpand) {
    try {
      const parsed = JSON.parse(cached) as
        | SearxResult[]
        | { results: SearxResult[]; meta?: SearxMeta; route?: SearchRoute };
      const results = Array.isArray(parsed) ? parsed : parsed.results;
      const meta = Array.isArray(parsed)
        ? EMPTY_META
        : (parsed.meta ?? EMPTY_META);
      // Cache-hit provenance: keep the original provider if the entry carries
      // it; a legacy entry without stored provenance honestly reports "cache"
      // (never an inferred provider).
      const route = Array.isArray(parsed)
        ? { provider: "cache" as const, cacheHit: true }
        : searchRouteForCacheHit(parsed);
      recordSearchAppearances(results);
      // Domain filtering applied after cache retrieval so profile changes take effect immediately
      return {
        results: applyDomainFilters(results, domainProfile),
        meta,
        route,
      };
    } catch {
      // Corrupted cache entry - fall through to live fetch
    }
  }

  // Fetch more than needed so reranker has a larger pool to work with.
  const fetchCount = Math.min(numResults * 3, 20);

  if (shouldExpand) {
    // Only the original query is allowed to activate hosted fallback. Expanded
    // variants remain SearXNG-only so one user request cannot multiply hosted
    // search spend across query-rewrite variants.
    const [variants, original] = await Promise.all([
      withSpan("expand_query", { "query.expand": true }, () =>
        expandQuery(query),
      ),
      localSearchWithRoutingPolicy(
        policy,
        query,
        category,
        fetchCount,
        timeRange,
        language,
        engines,
        site,
      ),
    ]);

    const variantResults = await Promise.allSettled(
      variants.map((v) =>
        searxSearchSingle(
          v,
          category,
          fetchCount,
          timeRange,
          language,
          engines,
          site,
        ),
      ),
    );

    // Merge: original results first, then variant results; deduplicate by URL.
    // Meta comes from the original query only.
    const seen = new Set<string>();
    const merged: SearxResult[] = [];
    for (const r of original.results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        merged.push(r);
      }
    }
    for (const settled of variantResults) {
      if (settled.status === "fulfilled") {
        for (const r of settled.value.results) {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            merged.push(r);
          }
        }
      }
    }

    // Cache only the original-query result set, including a hosted fallback if
    // one was needed. This prevents repeatedly spending hosted quota for the
    // same query while keeping expanded-variant content out of the base cache.
    // The route is persisted so a later cache hit can say "originally X".
    await cacheSet(
      key,
      JSON.stringify({
        results: original.results,
        meta: original.meta,
        route: original.route,
      }),
      CACHE_TTL_SECONDS,
    );

    recordSearchAppearances(merged);
    return {
      results: applyDomainFilters(merged, domainProfile),
      meta: original.meta,
      route: original.route,
    };
  }

  const raw = policy.localSearch.enabled
    ? await localSearchWithRoutingPolicy(
        policy,
        query,
        category,
        fetchCount,
        timeRange,
        language,
        engines,
        site,
      )
    : await hostedSearchPrimary(
        query,
        category,
        fetchCount,
        timeRange,
        language,
        site,
      );

  // Cache pre-filter results so domain config changes apply retroactively on cache hits.
  await cacheSet(
    key,
    JSON.stringify({ results: raw.results, meta: raw.meta, route: raw.route }),
    CACHE_TTL_SECONDS,
  );

  recordSearchAppearances(raw.results);
  return {
    results: applyDomainFilters(raw.results, domainProfile),
    meta: raw.meta,
    route: raw.route,
  };
}
