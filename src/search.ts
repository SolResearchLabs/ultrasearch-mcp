import { cacheGet, cacheSet, searchCacheKey } from "./cache.js";
import { CACHE_TTL_SECONDS, EXPAND_QUERIES_DEFAULT } from "./config.js";
import {
  getControlPlaneConfig,
  type ResolvedRoutingPolicy,
  resolveRoutingPolicy,
} from "./control-plane/index.js";
import { normalizeHostname, recordSearchAppearance } from "./domain-db.js";
import { applyDomainFilters } from "./domains.js";
import { withSpan } from "./observability.js";
import { expandQuery } from "./ollama.js";
import { searchRouteForCacheHit } from "./research-route.js";
import {
  describeHostedSearchAttempts,
  hasUsefulPrimarySearch,
  searchHostedFallbackWithAttempts,
} from "./search-providers/index.js";
import {
  getActiveLocalSearchProvider,
  type LocalSearchCapabilities,
  type LocalSearchProvider,
  type LocalSearchRequest,
  searchWithLocalProvider,
} from "./search-providers/local.js";
import type {
  SearchRoute,
  SearxMeta,
  SearxResult,
  SearxSearchResult,
} from "./types.js";
import { localSearchResultToSearxSearchResult } from "./types.js";

export {
  normalizeSearxMeta,
  searxSearchSingle,
} from "./search-providers/searxng.js";

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

function localSearchRequest(
  capabilities: LocalSearchCapabilities,
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): LocalSearchRequest {
  return {
    query,
    numResults: fetchCount,
    ...(capabilities.categoryFilter ? { category } : {}),
    ...(capabilities.timeRangeFilter && timeRange ? { timeRange } : {}),
    ...(capabilities.languageFilter && language ? { language } : {}),
    ...(capabilities.engineFilter && engines ? { engineFilter: engines } : {}),
    ...(capabilities.siteFilter && site ? { siteFilter: site } : {}),
  };
}

async function executeLocalSearch(
  provider: LocalSearchProvider,
  query: string,
  category: string,
  fetchCount: number,
  timeRange?: string,
  language?: string,
  engines?: string,
  site?: string | string[],
): Promise<SearxSearchResult> {
  const result = await searchWithLocalProvider(
    provider,
    localSearchRequest(
      provider.capabilities,
      query,
      category,
      fetchCount,
      timeRange,
      language,
      engines,
      site,
    ),
  );
  return localSearchResultToSearxSearchResult(result, {
    provider: provider.id,
    includeDirectAnswerMetadata: provider.capabilities.directAnswerMetadata,
    includeKnowledgeCardMetadata: provider.capabilities.knowledgeCardMetadata,
    includeQueryCorrectionMetadata:
      provider.capabilities.queryCorrectionMetadata,
    includeQuerySuggestionMetadata:
      provider.capabilities.querySuggestionMetadata,
    includeEngineMetadata: provider.capabilities.engineMetadata,
  });
}

function hostedFallbackAllowed(
  policy: ResolvedRoutingPolicy,
  capabilities: LocalSearchCapabilities,
  engines?: string,
): boolean {
  // A provider that cannot apply this filter leaves no local-only constraint
  // for hosted fallback to preserve. SearXNG declares support, keeping its
  // established opt-in behavior byte-for-byte.
  if (!engines || !capabilities.engineFilter) return true;
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
  const provider = getActiveLocalSearchProvider();
  let primary: SearxSearchResult | null = null;
  let primaryError: unknown;

  try {
    primary = await executeLocalSearch(
      provider,
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

  if (
    policy.hostedSearch.enabled &&
    hostedFallbackAllowed(policy, provider.capabilities, engines)
  ) {
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
  const providerLabel = provider.displayName ?? "Local";
  throw fallbackAttemptSummary
    ? new Error(
        `${providerLabel} search failed (${primaryMessage}); hosted fallback did not produce results (${fallbackAttemptSummary})`,
      )
    : primaryError instanceof Error
      ? primaryError
      : new Error(
          `${providerLabel} search failed and no hosted fallback succeeded`,
        );
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
    // variants remain local-provider-only so one user request cannot multiply
    // hosted search spend across query-rewrite variants.
    const expandedProvider = getActiveLocalSearchProvider();
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
        executeLocalSearch(
          expandedProvider,
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
