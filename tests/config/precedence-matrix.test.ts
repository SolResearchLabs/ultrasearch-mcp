import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigProfileName } from "../../src/config/profiles.js";
import type { ConfigInput, ConfigSource } from "../../src/config/schema.js";
import {
  getControlPlaneConfig,
  type ResolvedControlPlaneConfig,
  resolveControlPlaneConfig,
} from "../../src/control-plane/config.js";
import {
  normalizeRuntimeConfigString,
  resetRuntimeConfigForTests,
  runtimeConfigSnapshot,
  ultrasearchConfigPath,
} from "../../src/runtime-config.js";

// H7 configuration precedence matrix: every field below is resolved through
// the production resolver with the layer cascade operation > environment >
// user_config > profile > default, asserting the resolved value AND the
// `sources` attribution at each step. File-backed cases use temp
// ULTRASEARCH_CONFIG files with capture/restore of every environment key that
// could otherwise leak in.

const CONFIG_ENV = [
  "ULTRASEARCH_CONFIG",
  "ULTRASEARCH_SEARXNG_URL",
  "SEARXNG_URL",
  "ULTRASEARCH_RUNTIME_MODE",
  "ULTRASEARCH_ROUTING_MODE",
  "ROUTING_MODE",
  "ULTRASEARCH_HOSTED_FALLBACK_ENABLED",
  "HOSTED_SEARCH_FALLBACK_ENABLED",
  "ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER",
  "HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER",
  "ULTRASEARCH_PROVIDER_ORDER",
  "HOSTED_SEARCH_PROVIDER_ORDER",
  "ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS",
  "HOSTED_SEARCH_FALLBACK_MIN_RESULTS",
  "ULTRASEARCH_CACHE_URL",
  "CACHE_URL",
  "VALKEY_URL",
  "REDIS_URL",
  "ULTRASEARCH_CACHE_COMMAND_TIMEOUT_MS",
  "CACHE_COMMAND_TIMEOUT_MS",
  "ULTRASEARCH_CACHE_CONNECT_TIMEOUT_MS",
  "CACHE_CONNECT_TIMEOUT_MS",
  "ULTRASEARCH_CACHE_MAX_RETRIES_PER_REQUEST",
  "CACHE_MAX_RETRIES_PER_REQUEST",
  "ULTRASEARCH_FIRECRAWL_ENABLED",
  "FIRECRAWL_ENABLED",
  "ULTRASEARCH_FIRECRAWL_URL",
  "FIRECRAWL_URL",
  "ULTRASEARCH_FIRECRAWL_API_KEY",
  "FIRECRAWL_API_KEY",
  "ULTRASEARCH_PROFILE",
  "ULTRASEARCH_SEARXNG_MAX_IN_FLIGHT",
  "SEARXNG_MAX_IN_FLIGHT",
  "ULTRASEARCH_CLOUDFLARE_QUICK_ACTION_RPS",
  "CLOUDFLARE_QUICK_ACTION_RPS",
  "ULTRASEARCH_EXA_SEARCH_MAX_IN_FLIGHT",
  "EXA_SEARCH_MAX_IN_FLIGHT",
  "ULTRASEARCH_EXA_SEARCH_BUDGET_MONTHLY_UNITS",
  "EXA_SEARCH_BUDGET_MONTHLY_UNITS",
  "ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT",
  "EXA_SEARCH_BUDGET_WARN_PERCENT",
  "ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN",
  "HOSTED_SEARCH_BUDGET_FAIL_OPEN",
  "PRECEDENCE_MATRIX_SECRET",
];

const originalValues = new Map<string, string | undefined>();
let dir = "";
let configPath = "";

// Built by concatenation (not a template literal) so a placeholder stays a
// plain string: `$` + `{name}` is exactly what the production expander reads.
function envRef(name: string, fallback?: string): string {
  const inner = fallback === undefined ? name : [name, ":-", fallback].join("");
  return ["$", "{", inner, "}"].join("");
}

function writeUserConfig(content: unknown): void {
  writeFileSync(
    configPath,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  process.env.ULTRASEARCH_CONFIG = configPath;
  resetRuntimeConfigForTests();
}

beforeEach(() => {
  originalValues.clear();
  for (const key of CONFIG_ENV) {
    originalValues.set(key, process.env[key]);
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "ultrasearch-precedence-"));
  configPath = join(dir, "config.json");
  // Default posture: a config path that does not exist, so only explicit
  // layers contribute.
  process.env.ULTRASEARCH_CONFIG = join(dir, "missing-config.json");
  resetRuntimeConfigForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  expect(existsSync(dir)).toBe(false);
  for (const key of CONFIG_ENV) {
    const value = originalValues.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalValues.clear();
  resetRuntimeConfigForTests();
});

interface FieldCase {
  name: string;
  operation: ConfigInput;
  environment: Record<string, string>;
  userConfig: Record<string, unknown>;
  profile: ConfigProfileName;
  profileValue?: unknown;
  read: (resolved: ResolvedControlPlaneConfig) => unknown;
  source: (resolved: ResolvedControlPlaneConfig) => ConfigSource;
  values: {
    operation: unknown;
    environment: unknown;
    user_config: unknown;
    default: unknown;
  };
}

const FIELDS: FieldCase[] = [
  {
    name: "localSearch.endpoint",
    operation: {
      localSearch: { endpoint: "http://operation.matrix.test:8099" },
    },
    environment: {
      ULTRASEARCH_SEARXNG_URL: "http://environment.matrix.test:8099",
    },
    userConfig: { localSearch: { endpoint: "http://user.matrix.test:8099" } },
    profile: "hybrid",
    read: (resolved) => resolved.values.localSearch.endpoint,
    source: (resolved) => resolved.sources.localSearchEndpoint,
    values: {
      operation: "http://operation.matrix.test:8099",
      environment: "http://environment.matrix.test:8099",
      user_config: "http://user.matrix.test:8099",
      default: "http://127.0.0.1:8099",
    },
  },
  {
    name: "runtime.mode",
    operation: { runtime: { mode: "operator_compose" } },
    environment: { ULTRASEARCH_RUNTIME_MODE: "external_endpoint" },
    userConfig: { runtime: { mode: "unavailable" } },
    profile: "hybrid",
    read: (resolved) => resolved.values.runtime.mode,
    source: (resolved) => resolved.sources.runtimeMode,
    values: {
      operation: "operator_compose",
      environment: "external_endpoint",
      user_config: "unavailable",
      default: "external_endpoint",
    },
  },
  {
    name: "routing.mode",
    operation: { routing: { mode: "offline_fetch_only" } },
    environment: { ULTRASEARCH_ROUTING_MODE: "hosted_only" },
    userConfig: { routing: { mode: "local_only" } },
    profile: "hybrid",
    profileValue: "hybrid",
    read: (resolved) => resolved.values.routing.mode,
    source: (resolved) => resolved.sources.routingMode,
    values: {
      operation: "offline_fetch_only",
      environment: "hosted_only",
      user_config: "local_only",
      default: "local_first",
    },
  },
  {
    name: "search.hostedFallback.enabled",
    operation: { search: { hostedFallback: { enabled: true } } },
    environment: { ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "false" },
    userConfig: { search: { hostedFallback: { enabled: "auto" } } },
    profile: "hybrid",
    read: (resolved) => resolved.values.search.hostedFallback.enabled,
    source: (resolved) => resolved.sources.hostedFallbackEnabled,
    values: {
      operation: true,
      environment: false,
      user_config: "auto",
      default: "auto",
    },
  },
  {
    name: "search.hostedFallback.withEngineFilter",
    operation: { search: { hostedFallback: { withEngineFilter: true } } },
    environment: {
      ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER: "false",
    },
    userConfig: { search: { fallbackWithEngineFilter: true } },
    profile: "hybrid",
    read: (resolved) => resolved.values.search.hostedFallback.withEngineFilter,
    source: (resolved) => resolved.sources.hostedFallbackWithEngineFilter,
    values: {
      operation: true,
      environment: false,
      user_config: true,
      default: false,
    },
  },
  {
    name: "search.hostedFallback.providerOrder",
    operation: { search: { hostedFallback: { providerOrder: ["brave"] } } },
    environment: { ULTRASEARCH_PROVIDER_ORDER: "exa,tinyfish" },
    userConfig: {
      search: { providerOrder: ["parallel", "tinyfish"] },
    },
    profile: "hybrid",
    read: (resolved) => resolved.values.search.hostedFallback.providerOrder,
    source: (resolved) => resolved.sources.hostedProviderOrder,
    values: {
      operation: ["brave"],
      environment: ["exa", "tinyfish"],
      user_config: ["parallel", "tinyfish"],
      default: ["tinyfish", "exa", "parallel", "brave"],
    },
  },
  {
    name: "search.hostedFallback.minimumResults",
    operation: { search: { hostedFallback: { minimumResults: 4 } } },
    environment: { ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS: "2" },
    userConfig: { search: { fallbackMinResults: 3 } },
    profile: "hybrid",
    read: (resolved) => resolved.values.search.hostedFallback.minimumResults,
    source: (resolved) => resolved.sources.hostedFallbackMinimumResults,
    values: {
      operation: 4,
      environment: 2,
      user_config: 3,
      default: 1,
    },
  },
  {
    name: "cache.url",
    operation: { cache: { url: "redis://operation.matrix.test:6381" } },
    environment: {
      ULTRASEARCH_CACHE_URL: "redis://environment.matrix.test:6381",
    },
    userConfig: { cache: { url: "redis://user.matrix.test:6381" } },
    profile: "hybrid",
    read: (resolved) => resolved.values.cache.url,
    source: (resolved) => resolved.sources.cacheUrl,
    values: {
      operation: "redis://operation.matrix.test:6381",
      environment: "redis://environment.matrix.test:6381",
      user_config: "redis://user.matrix.test:6381",
      default: "redis://localhost:6381",
    },
  },
  {
    name: "cache.commandTimeoutMs",
    operation: { cache: { commandTimeoutMs: 1111 } },
    environment: { ULTRASEARCH_CACHE_COMMAND_TIMEOUT_MS: "2222" },
    userConfig: { cache: { commandTimeoutMs: 3333 } },
    profile: "hybrid",
    read: (resolved) => resolved.values.cache.commandTimeoutMs,
    source: (resolved) => resolved.sources.cacheCommandTimeoutMs,
    values: {
      operation: 1111,
      environment: 2222,
      user_config: 3333,
      default: 2500,
    },
  },
  {
    name: "cache.connectTimeoutMs",
    operation: { cache: { connectTimeoutMs: 1111 } },
    environment: { ULTRASEARCH_CACHE_CONNECT_TIMEOUT_MS: "2222" },
    userConfig: { cache: { connectTimeoutMs: 3333 } },
    profile: "hybrid",
    read: (resolved) => resolved.values.cache.connectTimeoutMs,
    source: (resolved) => resolved.sources.cacheConnectTimeoutMs,
    values: {
      operation: 1111,
      environment: 2222,
      user_config: 3333,
      default: 3000,
    },
  },
  {
    name: "cache.maxRetriesPerRequest",
    operation: { cache: { maxRetriesPerRequest: 5 } },
    environment: { ULTRASEARCH_CACHE_MAX_RETRIES_PER_REQUEST: "6" },
    userConfig: { cache: { maxRetriesPerRequest: 7 } },
    profile: "hybrid",
    read: (resolved) => resolved.values.cache.maxRetriesPerRequest,
    source: (resolved) => resolved.sources.cacheMaxRetriesPerRequest,
    values: {
      operation: 5,
      environment: 6,
      user_config: 7,
      default: 2,
    },
  },
  {
    name: "remoteFetch.firecrawl.enabled",
    operation: { remoteFetch: { firecrawl: { enabled: true } } },
    environment: { ULTRASEARCH_FIRECRAWL_ENABLED: "false" },
    userConfig: { remoteFetch: { firecrawl: { enabled: true } } },
    profile: "hybrid",
    read: (resolved) => resolved.values.remoteFetch.firecrawl.enabled,
    source: (resolved) => resolved.sources.firecrawlEnabled,
    values: {
      operation: true,
      environment: false,
      user_config: true,
      default: false,
    },
  },
  {
    name: "remoteFetch.firecrawl.url",
    operation: {
      remoteFetch: { firecrawl: { url: "https://operation.firecrawl.test" } },
    },
    environment: {
      ULTRASEARCH_FIRECRAWL_URL: "https://environment.firecrawl.test",
    },
    userConfig: {
      remoteFetch: { firecrawl: { url: "https://user.firecrawl.test" } },
    },
    profile: "hybrid",
    read: (resolved) => resolved.values.remoteFetch.firecrawl.url,
    source: (resolved) => resolved.sources.firecrawlUrl,
    values: {
      operation: "https://operation.firecrawl.test",
      environment: "https://environment.firecrawl.test",
      user_config: "https://user.firecrawl.test",
      default: "",
    },
  },
  {
    name: "remoteFetch.firecrawl.apiKey",
    operation: {
      remoteFetch: {
        firecrawl: { apiKey: "matrix-firecrawl-operation" },
      },
    },
    environment: {
      ULTRASEARCH_FIRECRAWL_API_KEY: "matrix-firecrawl-environment",
    },
    userConfig: {
      remoteFetch: { firecrawl: { apiKey: "matrix-firecrawl-user" } },
    },
    profile: "hybrid",
    read: (resolved) => resolved.values.remoteFetch.firecrawl.apiKey,
    source: (resolved) => resolved.sources.firecrawlApiKey,
    values: {
      operation: "matrix-firecrawl-operation",
      environment: "matrix-firecrawl-environment",
      user_config: "matrix-firecrawl-user",
      default: "",
    },
  },
  {
    name: "providerControl.searxng.maxInFlight",
    operation: { providerControl: { searxng: { maxInFlight: 11 } } },
    environment: { SEARXNG_MAX_IN_FLIGHT: "9" },
    userConfig: { providerControl: { searxng: { maxInFlight: 7 } } },
    profile: "hybrid",
    read: (resolved) => resolved.values.providerControl.searxng.maxInFlight,
    source: (resolved) => resolved.sources.providerControl.searxng.maxInFlight,
    values: {
      operation: 11,
      environment: 9,
      user_config: 7,
      default: 6,
    },
  },
  {
    name: "providerControl.cloudflare.quickActionRps",
    operation: { providerControl: { cloudflare: { quickActionRps: 3.5 } } },
    environment: { CLOUDFLARE_QUICK_ACTION_RPS: "2.5" },
    userConfig: { providerControl: { cloudflare: { quickActionRps: 1.5 } } },
    profile: "hybrid",
    read: (resolved) =>
      resolved.values.providerControl.cloudflare.quickActionRps,
    source: (resolved) =>
      resolved.sources.providerControl.cloudflare.quickActionRps,
    values: {
      operation: 3.5,
      environment: 2.5,
      user_config: 1.5,
      default: 0.1,
    },
  },
  {
    name: "hostedSearch.providers.exa.budget.monthlyUnits",
    operation: {
      hostedSearch: { providers: { exa: { budget: { monthlyUnits: 500 } } } },
    },
    environment: { ULTRASEARCH_EXA_SEARCH_BUDGET_MONTHLY_UNITS: "400" },
    userConfig: {
      providers: { exa: { budget: { monthlyUnits: 300 } } },
    },
    profile: "hybrid",
    read: (resolved) =>
      resolved.values.hostedSearch.providers.exa.budget.monthlyUnits,
    source: (resolved) =>
      resolved.sources.hostedSearch.providers.exa.budget.monthlyUnits,
    values: {
      operation: 500,
      environment: 400,
      user_config: 300,
      default: undefined,
    },
  },
  {
    name: "hostedSearch.providers.exa.budget.warnPercent",
    operation: {
      hostedSearch: { providers: { exa: { budget: { warnPercent: 50 } } } },
    },
    environment: { ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT: "60" },
    userConfig: {
      hostedSearch: { providers: { exa: { budget: { warnPercent: 70 } } } },
    },
    profile: "hybrid",
    read: (resolved) =>
      resolved.values.hostedSearch.providers.exa.budget.warnPercent,
    source: (resolved) =>
      resolved.sources.hostedSearch.providers.exa.budget.warnPercent,
    values: {
      operation: 50,
      environment: 60,
      user_config: 70,
      default: 80,
    },
  },
  {
    name: "hostedSearch.providers.exa.control.maxInFlight",
    operation: {
      hostedSearch: { providers: { exa: { control: { maxInFlight: 5 } } } },
    },
    environment: { ULTRASEARCH_EXA_SEARCH_MAX_IN_FLIGHT: "4" },
    userConfig: { providers: { exa: { control: { maxInFlight: 3 } } } },
    profile: "hybrid",
    read: (resolved) =>
      resolved.values.hostedSearch.providers.exa.control.maxInFlight,
    source: (resolved) =>
      resolved.sources.hostedSearch.providers.exa.control.maxInFlight,
    values: {
      operation: 5,
      environment: 4,
      user_config: 3,
      default: 2,
    },
  },
];

describe("H7 layer precedence matrix (operation > environment > user_config > profile > default)", () => {
  for (const field of FIELDS) {
    const profileNote =
      field.profileValue === undefined ? "default" : "profile > default";
    it(`${field.name}: operation > environment > user_config > ${profileNote}`, () => {
      const all = resolveControlPlaneConfig({
        operation: field.operation,
        environment: field.environment,
        userConfig: field.userConfig,
        profile: field.profile,
      });
      expect(field.read(all)).toEqual(field.values.operation);
      expect(field.source(all)).toBe("operation");

      const environmentOnly = resolveControlPlaneConfig({
        environment: field.environment,
        userConfig: field.userConfig,
        profile: field.profile,
      });
      expect(field.read(environmentOnly)).toEqual(field.values.environment);
      expect(field.source(environmentOnly)).toBe("environment");

      const userOnly = resolveControlPlaneConfig({
        userConfig: field.userConfig,
        profile: field.profile,
      });
      expect(field.read(userOnly)).toEqual(field.values.user_config);
      expect(field.source(userOnly)).toBe("user_config");

      const profileOnly = resolveControlPlaneConfig({
        userConfig: {},
        profile: field.profile,
      });
      expect(field.read(profileOnly)).toEqual(
        field.profileValue ?? field.values.default,
      );
      expect(field.source(profileOnly)).toBe(
        field.profileValue === undefined ? "default" : "profile",
      );

      const defaults = resolveControlPlaneConfig({ userConfig: {} });
      expect(field.read(defaults)).toEqual(field.values.default);
      expect(field.source(defaults)).toBe("default");
    });
  }

  it("attributes an invalid higher-precedence value to the layer that actually supplied it", () => {
    const resolved = resolveControlPlaneConfig({
      operation: { routing: { mode: "not-a-mode" as never } },
      environment: { ULTRASEARCH_ROUTING_MODE: "hosted_only" },
      userConfig: { routing: { mode: "local_only" } },
    });
    expect(resolved.values.routing.mode).toBe("hosted_only");
    expect(resolved.sources.routingMode).toBe("environment");
  });
});

describe("H7 profile selection precedence", () => {
  it("operation profile wins over environment and user config", () => {
    const resolved = resolveControlPlaneConfig({
      profile: "local",
      environment: { ULTRASEARCH_PROFILE: "hosted" },
      userConfig: { profile: "offline" },
    });
    expect(resolved.profile).toEqual({ name: "local", source: "operation" });
    expect(resolved.values.routing.mode).toBe("local_only");
    expect(resolved.sources.routingMode).toBe("profile");
  });

  it("environment profile wins over user config", () => {
    const resolved = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_PROFILE: "hosted" },
      userConfig: { profile: "offline" },
    });
    expect(resolved.profile).toEqual({ name: "hosted", source: "environment" });
    expect(resolved.values.routing.mode).toBe("hosted_only");
  });

  it("user-config profile is used when no higher layer selects one", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: { profile: "offline" },
    });
    expect(resolved.profile).toEqual({
      name: "offline",
      source: "user_config",
    });
    expect(resolved.values.routing.mode).toBe("offline_fetch_only");
  });

  it("ignores unknown profile names at every layer", () => {
    const resolved = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_PROFILE: "not-a-profile" },
      userConfig: { profile: "also-not-a-profile" },
    });
    expect(resolved.profile).toEqual({ name: null, source: "default" });
    expect(resolved.values.routing.mode).toBe("local_first");
    expect(resolved.sources.routingMode).toBe("default");
  });
});

describe("H7 environment-variable expansion and placeholder rejection", () => {
  it("expands an environment-variable reference in user-config values", () => {
    process.env.PRECEDENCE_MATRIX_SECRET = "matrix-expanded-value";
    writeUserConfig({
      remoteFetch: {
        firecrawl: { apiKey: envRef("PRECEDENCE_MATRIX_SECRET") },
      },
    });
    const resolved = getControlPlaneConfig();
    expect(resolved.values.remoteFetch.firecrawl.apiKey).toBe(
      "matrix-expanded-value",
    );
    expect(resolved.sources.firecrawlApiKey).toBe("user_config");
  });

  it("honors the :- fallback for unset and empty variables", () => {
    const template = [
      "matrix-",
      envRef("PRECEDENCE_MATRIX_SECRET", "fallback"),
      "-tail",
    ].join("");
    writeUserConfig({ remoteFetch: { firecrawl: { apiKey: template } } });

    expect(getControlPlaneConfig().values.remoteFetch.firecrawl.apiKey).toBe(
      "matrix-fallback-tail",
    );

    process.env.PRECEDENCE_MATRIX_SECRET = "";
    resetRuntimeConfigForTests();
    expect(getControlPlaneConfig().values.remoteFetch.firecrawl.apiKey).toBe(
      "matrix-fallback-tail",
    );

    process.env.PRECEDENCE_MATRIX_SECRET = "expanded";
    resetRuntimeConfigForTests();
    expect(getControlPlaneConfig().values.remoteFetch.firecrawl.apiKey).toBe(
      "matrix-expanded-tail",
    );
  });

  it("rejects unresolved user_config dot-path placeholders from files and environment", () => {
    writeUserConfig({
      localSearch: { endpoint: envRef("user_config.searxng_url") },
      remoteFetch: {
        firecrawl: { apiKey: envRef("user_config.firecrawl_api_key") },
      },
    });
    const fromFile = getControlPlaneConfig();
    expect(fromFile.values.localSearch.endpoint).toBe("http://127.0.0.1:8099");
    expect(fromFile.sources.localSearchEndpoint).toBe("default");
    expect(fromFile.values.remoteFetch.firecrawl.apiKey).toBe("");
    expect(fromFile.sources.firecrawlApiKey).toBe("default");

    const fromEnvironment = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_SEARXNG_URL: envRef("user_config.searxng_url"),
      },
      userConfig: { localSearch: { endpoint: "http://user.matrix.test:8099" } },
    });
    expect(fromEnvironment.values.localSearch.endpoint).toBe(
      "http://user.matrix.test:8099",
    );
    expect(fromEnvironment.sources.localSearchEndpoint).toBe("user_config");
  });

  it("normalizes whitespace and treats an empty expansion as unset", () => {
    expect(normalizeRuntimeConfigString("  matrix-value  ")).toBe(
      "matrix-value",
    );
    expect(
      normalizeRuntimeConfigString(envRef("PRECEDENCE_MATRIX_SECRET")),
    ).toBe(undefined);
    expect(normalizeRuntimeConfigString(envRef("user_config.some_key"))).toBe(
      undefined,
    );
  });
});

describe("H7 ULTRASEARCH_CONFIG file path behaviors", () => {
  it("reads the file named by ULTRASEARCH_CONFIG for user-config values", () => {
    writeUserConfig({
      localSearch: { endpoint: "http://file.matrix.test:8099" },
      cache: { url: "redis://file.matrix.test:6381" },
    });
    expect(ultrasearchConfigPath()).toBe(configPath);
    const resolved = getControlPlaneConfig();
    expect(resolved.values.localSearch.endpoint).toBe(
      "http://file.matrix.test:8099",
    );
    expect(resolved.sources.localSearchEndpoint).toBe("user_config");
    expect(resolved.values.cache.url).toBe("redis://file.matrix.test:6381");
  });

  it("falls back to defaults when the file is missing", () => {
    const missing = join(dir, "missing.json");
    process.env.ULTRASEARCH_CONFIG = missing;
    resetRuntimeConfigForTests();
    expect(ultrasearchConfigPath()).toBe(missing);
    const resolved = getControlPlaneConfig();
    expect(resolved.values.localSearch.endpoint).toBe("http://127.0.0.1:8099");
    expect(resolved.sources.localSearchEndpoint).toBe("default");
  });

  it("warns and falls back to defaults for malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeUserConfig("{not-json");
    const resolved = getControlPlaneConfig();
    expect(resolved.values.localSearch.endpoint).toBe("http://127.0.0.1:8099");
    expect(resolved.sources.localSearchEndpoint).toBe("default");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read config file"),
    );
    warn.mockRestore();
  });

  it("keeps the parsed file cached until resetRuntimeConfigForTests()", () => {
    writeUserConfig({ cache: { url: "redis://first.matrix.test:6381" } });
    expect(getControlPlaneConfig().values.cache.url).toBe(
      "redis://first.matrix.test:6381",
    );

    writeFileSync(
      configPath,
      JSON.stringify({ cache: { url: "redis://second.matrix.test:6381" } }),
    );
    expect(getControlPlaneConfig().values.cache.url).toBe(
      "redis://first.matrix.test:6381",
    );

    resetRuntimeConfigForTests();
    expect(getControlPlaneConfig().values.cache.url).toBe(
      "redis://second.matrix.test:6381",
    );
  });

  it("runtimeConfigSnapshot() returns a clone that cannot mutate the cache", () => {
    writeUserConfig({ cache: { url: "redis://snapshot.matrix.test:6381" } });
    const snapshot = runtimeConfigSnapshot();
    const cache = snapshot.cache as Record<string, unknown>;
    cache.url = "redis://mutated.matrix.test:6381";

    expect(runtimeConfigSnapshot()).toEqual({
      cache: { url: "redis://snapshot.matrix.test:6381" },
    });
    expect(getControlPlaneConfig().values.cache.url).toBe(
      "redis://snapshot.matrix.test:6381",
    );
  });
});

describe("H7 environment token parsing matrix", () => {
  it("parses every accepted boolean token and rejects an unrecognized one down the chain", () => {
    for (const token of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
      const resolved = resolveControlPlaneConfig({
        environment: { ULTRASEARCH_HOSTED_FALLBACK_ENABLED: token },
      });
      expect(resolved.values.search.hostedFallback.enabled).toBe(true);
      expect(resolved.sources.hostedFallbackEnabled).toBe("environment");
    }
    for (const token of ["0", "false", "no", "off", "FALSE", "No", "OFF"]) {
      const resolved = resolveControlPlaneConfig({
        environment: { ULTRASEARCH_HOSTED_FALLBACK_ENABLED: token },
      });
      expect(resolved.values.search.hostedFallback.enabled).toBe(false);
      expect(resolved.sources.hostedFallbackEnabled).toBe("environment");
    }

    const unrecognized = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "banana" },
      userConfig: { search: { hostedFallback: { enabled: false } } },
    });
    expect(unrecognized.values.search.hostedFallback.enabled).toBe(false);
    expect(unrecognized.sources.hostedFallbackEnabled).toBe("user_config");

    const fallback = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "banana" },
      userConfig: {},
    });
    expect(fallback.values.search.hostedFallback.enabled).toBe("auto");
    expect(fallback.sources.hostedFallbackEnabled).toBe("default");
  });

  it("parses numbers strictly and falls through on invalid tokens", () => {
    const zero = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS: "0" },
    });
    expect(zero.values.search.hostedFallback.minimumResults).toBe(0);
    expect(zero.sources.hostedFallbackMinimumResults).toBe("environment");

    for (const token of ["2.5", "-1", "abc", ""]) {
      const resolved = resolveControlPlaneConfig({
        environment: { ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS: token },
        userConfig: { search: { fallbackMinResults: 3 } },
      });
      expect(resolved.values.search.hostedFallback.minimumResults).toBe(3);
      expect(resolved.sources.hostedFallbackMinimumResults).toBe("user_config");
    }
  });

  it("clamps warnPercent to the 1..99.9 band and rejects non-positive values", () => {
    const clamped = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT: "150" },
    });
    expect(clamped.values.hostedSearch.providers.exa.budget.warnPercent).toBe(
      99.9,
    );

    const tooSmall = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_EXA_SEARCH_BUDGET_WARN_PERCENT: "0" },
      userConfig: {
        hostedSearch: { providers: { exa: { budget: { warnPercent: 70 } } } },
      },
    });
    expect(tooSmall.values.hostedSearch.providers.exa.budget.warnPercent).toBe(
      70,
    );
    expect(tooSmall.sources.hostedSearch.providers.exa.budget.warnPercent).toBe(
      "user_config",
    );
  });

  it("parses comma-separated provider lists with trimming, dedup, and unknown-id dropping", () => {
    const resolved = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_PROVIDER_ORDER: " exa , ROGUE , tinyfish , exa ",
      },
    });
    expect(resolved.values.search.hostedFallback.providerOrder).toEqual([
      "exa",
      "tinyfish",
    ]);
    expect(resolved.sources.hostedProviderOrder).toBe("environment");

    const legacy = resolveControlPlaneConfig({
      environment: { HOSTED_SEARCH_PROVIDER_ORDER: "brave,parallel" },
    });
    expect(legacy.values.search.hostedFallback.providerOrder).toEqual([
      "brave",
      "parallel",
    ]);

    const emptyish = resolveControlPlaneConfig({
      environment: { ULTRASEARCH_PROVIDER_ORDER: " , " },
    });
    expect(emptyish.values.search.hostedFallback.providerOrder).toEqual([
      "tinyfish",
      "exa",
      "parallel",
      "brave",
    ]);
    expect(emptyish.sources.hostedProviderOrder).toBe("default");
  });
});

describe("H7 canonical vs legacy user-config keys", () => {
  it("prefers canonical user-config keys over their legacy aliases", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: {
        localSearch: { endpoint: "http://canonical.matrix.test:8099" },
        search: { searxngUrl: "http://legacy.matrix.test:8099" },
        routing: { mode: "hybrid" },
        remoteFetch: {
          firecrawl: {
            enabled: true,
            url: "https://canonical.firecrawl.test",
            apiKey: "matrix-canonical",
          },
        },
        providers: {
          firecrawl: {
            enabled: false,
            url: "https://legacy.firecrawl.test",
            apiKey: "matrix-legacy",
          },
        },
      },
    });

    expect(resolved.values.localSearch.endpoint).toBe(
      "http://canonical.matrix.test:8099",
    );
    expect(resolved.values.remoteFetch.firecrawl).toMatchObject({
      enabled: true,
      url: "https://canonical.firecrawl.test",
      apiKey: "matrix-canonical",
    });
    expect(resolved.sources.firecrawlUrl).toBe("user_config");
    expect(resolved.sources.firecrawlApiKey).toBe("user_config");
  });

  it("reads legacy-only user-config aliases through the same resolver", () => {
    const resolved = resolveControlPlaneConfig({
      userConfig: {
        search: {
          searxngUrl: "http://legacy-only.matrix.test:8099",
          routingMode: "hybrid",
          providerOrder: ["parallel", "exa"],
          fallbackMinResults: 2,
        },
        providers: {
          exa: { budget: { monthlyUnits: 250 } },
        },
        budget: { failOpen: true },
      },
    });

    expect(resolved.values.localSearch.endpoint).toBe(
      "http://legacy-only.matrix.test:8099",
    );
    expect(resolved.values.routing.mode).toBe("hybrid");
    expect(resolved.values.search.hostedFallback.providerOrder).toEqual([
      "parallel",
      "exa",
    ]);
    expect(resolved.values.search.hostedFallback.minimumResults).toBe(2);
    expect(resolved.values.hostedSearch.providers.exa.budget.monthlyUnits).toBe(
      250,
    );
    // The global legacy budget.failOpen applies where a provider-specific
    // setting is absent.
    expect(resolved.values.hostedSearch.providers.exa.budget.failOpen).toBe(
      true,
    );
    expect(resolved.values.hostedSearch.providers.brave.budget.failOpen).toBe(
      true,
    );
    expect(resolved.sources.localSearchEndpoint).toBe("user_config");
  });
});
