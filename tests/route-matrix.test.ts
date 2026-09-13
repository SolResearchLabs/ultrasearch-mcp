import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_SEARCH_PROVIDER_IDS,
  type HostedSearchProviderId,
  ROUTING_MODES,
  type RoutingMode,
} from "../src/config/schema.js";
import { CACHE_TTL_SECONDS } from "../src/config.js";
import type { HostedSearchBudgetStatus } from "../src/search-providers/budget.js";
import type { LocalSearchRequest } from "../src/search-providers/local.js";
import type { HostedSearchRequest } from "../src/search-providers/types.js";
import type {
  LocalSearchMetadata,
  LocalSearchResult,
  SearxMeta,
  SearxResult,
  SearxSearchResult,
} from "../src/types.js";

// H1 route matrix: exercises the real `searxSearch` entry across the five
// routing modes x the packet section 6.1 scenarios. Every remote seam is faked
// at the module boundary (providers, budget, cache, expansion, domain
// filtering, local-provider selection, Control Plane config). No fetch, no
// process, no port bind. Cells the committed code cannot pin are named so the
// divergence is visible in the test name rather than forced.

const harness = vi.hoisted(() => {
  const capabilities = {
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
  };
  return {
    configEnvironment: {} as Record<string, string>,
    hostedFallbackOrderOverride: null as string[] | null,
    localProvider: {
      id: "searxng",
      displayName: "SearXNG",
      capabilities,
      search: vi.fn(),
    },
    budgetStatus: vi.fn(),
    providerConfigured: {
      tinyfish: vi.fn(),
      exa: vi.fn(),
      parallel: vi.fn(),
      brave: vi.fn(),
    },
    providerSearch: {
      tinyfish: vi.fn(),
      exa: vi.fn(),
      parallel: vi.fn(),
      brave: vi.fn(),
    },
  };
});

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("route-matrix-cache-key"),
}));

vi.mock("../src/ollama.js", () => ({
  expandQuery: vi.fn().mockResolvedValue(["variant one", "variant two"]),
}));

vi.mock("../src/domains.js", () => ({
  applyDomainFilters: vi.fn((results: SearxResult[]) => results),
}));

vi.mock("../src/domain-db.js", () => ({
  normalizeHostname: () => "example.test",
  recordSearchAppearance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/observability.js", () => ({
  withSpan: vi.fn((_name: string, _attributes: unknown, fn: () => unknown) =>
    fn(),
  ),
}));

// The Control Plane config resolver is faked with the real resolver driven by
// a per-test environment fixture: no process env, no ambient user-config file.
vi.mock("../src/control-plane/config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/control-plane/config.js")>();
  return {
    ...actual,
    getControlPlaneConfig: () => resolveMatrixConfig(actual),
  };
});

// The registry (src/search-providers/index.ts) stays real so attempt trails,
// budget ranking, and kill-switch gating are the committed behavior; only the
// four provider modules and the budget read are faked.
vi.mock("../src/search-providers/budget.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/search-providers/budget.js")>();
  return {
    ...actual,
    getHostedSearchBudgetStatus: harness.budgetStatus,
  };
});

vi.mock("../src/search-providers/local.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/search-providers/local.js")>();
  return {
    ...actual,
    getActiveLocalSearchProvider: () => harness.localProvider,
  };
});

vi.mock("../src/search-providers/tinyfish.js", () => ({
  tinyfishSearchProvider: {
    id: "tinyfish",
    capabilities: {
      semantic: false,
      recency: true,
      domains: true,
      news: true,
    },
    configured: harness.providerConfigured.tinyfish,
    search: harness.providerSearch.tinyfish,
  },
}));

vi.mock("../src/search-providers/exa.js", () => ({
  exaSearchProvider: {
    id: "exa",
    capabilities: { semantic: true, recency: true, domains: true, news: true },
    configured: harness.providerConfigured.exa,
    search: harness.providerSearch.exa,
  },
}));

vi.mock("../src/search-providers/parallel.js", () => ({
  parallelSearchProvider: {
    id: "parallel",
    capabilities: { semantic: true, recency: true, domains: true, news: true },
    configured: harness.providerConfigured.parallel,
    search: harness.providerSearch.parallel,
  },
}));

vi.mock("../src/search-providers/brave.js", () => ({
  braveSearchProvider: {
    id: "brave",
    capabilities: {
      semantic: false,
      recency: true,
      domains: true,
      news: false,
    },
    configured: harness.providerConfigured.brave,
    search: harness.providerSearch.brave,
  },
}));

import { cacheGet, cacheSet } from "../src/cache.js";
import type { ResolvedControlPlaneConfig } from "../src/control-plane/config.js";
import { expandQuery } from "../src/ollama.js";
import { searxSearch } from "../src/search.js";
import { HostedSearchBudgetError } from "../src/search-providers/budget.js";
import {
  hostedSearchFallbackEnabled,
  searchHostedFallbackWithAttempts,
} from "../src/search-providers/index.js";

function resolveMatrixConfig(
  actual: typeof import("../src/control-plane/config.js"),
): ResolvedControlPlaneConfig {
  const resolved = actual.resolveControlPlaneConfig({
    environment: harness.configEnvironment,
    userConfig: {},
  });
  if (!harness.hostedFallbackOrderOverride) return resolved;
  return {
    ...resolved,
    values: {
      ...resolved.values,
      search: {
        ...resolved.values.search,
        hostedFallback: {
          ...resolved.values.search.hostedFallback,
          // Deliberately synthetic: config parsing can never emit a rogue
          // provider id, so this pins the registry-level defense in depth.
          providerOrder:
            harness.hostedFallbackOrderOverride as unknown as HostedSearchProviderId[],
        },
      },
    },
  };
}

const fetchSpy = vi.fn(() =>
  Promise.reject(new Error("route-matrix suite forbids network fetches")),
);
vi.stubGlobal("fetch", fetchSpy);

const QUERY = "matrix query";
const LOCAL_URL = "https://local.example.test/one";
const LOCAL_URL_TWO = "https://local.example.test/two";
const HOSTED_URL = "https://hosted.example.test/one";
const VARIANT_ONE_URL = "https://variant.example.test/one";
const VARIANT_TWO_URL = "https://variant.example.test/two";

const LOCAL_ROUTE = { provider: "searxng", engines: ["searxng-engine"] };
const EMPTY_META: SearxMeta = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

function localItems(urls: readonly string[]) {
  return urls.map((url, index) => ({
    title: `Local ${index}`,
    url,
    snippet: `local snippet ${index}`,
    source: "searxng-engine",
    sources: ["searxng-engine"],
    publishedAt: "2026-09-01",
  }));
}

function localShape(url: string, index: number): SearxResult {
  return {
    title: `Local ${index}`,
    url,
    content: `local snippet ${index}`,
    engine: "searxng-engine",
    engines: ["searxng-engine"],
    publishedDate: "2026-09-01",
  };
}

function localResult(
  urls: readonly string[],
  metadata: LocalSearchMetadata = {},
): LocalSearchResult {
  return {
    items: localItems(urls),
    metadata: { engineNames: ["searxng-engine"], ...metadata },
  };
}

function hostedShape(url: string, engine: HostedSearchProviderId): SearxResult {
  return {
    title: `Hosted ${engine}`,
    url,
    content: "hosted snippet",
    engine,
    engines: [engine],
  };
}

function exhaustedBudget(
  provider: HostedSearchProviderId,
): HostedSearchBudgetStatus {
  return {
    provider,
    state: "exhausted",
    allowed: false,
    usedUnits: 10,
    limitUnits: 10,
    remainingUnits: 0,
    warnPercent: 80,
    period: "2026-09",
    resetAt: "2026-10-01T00:00:00.000Z",
    failOpen: false,
  };
}

function resetHarness(): void {
  vi.clearAllMocks();
  harness.configEnvironment = {};
  harness.hostedFallbackOrderOverride = null;
  harness.localProvider.capabilities = {
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
  };
  harness.budgetStatus.mockResolvedValue({
    state: "disabled",
    allowed: true,
  });
  for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
    harness.providerConfigured[id].mockReturnValue(true);
    harness.providerSearch[id].mockResolvedValue([]);
  }
  harness.localProvider.search.mockResolvedValue(localResult([LOCAL_URL]));
  vi.mocked(expandQuery).mockResolvedValue(["variant one", "variant two"]);
  vi.mocked(cacheGet).mockResolvedValue(null);
}

function armHit(
  id: HostedSearchProviderId,
  results: SearxResult[] | (() => Promise<SearxResult[]>),
): void {
  if (typeof results === "function") {
    harness.providerSearch[id].mockImplementation(results);
  } else {
    harness.providerSearch[id].mockResolvedValue(results);
  }
}

interface Outcome {
  value?: SearxSearchResult;
  error?: unknown;
}

async function runSearch(options: {
  mode: RoutingMode;
  engines?: string;
  expand?: boolean;
  query?: string;
}): Promise<Outcome> {
  harness.configEnvironment.ULTRASEARCH_ROUTING_MODE = options.mode;
  try {
    const value = await searxSearch(
      options.query ?? QUERY,
      "general",
      5,
      undefined,
      undefined,
      options.expand ?? false,
      undefined,
      options.engines,
    );
    return { value };
  } catch (error) {
    return { error };
  }
}

function requireValue(outcome: Outcome): SearxSearchResult {
  expect(outcome.error).toBeUndefined();
  expect(outcome.value).toBeDefined();
  if (!outcome.value) throw new Error("expected a resolved search result");
  return outcome.value;
}

function errorOf(outcome: Outcome): Error {
  expect(outcome.value).toBeUndefined();
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error;
}

function expectNoHostedAttempt(): void {
  for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
    expect(harness.providerSearch[id]).not.toHaveBeenCalled();
  }
  expect(harness.budgetStatus).not.toHaveBeenCalled();
}

function expectLocalSearched(times = 1): void {
  expect(harness.localProvider.search).toHaveBeenCalledTimes(times);
}

function expectHostedSearchCalls(
  expected: Partial<Record<HostedSearchProviderId, number>>,
): void {
  for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
    const times = expected[id] ?? 0;
    expect(harness.providerSearch[id]).toHaveBeenCalledTimes(times);
  }
}

beforeEach(() => {
  resetHarness();
});

afterEach(() => {
  // Hermeticity guard: no cell in this matrix may reach a network seam.
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetchSpy);
});

describe("H1 S1: local returns at least minimumResults", () => {
  const S1_META: SearxMeta = {
    answers: [{ answer: "42" }],
    infoboxes: [{ title: "Card", content: "card text" }],
    corrections: ["fixed"],
    suggestions: ["next"],
  };
  const s1Results = [localShape(LOCAL_URL, 0), localShape(LOCAL_URL_TWO, 1)];

  beforeEach(() => {
    harness.localProvider.search.mockResolvedValue(
      localResult([LOCAL_URL, LOCAL_URL_TWO], {
        directAnswers: [{ text: "42" }],
        knowledgeCards: [{ title: "Card", text: "card text" }],
        queryCorrections: ["fixed"],
        querySuggestions: ["next"],
      }),
    );
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
  });

  it("local_only: local route with provider meta, no hosted attempt", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual(s1Results);
    expect(value.meta).toEqual(S1_META);
    expectLocalSearched();
    expectNoHostedAttempt();
    expect(cacheGet).toHaveBeenCalledOnce();
    expect(cacheSet).toHaveBeenCalledOnce();
    expect(vi.mocked(cacheSet)).toHaveBeenCalledWith(
      "route-matrix-cache-key",
      JSON.stringify({ results: s1Results, meta: S1_META, route: LOCAL_ROUTE }),
      CACHE_TTL_SECONDS,
    );
    expect(vi.mocked(expandQuery)).not.toHaveBeenCalled();
  });

  it("local_first: usable local set returns without hosted fallback", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual(s1Results);
    expectNoHostedAttempt();
  });

  it("hybrid: useful local set returns without hosted supplement", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual(s1Results);
    expectNoHostedAttempt();
  });

  it("hosted_only: hosted primary, local provider never called", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toEqual({ provider: "tinyfish" });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "tinyfish")]);
    expect(value.meta).toEqual(EMPTY_META);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectHostedSearchCalls({ tinyfish: 1 });
    expect(vi.mocked(expandQuery)).not.toHaveBeenCalled();
    expect(cacheSet).toHaveBeenCalledOnce();
  });
});

describe("H1 S2: local returns more than zero but fewer than minimumResults", () => {
  beforeEach(() => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS = "3";
    harness.localProvider.search.mockResolvedValue(localResult([LOCAL_URL]));
    // The hosted provider echoes the local URL first to pin URL dedup.
    armHit("tinyfish", [
      hostedShape(LOCAL_URL, "tinyfish"),
      hostedShape(HOSTED_URL, "tinyfish"),
    ]);
  });

  it("local_only: weak local set is returned as-is, no hosted attempt", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([localShape(LOCAL_URL, 0)]);
    expectNoHostedAttempt();
  });

  it("local_first: any local result is usable, no hosted attempt", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([localShape(LOCAL_URL, 0)]);
    expectNoHostedAttempt();
  });

  it("hybrid: hosted supplement merged local-first with URL dedup", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual({ provider: "tinyfish", fallback: true });
    expect(value.results).toEqual([
      localShape(LOCAL_URL, 0),
      hostedShape(HOSTED_URL, "tinyfish"),
    ]);
    expect(value.meta).toEqual(EMPTY_META);
    expectLocalSearched();
    expectHostedSearchCalls({ tinyfish: 1 });
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("hosted_only: hosted primary result list is not URL-deduplicated", async () => {
    // The provider emits the same URL twice: a deduplicating pass would
    // collapse the pair, so this assertion is only satisfiable while the
    // hosted-primary path (search.ts `hostedSearchPrimary` ->
    // `searchHostedFallbackWithAttempts`) forwards provider results unchanged.
    armHit("tinyfish", [
      hostedShape(HOSTED_URL, "tinyfish"),
      hostedShape(HOSTED_URL, "tinyfish"),
    ]);
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toEqual({ provider: "tinyfish" });
    expect(value.results).toEqual([
      hostedShape(HOSTED_URL, "tinyfish"),
      hostedShape(HOSTED_URL, "tinyfish"),
    ]);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
  });
});

describe("H1 S3: local returns zero results", () => {
  beforeEach(() => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS = "3";
    harness.localProvider.search.mockResolvedValue(localResult([]));
    armHit("exa", [hostedShape(HOSTED_URL, "exa")]);
  });

  it("local_only: empty local result is returned, no hosted attempt", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("local_first: hosted fallback after zero usable local results", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "exa")]);
    expect(value.meta).toEqual(EMPTY_META);
    expectLocalSearched();
    // tinyfish is attempted first and empty; exa hits and ends the loop.
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });

  it("hybrid: hosted supplement over an empty local set keeps local meta", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "exa")]);
    expect(value.meta).toEqual(EMPTY_META);
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });

  it("hosted_only: hosted primary result carries no fallback flag", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toEqual({ provider: "exa" });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "exa")]);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });
});

describe("H1 S4: local hard failure (throw)", () => {
  let localFailure: Error;

  beforeEach(() => {
    localFailure = new Error("local provider boom");
    harness.localProvider.search.mockRejectedValue(localFailure);
    armHit("exa", [hostedShape(HOSTED_URL, "exa")]);
  });

  it("local_only: rethrows with zero hosted attempts", async () => {
    const outcome = await runSearch({ mode: "local_only" });
    expect(errorOf(outcome)).toBe(localFailure);
    expectLocalSearched();
    expectNoHostedAttempt();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(cacheGet).toHaveBeenCalledOnce();
  });

  it("local_first: hosted hit resolves with fallback route", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "exa")]);
    expect(value.meta).toEqual(EMPTY_META);
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("hybrid: same fallback branch as local_first after a throw", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "exa")]);
    expect(value.meta).toEqual(EMPTY_META);
  });

  it("hosted_only: local provider never called, hosted primary", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toEqual({ provider: "exa" });
    expect(harness.localProvider.search).not.toHaveBeenCalled();
  });

  it("local_first miss: composed error names the local failure and the attempt trail", async () => {
    armHit("exa", []);
    const outcome = await runSearch({ mode: "local_first" });
    expect(errorOf(outcome).message).toBe(
      "SearXNG search failed (local provider boom); hosted fallback did not produce results (tinyfish=empty; exa=empty; parallel=empty; brave=empty)",
    );
  });

  it("local_first with no credential-derived providers rethrows the original error", async () => {
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      harness.providerConfigured[id].mockReturnValue(false);
    }
    const outcome = await runSearch({ mode: "local_first" });
    // enabled=false leaves no attempt summary, so the original error survives.
    expect(errorOf(outcome)).toBe(localFailure);
    expectNoHostedAttempt();
  });

  it("local_first records a provider error in the trail then tries the next provider", async () => {
    armHit("tinyfish", async () => {
      throw new Error("tinyfish exploded");
    });
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });
});

describe("H1 S5: no hosted credentials configured (kill switch auto)", () => {
  beforeEach(() => {
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      harness.providerConfigured[id].mockReturnValue(false);
    }
    harness.localProvider.search.mockResolvedValue(localResult([]));
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
  });

  it("local_only: local path only", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectNoHostedAttempt();
  });

  it("local_first: registry reports disabled, local result stands, no trail", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("hybrid: same disabled-registry behavior as local_first", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
  });

  it("hosted_only: empty result without a route when no provider is configured", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toBeUndefined();
    expect(value.results).toEqual([]);
    expect(value.meta).toEqual(EMPTY_META);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectNoHostedAttempt();
  });

  it("FINDING: the unconfigured trail requires an explicit enabled=true kill switch", async () => {
    // Packet 6.1 S5 expects "fallback trails unconfigured per provider", but
    // the committed code short-circuits on auto+none-configured (enabled=false,
    // attempts=[]). The trail is only reachable with the switch forced on.
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "true";
    harness.localProvider.search.mockRejectedValue(new Error("local down"));
    const outcome = await runSearch({ mode: "local_first" });
    expect(errorOf(outcome).message).toBe(
      "SearXNG search failed (local down); hosted fallback did not produce results (tinyfish=unconfigured; exa=unconfigured; parallel=unconfigured; brave=unconfigured)",
    );
    expectNoHostedAttempt();
  });
});

describe("H1 S6: HOSTED_SEARCH_FALLBACK_ENABLED=false", () => {
  beforeEach(() => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "false";
    harness.localProvider.search.mockResolvedValue(localResult([]));
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
  });

  it("local_only: local path only", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectNoHostedAttempt();
  });

  it("local_first: registry-level kill switch suppresses every hosted attempt", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
  });

  it("hybrid: same suppression as local_first", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
  });

  it("hosted_only: the kill switch gates the hosted primary path too", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toBeUndefined();
    expect(value.results).toEqual([]);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectNoHostedAttempt();
  });

  it("FINDING: an unrecognized kill-switch value resolves to auto, not enabled", async () => {
    // Packet 6.2 sketches "unrecognized => enabled"; the committed parser maps
    // an unparseable value to the auto default instead (enabled iff at least
    // one provider is configured), so the second assertion below flips with
    // the provider posture.
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "banana";
    expect(hostedSearchFallbackEnabled()).toBe(true);
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      harness.providerConfigured[id].mockReturnValue(false);
    }
    expect(hostedSearchFallbackEnabled()).toBe(false);
  });
});

describe("H1 S7: first provider budget-blocked (fail-closed at call time)", () => {
  beforeEach(() => {
    harness.localProvider.search.mockResolvedValue(localResult([]));
    armHit("tinyfish", async () => {
      throw new HostedSearchBudgetError(
        "tinyfish",
        exhaustedBudget("tinyfish"),
      );
    });
    armHit("exa", [hostedShape(HOSTED_URL, "exa")]);
  });

  it("local_only: no hosted attempt despite the provider setup", async () => {
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectNoHostedAttempt();
  });

  it("local_first: budget_blocked trail entry then the next provider hits", async () => {
    const value = requireValue(await runSearch({ mode: "local_first" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });

  it("hybrid: same budget-blocked skip as local_first", async () => {
    const value = requireValue(await runSearch({ mode: "hybrid" }));
    expect(value.route).toEqual({ provider: "exa", fallback: true });
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });

  it("hosted_only: budget_blocked then next provider as primary", async () => {
    const value = requireValue(await runSearch({ mode: "hosted_only" }));
    expect(value.route).toEqual({ provider: "exa" });
    expectHostedSearchCalls({ tinyfish: 1, exa: 1 });
  });

  it("FINDING: a pre-loop exhausted provider is deferred to the end of the trail", async () => {
    // Budget-aware ranking moves an exhausted provider behind healthy ones, so
    // the committed code emits `budget_blocked` only after the healthy
    // providers have been attempted - not "first" as packet 6.1 S7 sketches.
    armHit("exa", []);
    harness.budgetStatus.mockImplementation(async (id: string) =>
      id === "tinyfish"
        ? exhaustedBudget("tinyfish")
        : { state: "disabled", allowed: true },
    );
    harness.localProvider.search.mockRejectedValue(new Error("local down"));
    const outcome = await runSearch({ mode: "local_first" });
    expect(errorOf(outcome).message).toBe(
      "SearXNG search failed (local down); hosted fallback did not produce results (exa=empty; parallel=empty; brave=empty; tinyfish=budget_blocked)",
    );
    expectHostedSearchCalls({ exa: 1, parallel: 1, brave: 1 });
    expect(harness.providerSearch.tinyfish).not.toHaveBeenCalled();
  });
});

describe("H1 S8: engine filter set with withEngineFilter=false", () => {
  beforeEach(() => {
    harness.localProvider.search.mockResolvedValue(localResult([]));
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
  });

  it("local_only: the filter is forwarded to the local provider, no hosted", async () => {
    const value = requireValue(
      await runSearch({ mode: "local_only", engines: "google" }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(harness.localProvider.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: QUERY,
        numResults: 15,
        engineFilter: "google",
      }),
    );
    expectNoHostedAttempt();
  });

  it("local_first: hosted fallback suppressed even with zero usable results", async () => {
    const value = requireValue(
      await runSearch({ mode: "local_first", engines: "google" }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
  });

  it("hybrid: hosted fallback suppressed as well", async () => {
    const value = requireValue(
      await runSearch({ mode: "hybrid", engines: "google" }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results).toEqual([]);
    expectNoHostedAttempt();
  });

  it("hosted_only: the filter is not applicable, hosted primary proceeds", async () => {
    const value = requireValue(
      await runSearch({ mode: "hosted_only", engines: "google" }),
    );
    expect(value.route).toEqual({ provider: "tinyfish" });
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectHostedSearchCalls({ tinyfish: 1 });
  });

  it("withEngineFilter=true opts local_first back into fallback under a filter", async () => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER =
      "true";
    const value = requireValue(
      await runSearch({ mode: "local_first", engines: "google" }),
    );
    expect(value.route).toEqual({ provider: "tinyfish", fallback: true });
    expectHostedSearchCalls({ tinyfish: 1 });
  });

  it("a provider without engine-filter capability leaves no constraint to preserve", async () => {
    harness.localProvider.capabilities = {
      ...harness.localProvider.capabilities,
      engineFilter: false,
    };
    const value = requireValue(
      await runSearch({ mode: "local_first", engines: "google" }),
    );
    expect(value.route).toEqual({ provider: "tinyfish", fallback: true });
    expect(harness.localProvider.search).toHaveBeenCalledWith(
      expect.not.objectContaining({ engineFilter: expect.anything() }),
    );
  });
});

describe("H1 S9: offline_fetch_only", () => {
  beforeEach(() => {
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
  });

  it("returns the structured diagnostic with zero cache, local, hosted, or expansion calls", async () => {
    const value = requireValue(
      await runSearch({ mode: "offline_fetch_only", expand: true }),
    );
    expect(value).toEqual({
      results: [],
      meta: EMPTY_META,
      diagnostic: {
        code: "offline_source_unavailable",
        mode: "offline_fetch_only",
        message:
          "Offline fetch mode has no configured offline search source for this query.",
      },
    });
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expectNoHostedAttempt();
    expect(vi.mocked(expandQuery)).not.toHaveBeenCalled();
  });

  it("ignores a populated cache entry entirely (no read)", async () => {
    vi.mocked(cacheGet).mockResolvedValue(
      JSON.stringify([localShape(LOCAL_URL, 0)]),
    );
    const value = requireValue(await runSearch({ mode: "offline_fetch_only" }));
    expect(value.results).toEqual([]);
    expect(value.diagnostic?.code).toBe("offline_source_unavailable");
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("still returns the diagnostic when the local provider would have thrown", async () => {
    harness.localProvider.search.mockRejectedValue(new Error("local down"));
    const value = requireValue(
      await runSearch({ mode: "offline_fetch_only", expand: false }),
    );
    expect(value.diagnostic?.code).toBe("offline_source_unavailable");
    expect(harness.localProvider.search).not.toHaveBeenCalled();
  });
});

describe("H1 S10: query expansion enabled", () => {
  beforeEach(() => {
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
    harness.localProvider.search.mockImplementation(
      async (request: LocalSearchRequest) => {
        switch (request.query) {
          case "variant one":
            return localResult([VARIANT_ONE_URL]);
          case "variant two":
            // Repeats the original URL to pin URL dedup across variants.
            return localResult([VARIANT_TWO_URL, LOCAL_URL]);
          default:
            return localResult([LOCAL_URL]);
        }
      },
    );
  });

  it("local_only: original plus variants merged local-first with URL dedup", async () => {
    const value = requireValue(
      await runSearch({ mode: "local_only", expand: true }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expect(value.results.map((result) => result.url)).toEqual([
      LOCAL_URL,
      VARIANT_ONE_URL,
      VARIANT_TWO_URL,
    ]);
    expect(value.meta).toEqual(EMPTY_META);
    expectLocalSearched(3);
    expectNoHostedAttempt();
    expect(vi.mocked(expandQuery)).toHaveBeenCalledWith(QUERY);
    // Only the original-query result set is cached.
    const payload = JSON.parse(
      vi.mocked(cacheSet).mock.calls[0][1] as string,
    ) as { results: SearxResult[]; route: unknown };
    expect(payload.results).toEqual([localShape(LOCAL_URL, 0)]);
    expect(payload.route).toEqual(LOCAL_ROUTE);
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("local_first: a usable original suppresses hosted fallback for every query", async () => {
    const value = requireValue(
      await runSearch({ mode: "local_first", expand: true }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectLocalSearched(3);
    expectNoHostedAttempt();
  });

  it("hybrid: a useful original suppresses the hosted supplement", async () => {
    const value = requireValue(
      await runSearch({ mode: "hybrid", expand: true }),
    );
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectLocalSearched(3);
    expectNoHostedAttempt();
  });

  it("local_first: only the original query may activate hosted fallback", async () => {
    harness.localProvider.search.mockImplementation(
      async (request: LocalSearchRequest) =>
        request.query === QUERY
          ? localResult([])
          : localResult([VARIANT_ONE_URL]),
    );
    const value = requireValue(
      await runSearch({ mode: "local_first", expand: true }),
    );
    expect(value.route).toEqual({ provider: "tinyfish", fallback: true });
    // Original + two variants hit the local provider; exactly one hosted attempt.
    expectLocalSearched(3);
    expectHostedSearchCalls({ tinyfish: 1 });
  });

  it("hosted_only: expansion never runs because the local provider is disabled", async () => {
    const value = requireValue(
      await runSearch({ mode: "hosted_only", expand: true }),
    );
    expect(value.route).toEqual({ provider: "tinyfish" });
    expect(value.results).toEqual([hostedShape(HOSTED_URL, "tinyfish")]);
    expect(harness.localProvider.search).not.toHaveBeenCalled();
    expect(vi.mocked(expandQuery)).not.toHaveBeenCalled();
  });
});

describe("H1 cache interaction sub-matrix", () => {
  it("cache hit keeps known provenance and stamps cacheHit without provider calls", async () => {
    vi.mocked(cacheGet).mockResolvedValue(
      JSON.stringify({
        results: [localShape(LOCAL_URL, 0)],
        meta: EMPTY_META,
        route: { provider: "searxng", engines: ["google", "bing"] },
      }),
    );
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual({
      provider: "searxng",
      engines: ["google", "bing"],
      cacheHit: true,
    });
    expectLocalSearched(0);
    expectNoHostedAttempt();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("legacy cache-hit entry reports provider 'cache' honestly", async () => {
    vi.mocked(cacheGet).mockResolvedValue(
      JSON.stringify([localShape(LOCAL_URL, 0)]),
    );
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual({ provider: "cache", cacheHit: true });
    expect(value.meta).toEqual(EMPTY_META);
    expectLocalSearched(0);
  });

  it("corrupted cache entry falls through to the live route", async () => {
    vi.mocked(cacheGet).mockResolvedValue("{not-json");
    const value = requireValue(await runSearch({ mode: "local_only" }));
    expect(value.route).toEqual(LOCAL_ROUTE);
    expectLocalSearched(1);
    expect(cacheSet).toHaveBeenCalledOnce();
  });
});

describe("H1 provider/budget/kill-switch sub-matrix (packet 6.2)", () => {
  const request: HostedSearchRequest = {
    query: QUERY,
    numResults: 5,
    category: "general",
  };

  it("drops provider ids absent from the registry while keeping the surviving order", async () => {
    harness.hostedFallbackOrderOverride = ["brave", "rogue-provider", "exa"];
    armHit("brave", [hostedShape("https://brave.example.test", "brave")]);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.result?.provider).toBe("brave");
    expect(outcome.attempts).toEqual([
      { provider: "brave", outcome: "hit", budgetState: "disabled" },
    ]);
    expect(harness.providerSearch.exa).not.toHaveBeenCalled();
  });

  it("unconfigured providers are recorded but never called", async () => {
    harness.providerConfigured.exa.mockReturnValue(false);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.result).toBeNull();
    // Unconfigured entries are appended during the provider scan, before any
    // budget-sorted attempt is recorded.
    expect(outcome.attempts).toEqual([
      { provider: "exa", outcome: "unconfigured" },
      { provider: "tinyfish", outcome: "empty", budgetState: "disabled" },
      { provider: "parallel", outcome: "empty", budgetState: "disabled" },
      { provider: "brave", outcome: "empty", budgetState: "disabled" },
    ]);
    expect(harness.providerSearch.exa).not.toHaveBeenCalled();
  });

  it("preserves the configured order when budget classes are equal", async () => {
    harness.hostedFallbackOrderOverride = ["brave", "exa"];
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.attempts.map((attempt) => attempt.provider)).toEqual([
      "brave",
      "exa",
    ]);
  });

  it("ranks healthy providers ahead of near-limit providers regardless of order", async () => {
    harness.hostedFallbackOrderOverride = ["brave", "exa"];
    harness.budgetStatus.mockImplementation(async (id: string) =>
      id === "brave"
        ? { state: "near_limit", allowed: true }
        : { state: "healthy", allowed: true },
    );
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.attempts.map((attempt) => attempt.provider)).toEqual([
      "exa",
      "brave",
    ]);
  });

  it("pre-loop exhausted provider is attempted last and recorded as budget_blocked", async () => {
    harness.budgetStatus.mockImplementation(async (id: string) =>
      id === "exa"
        ? exhaustedBudget("exa")
        : { state: "disabled", allowed: true },
    );
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.result).toBeNull();
    expect(outcome.attempts.map((attempt) => attempt.provider)).toEqual([
      "tinyfish",
      "parallel",
      "brave",
      "exa",
    ]);
    expect(outcome.attempts[3]).toEqual({
      provider: "exa",
      outcome: "budget_blocked",
      budgetState: "exhausted",
    });
    expect(harness.providerSearch.exa).not.toHaveBeenCalled();
  });

  it("fail-open unknown budget is attempted after healthy providers", async () => {
    harness.budgetStatus.mockImplementation(async (id: string) =>
      id === "tinyfish"
        ? { state: "unknown", allowed: true }
        : { state: "healthy", allowed: true },
    );
    armHit("tinyfish", [hostedShape(HOSTED_URL, "tinyfish")]);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.attempts.map((attempt) => attempt.provider)).toEqual([
      "exa",
      "parallel",
      "brave",
      "tinyfish",
    ]);
    expect(outcome.result?.provider).toBe("tinyfish");
  });

  it("call-time budget error records budget_blocked and continues to the next provider", async () => {
    armHit("tinyfish", async () => {
      throw new HostedSearchBudgetError(
        "tinyfish",
        exhaustedBudget("tinyfish"),
      );
    });
    armHit("exa", [hostedShape(HOSTED_URL, "exa")]);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.result?.provider).toBe("exa");
    expect(outcome.attempts[0]).toEqual({
      provider: "tinyfish",
      outcome: "budget_blocked",
      budgetState: "exhausted",
      error: "tinyfish search budget is exhausted",
    });
    expect(outcome.attempts[1]).toEqual({
      provider: "exa",
      outcome: "hit",
      budgetState: "disabled",
    });
  });

  it("provider error records the message and continues to the next provider", async () => {
    armHit("tinyfish", async () => {
      throw new Error("tinyfish exploded");
    });
    armHit("exa", [hostedShape(HOSTED_URL, "exa")]);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.attempts[0]).toEqual({
      provider: "tinyfish",
      outcome: "error",
      budgetState: "disabled",
      error: "tinyfish exploded",
    });
    expect(outcome.result?.provider).toBe("exa");
  });

  it("kill switch true: enabled with zero configured providers and an all-unconfigured trail", async () => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "true";
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      harness.providerConfigured[id].mockReturnValue(false);
    }
    expect(hostedSearchFallbackEnabled()).toBe(true);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome.enabled).toBe(true);
    expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual([
      "unconfigured",
      "unconfigured",
      "unconfigured",
      "unconfigured",
    ]);
    expectNoHostedAttempt();
  });

  it("kill switch false: every hosted path reports a disabled registry", async () => {
    harness.configEnvironment.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "false";
    expect(hostedSearchFallbackEnabled()).toBe(false);
    const outcome = await searchHostedFallbackWithAttempts(request);
    expect(outcome).toEqual({ result: null, attempts: [], enabled: false });
    expectNoHostedAttempt();
  });

  it("auto kill switch enables exactly when at least one provider is configured", async () => {
    expect(hostedSearchFallbackEnabled()).toBe(true);
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      harness.providerConfigured[id].mockReturnValue(false);
    }
    expect(hostedSearchFallbackEnabled()).toBe(false);
    harness.providerConfigured.brave.mockReturnValue(true);
    expect(hostedSearchFallbackEnabled()).toBe(true);
    expect(ROUTING_MODES).toEqual([
      "local_only",
      "local_first",
      "hybrid",
      "hosted_only",
      "offline_fetch_only",
    ]);
  });
});
