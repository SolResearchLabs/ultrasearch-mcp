import { describe, expect, it } from "vitest";
import {
  CONFIG_SCHEMA,
  type RoutingMode,
  RUNTIME_MODES,
  type RuntimeMode,
} from "../../src/config/schema.js";
import {
  getControlPlaneConfig,
  resolveControlPlaneConfig,
} from "../../src/control-plane/config.js";
import {
  redactConfigForDiagnostics,
  redactWithConfigSchema,
} from "../../src/control-plane/redaction.js";
import { resetRuntimeConfigForTests } from "../../src/runtime-config.js";

describe("Control Plane effective configuration", () => {
  it("applies operation, environment, user config, profile, and defaults in order", () => {
    const resolved = resolveControlPlaneConfig({
      operation: {
        localSearch: { endpoint: "http://operation.test:8099" },
        routing: { mode: "offline_fetch_only" },
      },
      environment: {
        ULTRASEARCH_SEARXNG_URL: "http://environment.test:8099",
        ULTRASEARCH_ROUTING_MODE: "hosted_only",
        ULTRASEARCH_FIRECRAWL_ENABLED: "true",
        ULTRASEARCH_FIRECRAWL_URL: "https://environment.firecrawl.test",
        ULTRASEARCH_FIRECRAWL_API_KEY: "environment-secret",
      },
      userConfig: {
        profile: "hybrid",
        search: { searxngUrl: "http://user-config.test:8099" },
        routing: { mode: "local_only" },
        providers: {
          firecrawl: {
            enabled: false,
            url: "https://user-config.firecrawl.test",
            apiKey: "user-config-secret",
          },
        },
      },
    });

    expect(resolved.values).toMatchObject({
      localSearch: { endpoint: "http://operation.test:8099" },
      routing: { mode: "offline_fetch_only" },
      remoteFetch: {
        firecrawl: {
          enabled: true,
          url: "https://environment.firecrawl.test",
          apiKey: "environment-secret",
        },
      },
    });
    expect(resolved.sources).toMatchObject({
      localSearchEndpoint: "operation",
      routingMode: "operation",
      firecrawlEnabled: "environment",
      firecrawlUrl: "environment",
      firecrawlApiKey: "environment",
    });
    expect(resolved.profile).toEqual({
      name: "hybrid",
      source: "user_config",
    });
  });

  it("uses a selected profile only after higher-precedence values", () => {
    const resolved = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_PROFILE: "hybrid" },
      userConfig: { routing: { mode: "local_only" } },
    });

    expect(resolved.values.routing.mode).toBe("local_only");
    expect(resolved.sources.routingMode).toBe("user_config");
    expect(resolved.profile).toEqual({
      name: "hybrid",
      source: "environment",
    });
  });

  it("ignores unresolved host placeholders and invalid routing modes", () => {
    const placeholder = ["$", "{", "user_config.searxng_url", "}"].join("");
    const resolved = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_SEARXNG_URL: placeholder,
        ULTRASEARCH_ROUTING_MODE: "not-a-routing-mode",
      },
    });

    expect(resolved.values.localSearch.endpoint).toBe("http://127.0.0.1:8099");
    expect(resolved.values.routing.mode).toBe("local_first");
    expect(resolved.sources.localSearchEndpoint).toBe("default");
    expect(resolved.sources.routingMode).toBe("default");
  });

  it("does not let an invalid operation override mask a valid lower layer", () => {
    const invalidMode = "not-a-routing-mode" as RoutingMode;
    const resolved = resolveControlPlaneConfig({
      operation: { routing: { mode: invalidMode } },
      environment: { ULTRASEARCH_ROUTING_MODE: "hosted_only" },
    });

    expect(resolved.values.routing.mode).toBe("hosted_only");
    expect(resolved.sources.routingMode).toBe("environment");
  });

  it("reads legacy JSON configuration through the production resolver", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: {
        search: { searxngUrl: "http://legacy-json.test:8099" },
        providers: {
          firecrawl: {
            url: "https://legacy-json.firecrawl.test",
            apiKey: "legacy-json-secret",
          },
        },
      },
    });

    expect(resolved.values.localSearch.endpoint).toBe(
      "http://legacy-json.test:8099",
    );
    expect(resolved.values.remoteFetch.firecrawl).toEqual({
      classification: "explicit_remote_fetch_crawl_escalation",
      enabled: false,
      url: "https://legacy-json.firecrawl.test",
      apiKey: "legacy-json-secret",
    });
    expect(resolved.sources.firecrawlUrl).toBe("user_config");
    expect(resolved.sources.firecrawlApiKey).toBe("user_config");
  });

  it("resolves hosted fallback, cache, provider-control, and budget inputs through one precedence chain", () => {
    const resolved = resolveControlPlaneConfig({
      operation: {
        search: {
          hostedFallback: {
            enabled: true,
            providerOrder: ["brave"],
            minimumResults: 4,
          },
        },
        cache: {
          url: "redis://operation-cache.test:6381",
        },
      },
      environment: {
        ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "false",
        ULTRASEARCH_PROVIDER_ORDER: "exa,tinyfish",
        ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS: "2",
        ULTRASEARCH_CACHE_URL: "redis://environment-cache.test:6381",
        SEARXNG_MAX_IN_FLIGHT: "9",
        ULTRASEARCH_EXA_SEARCH_BUDGET_MONTHLY_UNITS: "100",
        ULTRASEARCH_EXA_SEARCH_BUDGET_UNITS_PER_REQUEST: "2",
        ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT: "70",
      },
      userConfig: {
        search: {
          hostedFallbackEnabled: false,
          providerOrder: ["parallel", "tinyfish"],
          fallbackMinResults: 3,
        },
        cache: {
          url: "redis://user-cache.test:6381",
        },
        providerControl: {
          searxng: {
            maxInFlight: 7,
          },
        },
        providers: {
          exa: {
            budget: {
              monthlyUnits: 50,
              unitsPerRequest: 1.5,
              warnPercent: 60,
            },
          },
        },
      },
    });

    expect(resolved.values.search.hostedFallback).toEqual({
      enabled: true,
      withEngineFilter: false,
      providerOrder: ["brave"],
      minimumResults: 4,
    });
    expect(resolved.values.cache.url).toBe("redis://operation-cache.test:6381");
    expect(resolved.values.providerControl.searxng.maxInFlight).toBe(9);
    expect(resolved.values.hostedSearch.providers.exa.budget).toEqual({
      monthlyUnits: 100,
      unitsPerRequest: 2,
      warnPercent: 70,
      failOpen: false,
    });
    expect(resolved.sources.hostedFallbackEnabled).toBe("operation");
    expect(resolved.sources.hostedProviderOrder).toBe("operation");
    expect(resolved.sources.hostedFallbackMinimumResults).toBe("operation");
    expect(resolved.sources.cacheUrl).toBe("operation");
    expect(resolved.sources.providerControl.searxng.maxInFlight).toBe(
      "environment",
    );
    expect(
      resolved.sources.hostedSearch.providers.exa.budget.monthlyUnits,
    ).toBe("environment");
  });

  it("resolves the engine-filter opt-in through one precedence chain and prefers canonical JSON over its legacy alias", () => {
    const defaults = resolveControlPlaneConfig({ profile: "hybrid" });

    expect(defaults.values.search.hostedFallback.withEngineFilter).toBe(false);
    expect(defaults.sources.hostedFallbackWithEngineFilter).toBe("default");

    const userOnly = resolveControlPlaneConfig({
      userConfig: {
        search: {
          hostedFallback: {
            withEngineFilter: false,
          },
          fallbackWithEngineFilter: true,
        },
      },
    });

    expect(userOnly.values.search.hostedFallback.withEngineFilter).toBe(false);
    expect(userOnly.sources.hostedFallbackWithEngineFilter).toBe("user_config");

    const resolved = resolveControlPlaneConfig({
      operation: {
        search: {
          hostedFallback: {
            withEngineFilter: true,
          },
        },
      },
      environment: {
        ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER: "false",
        HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER: "true",
      },
      userConfig: {
        search: {
          hostedFallback: {
            withEngineFilter: false,
          },
          fallbackWithEngineFilter: true,
        },
      },
      profile: "hybrid",
    });

    expect(resolved.values.search.hostedFallback.withEngineFilter).toBe(true);
    expect(resolved.sources.hostedFallbackWithEngineFilter).toBe("operation");

    const canonicalEnvironment = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER: "false",
        HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER: "true",
      },
      userConfig: {
        search: {
          hostedFallback: {
            withEngineFilter: true,
          },
        },
      },
    });

    expect(
      canonicalEnvironment.values.search.hostedFallback.withEngineFilter,
    ).toBe(false);
    expect(canonicalEnvironment.sources.hostedFallbackWithEngineFilter).toBe(
      "environment",
    );

    const legacyEnvironment = resolveControlPlaneConfig({
      environment: {
        HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER: "true",
      },
      userConfig: {
        search: {
          hostedFallback: {
            withEngineFilter: false,
          },
        },
      },
    });

    expect(
      legacyEnvironment.values.search.hostedFallback.withEngineFilter,
    ).toBe(true);
    expect(legacyEnvironment.sources.hostedFallbackWithEngineFilter).toBe(
      "environment",
    );
  });

  it("resolves the canonical runtime mode through the standard precedence chain", () => {
    const resolved = resolveControlPlaneConfig({
      operation: { runtime: { mode: "operator_compose" } },
      environment: {
        ULTRASEARCH_RUNTIME_MODE: "external_endpoint",
        RUNTIME_MODE: "unavailable",
      },
      userConfig: {
        runtime: { mode: "unavailable" },
      },
    });

    expect(resolved.values.runtime.mode).toBe("operator_compose");
    expect(resolved.sources.runtimeMode).toBe("operation");
    expect(CONFIG_SCHEMA.runtime.mode).toEqual({ kind: "field" });

    const environment = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_RUNTIME_MODE: "operator_compose" },
      userConfig: { runtime: { mode: "unavailable" } },
    });

    expect(environment.values.runtime.mode).toBe("operator_compose");
    expect(environment.sources.runtimeMode).toBe("environment");

    const defaults = resolveControlPlaneConfig({
      environment: { RUNTIME_MODE: "unavailable" },
    });

    expect(defaults.values.runtime.mode).toBe("external_endpoint");
    expect(defaults.sources.runtimeMode).toBe("default");
  });

  it("requires exact runtime modes and ignores invalid higher-precedence values", () => {
    const invalidMode = "operator-compose" as RuntimeMode;
    const resolved = resolveControlPlaneConfig({
      operation: { runtime: { mode: invalidMode } },
      environment: { ULTRASEARCH_RUNTIME_MODE: "not-a-runtime-mode" },
      userConfig: { runtime: { mode: "unavailable" } },
      profile: "hybrid",
    });

    expect(RUNTIME_MODES).toEqual([
      "external_endpoint",
      "operator_compose",
      "unavailable",
    ]);
    expect(resolved.values.runtime.mode).toBe("unavailable");
    expect(resolved.sources.runtimeMode).toBe("user_config");

    const defaults = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_RUNTIME_MODE: "invalid" },
      userConfig: { runtime: { mode: "invalid" } },
      profile: "hybrid",
    });

    expect(defaults.values.runtime.mode).toBe("external_endpoint");
    expect(defaults.sources.runtimeMode).toBe("default");
  });

  it("preserves the explicit auto fallback mode through compatibility inputs", () => {
    const resolved = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "auto",
      },
      userConfig: {
        search: {
          hostedFallback: {
            enabled: false,
          },
        },
      },
    });

    expect(resolved.values.search.hostedFallback.enabled).toBe("auto");
    expect(resolved.sources.hostedFallbackEnabled).toBe("environment");
  });

  it("adapts the legacy global budget fail-open setting without overriding a provider-specific setting", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: {
        budget: {
          failOpen: true,
        },
        providers: {
          exa: {
            budget: {
              failOpen: false,
            },
          },
        },
      },
    });

    expect(resolved.values.hostedSearch.providers.exa.budget.failOpen).toBe(
      false,
    );
    expect(resolved.values.hostedSearch.providers.brave.budget.failOpen).toBe(
      true,
    );
    expect(resolved.sources.hostedSearch.providers.exa.budget.failOpen).toBe(
      "user_config",
    );
    expect(resolved.sources.hostedSearch.providers.brave.budget.failOpen).toBe(
      "user_config",
    );
  });

  it("classifies Firecrawl as explicit remote fetch and crawl escalation", () => {
    const resolved = resolveControlPlaneConfig();

    expect(resolved.values.remoteFetch.firecrawl.classification).toBe(
      "explicit_remote_fetch_crawl_escalation",
    );
  });

  it("redacts schema-classified nested values without mutating the source", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: {
        providers: {
          firecrawl: {
            apiKey: "super-secret-value",
          },
        },
      },
    });

    const redacted = redactConfigForDiagnostics(resolved.values);

    expect(redacted).toMatchObject({
      remoteFetch: { firecrawl: { apiKey: "[redacted]" } },
    });
    expect(resolved.values.remoteFetch.firecrawl.apiKey).toBe(
      "super-secret-value",
    );
  });

  it("uses supplied schema metadata to redact future nested sensitive fields", () => {
    const source = {
      provider: {
        nested: {
          accessToken: "future-secret",
          region: "ca",
        },
      },
    };
    const schema = {
      provider: {
        nested: {
          accessToken: { kind: "field", sensitive: true },
          region: { kind: "field" },
        },
      },
    } as const;

    expect(redactWithConfigSchema(source, schema)).toEqual({
      provider: {
        nested: {
          accessToken: "[redacted]",
          region: "ca",
        },
      },
    });
    expect(source.provider.nested.accessToken).toBe("future-secret");
  });

  it("uses process inputs only when no explicit compatibility input is provided", () => {
    const previousUrl = process.env.ULTRASEARCH_SEARXNG_URL;
    try {
      process.env.ULTRASEARCH_SEARXNG_URL = "http://process.test:8099";
      resetRuntimeConfigForTests();

      expect(getControlPlaneConfig().values.localSearch.endpoint).toBe(
        "http://process.test:8099",
      );
    } finally {
      if (previousUrl === undefined) delete process.env.ULTRASEARCH_SEARXNG_URL;
      else process.env.ULTRASEARCH_SEARXNG_URL = previousUrl;
      resetRuntimeConfigForTests();
    }
  });
});
