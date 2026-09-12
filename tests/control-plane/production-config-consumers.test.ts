import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_ENV = [
  "ULTRASEARCH_CONFIG",
  "ULTRASEARCH_SEARXNG_URL",
  "ULTRASEARCH_ROUTING_MODE",
  "ULTRASEARCH_HOSTED_FALLBACK_ENABLED",
  "ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER",
  "HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER",
  "ULTRASEARCH_PROVIDER_ORDER",
  "ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS",
  "ULTRASEARCH_CACHE_URL",
  "ULTRASEARCH_CACHE_COMMAND_TIMEOUT_MS",
  "ULTRASEARCH_CACHE_CONNECT_TIMEOUT_MS",
  "ULTRASEARCH_CACHE_MAX_RETRIES_PER_REQUEST",
  "ULTRASEARCH_SEARXNG_MAX_IN_FLIGHT",
  "ULTRASEARCH_PARALLEL_SEARCH_MAX_IN_FLIGHT",
  "ULTRASEARCH_EXA_SEARCH_BUDGET_MONTHLY_UNITS",
  "ULTRASEARCH_EXA_SEARCH_BUDGET_UNITS_PER_REQUEST",
  "ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT",
  "ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN",
  "ULTRASEARCH_FIRECRAWL_ENABLED",
  "ULTRASEARCH_FIRECRAWL_URL",
  "ULTRASEARCH_FIRECRAWL_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
];

const MISSING_CONFIG_PATH = join(
  process.cwd(),
  "tests",
  "__missing-production-config-consumers__.json",
);
const originalValues = new Map<string, string | undefined>();

beforeEach(() => {
  vi.resetModules();
  originalValues.clear();
  for (const key of CONFIG_ENV) {
    originalValues.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ULTRASEARCH_CONFIG = MISSING_CONFIG_PATH;
});

afterEach(() => {
  for (const key of CONFIG_ENV) {
    const value = originalValues.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Phase-002 production configuration consumers", () => {
  it("projects one resolved configuration through service, control, registry, and budget consumers", async () => {
    process.env.ULTRASEARCH_SEARXNG_URL = "http://127.0.0.1:9100";
    process.env.ULTRASEARCH_ROUTING_MODE = "hybrid";
    process.env.ULTRASEARCH_HOSTED_FALLBACK_ENABLED = "true";
    process.env.ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER = "true";
    process.env.ULTRASEARCH_PROVIDER_ORDER = "parallel,exa";
    process.env.ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS = "3";
    process.env.ULTRASEARCH_CACHE_URL = "redis://projection.test:6381";
    process.env.ULTRASEARCH_CACHE_COMMAND_TIMEOUT_MS = "1500";
    process.env.ULTRASEARCH_CACHE_CONNECT_TIMEOUT_MS = "2000";
    process.env.ULTRASEARCH_CACHE_MAX_RETRIES_PER_REQUEST = "5";
    process.env.ULTRASEARCH_SEARXNG_MAX_IN_FLIGHT = "8";
    process.env.ULTRASEARCH_PARALLEL_SEARCH_MAX_IN_FLIGHT = "4";
    process.env.ULTRASEARCH_EXA_SEARCH_BUDGET_MONTHLY_UNITS = "100";
    process.env.ULTRASEARCH_EXA_SEARCH_BUDGET_UNITS_PER_REQUEST = "2";
    process.env.ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT = "70";
    process.env.ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN = "true";
    process.env.ULTRASEARCH_FIRECRAWL_ENABLED = "true";
    process.env.ULTRASEARCH_FIRECRAWL_URL = "https://firecrawl.example.invalid";
    process.env.ULTRASEARCH_FIRECRAWL_API_KEY = "fixture-value";
    process.env.EXA_API_KEY = "fixture-value";
    process.env.PARALLEL_API_KEY = "fixture-value";

    const [
      { getControlPlaneConfig },
      serviceConfig,
      providerControl,
      registry,
      hostedControl,
      budget,
    ] = await Promise.all([
      import("../../src/control-plane/config.js"),
      import("../../src/config.js"),
      import("../../src/provider-control.js"),
      import("../../src/search-providers/index.js"),
      import("../../src/search-providers/control.js"),
      import("../../src/search-providers/budget.js"),
    ]);
    const resolved = getControlPlaneConfig();

    expect(resolved.values).toMatchObject({
      localSearch: { endpoint: "http://127.0.0.1:9100" },
      routing: { mode: "hybrid" },
      search: {
        hostedFallback: {
          enabled: true,
          withEngineFilter: true,
          providerOrder: ["parallel", "exa"],
          minimumResults: 3,
        },
      },
      cache: {
        url: "redis://projection.test:6381",
        commandTimeoutMs: 1500,
        connectTimeoutMs: 2000,
        maxRetriesPerRequest: 5,
      },
      remoteFetch: {
        firecrawl: {
          classification: "explicit_remote_fetch_crawl_escalation",
          enabled: true,
          url: "https://firecrawl.example.invalid",
          apiKey: "fixture-value",
        },
      },
    });
    expect(serviceConfig).toMatchObject({
      SEARXNG_URL: resolved.values.localSearch.endpoint,
      CACHE_URL: resolved.values.cache.url,
      CACHE_COMMAND_TIMEOUT_MS: resolved.values.cache.commandTimeoutMs,
      CACHE_CONNECT_TIMEOUT_MS: resolved.values.cache.connectTimeoutMs,
      CACHE_MAX_RETRIES_PER_REQUEST: resolved.values.cache.maxRetriesPerRequest,
      FIRECRAWL_URL: resolved.values.remoteFetch.firecrawl.url,
      FIRECRAWL_API_KEY: resolved.values.remoteFetch.firecrawl.apiKey,
    });
    expect(providerControl.providerControlSnapshot().searxng).toMatchObject({
      maxInFlight: 8,
    });
    expect(hostedControl.hostedSearchControlSnapshot().parallel).toMatchObject({
      maxInFlight: 4,
    });
    expect(registry.hostedSearchFallbackEnabled()).toBe(true);
    expect(registry.hostedSearchFallbackMinResults()).toBe(3);
    expect(registry.configuredHostedSearchProviders()).toEqual([
      "parallel",
      "exa",
    ]);
    expect(budget.hostedBudgetFailOpen("exa")).toBe(true);
  });
});
