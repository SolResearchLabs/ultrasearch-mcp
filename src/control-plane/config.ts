import {
  type ConfigProfileName,
  isConfigProfileName,
} from "../config/profiles.js";
import {
  type ConfigInput,
  type ConfigSource,
  type EffectiveConfig,
  HOSTED_SEARCH_PROVIDER_IDS,
  isHostedSearchProviderId,
  isRoutingMode,
  isRuntimeMode,
  resolveEffectiveConfig,
} from "../config/schema.js";
import {
  normalizeRuntimeConfigString,
  parseRuntimeConfigBoolean,
  type RuntimeConfigObject,
  runtimeConfigSnapshot,
} from "../runtime-config.js";

export type CompatibilityEnvironment = Record<string, string | undefined>;

export interface ControlPlaneConfigOptions {
  operation?: ConfigInput;
  profile?: ConfigProfileName;
  environment?: CompatibilityEnvironment;
  userConfig?: unknown;
}

export interface ResolvedControlPlaneConfig extends EffectiveConfig {
  profile: {
    name: ConfigProfileName | null;
    source: ConfigSource;
  };
}

type HostedProviderInputs = NonNullable<
  NonNullable<ConfigInput["hostedSearch"]>["providers"]
>;

function asObject(value: unknown): RuntimeConfigObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RuntimeConfigObject)
    : {};
}

function getObjectPath(object: RuntimeConfigObject, path: string[]): unknown {
  let current: unknown = object;
  for (const part of path) {
    const record = asObject(current);
    if (!Object.keys(record).includes(part)) return undefined;
    current = record[part];
  }
  return current;
}

function stringFromValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? normalizeRuntimeConfigString(value)
    : undefined;
}

function numberFromValue(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  const normalized = stringFromValue(value);
  if (normalized === undefined) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringListFromValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map(stringFromValue)
      .filter((item): item is string => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const normalized = stringFromValue(value);
  if (normalized === undefined) return undefined;
  const items = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function hostedProviderOrderFromValue(
  value: unknown,
): (typeof HOSTED_SEARCH_PROVIDER_IDS)[number][] | undefined {
  const candidates = stringListFromValue(value);
  if (!candidates) return undefined;
  const seen = new Set<(typeof HOSTED_SEARCH_PROVIDER_IDS)[number]>();
  const order: (typeof HOSTED_SEARCH_PROVIDER_IDS)[number][] = [];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (!isHostedSearchProviderId(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    order.push(normalized);
  }
  return order.length > 0 ? order : undefined;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function environmentString(
  environment: CompatibilityEnvironment,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value === undefined) continue;
    const normalized = normalizeRuntimeConfigString(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function environmentStringList(
  environment: CompatibilityEnvironment,
  names: string[],
): string[] | undefined {
  const value = environmentString(environment, names);
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function environmentNumber(
  environment: CompatibilityEnvironment,
  names: string[],
): number | undefined {
  return numberFromValue(environmentString(environment, names));
}

function environmentBoolean(
  environment: CompatibilityEnvironment,
  names: string[],
): boolean | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value === undefined) continue;
    const parsed = parseRuntimeConfigBoolean(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function hostedFallbackEnabledFromValue(
  value: unknown,
): boolean | "auto" | undefined {
  if (typeof value === "string") {
    const normalized = normalizeRuntimeConfigString(value);
    if (normalized?.toLowerCase() === "auto") return "auto";
  }
  return parseRuntimeConfigBoolean(value);
}

function hostedFallbackEnabledFromEnvironment(
  environment: CompatibilityEnvironment,
  names: string[],
): boolean | "auto" | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value === undefined) continue;
    const parsed = hostedFallbackEnabledFromValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function routingMode(value: unknown) {
  return isRoutingMode(value) ? value : undefined;
}

function runtimeMode(value: unknown) {
  return isRuntimeMode(value) ? value : undefined;
}

function providerControlFromEnvironment(
  environment: CompatibilityEnvironment,
  canonicalPrefix: string,
  legacyPrefix: string,
) {
  return {
    maxInFlight: environmentNumber(environment, [
      `${canonicalPrefix}_MAX_IN_FLIGHT`,
      `${legacyPrefix}_MAX_IN_FLIGHT`,
    ]),
    maxQueue: environmentNumber(environment, [
      `${canonicalPrefix}_MAX_QUEUE`,
      `${legacyPrefix}_MAX_QUEUE`,
    ]),
    queueTimeoutMs: environmentNumber(environment, [
      `${canonicalPrefix}_QUEUE_TIMEOUT_MS`,
      `${legacyPrefix}_QUEUE_TIMEOUT_MS`,
    ]),
    circuitFailureThreshold: environmentNumber(environment, [
      `${canonicalPrefix}_CIRCUIT_FAILURE_THRESHOLD`,
      `${legacyPrefix}_CIRCUIT_FAILURE_THRESHOLD`,
    ]),
    circuitCooldownMs: environmentNumber(environment, [
      `${canonicalPrefix}_CIRCUIT_COOLDOWN_MS`,
      `${legacyPrefix}_CIRCUIT_COOLDOWN_MS`,
    ]),
    circuitMaxCooldownMs: environmentNumber(environment, [
      `${canonicalPrefix}_CIRCUIT_MAX_COOLDOWN_MS`,
      `${legacyPrefix}_CIRCUIT_MAX_COOLDOWN_MS`,
    ]),
  };
}

function hostedProviderFromEnvironment(
  environment: CompatibilityEnvironment,
  provider: (typeof HOSTED_SEARCH_PROVIDER_IDS)[number],
) {
  const prefix = provider.toUpperCase();
  return {
    control: providerControlFromEnvironment(
      environment,
      `ULTRASEARCH_${prefix}_SEARCH`,
      `${prefix}_SEARCH`,
    ),
    budget: {
      monthlyUnits: environmentNumber(environment, [
        `ULTRASEARCH_${prefix}_SEARCH_BUDGET_MONTHLY_UNITS`,
        `${prefix}_SEARCH_BUDGET_MONTHLY_UNITS`,
      ]),
      unitsPerRequest: environmentNumber(environment, [
        `ULTRASEARCH_${prefix}_SEARCH_BUDGET_UNITS_PER_REQUEST`,
        `${prefix}_SEARCH_BUDGET_UNITS_PER_REQUEST`,
      ]),
      warnPercent: environmentNumber(environment, [
        `ULTRASEARCH_${prefix}_SEARCH_BUDGET_WARN_PERCENT`,
        `${prefix}_SEARCH_BUDGET_WARN_PERCENT`,
      ]),
      failOpen: environmentBoolean(environment, [
        "ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN",
        "HOSTED_SEARCH_BUDGET_FAIL_OPEN",
      ]),
    },
  };
}

function configInputFromEnvironment(
  environment: CompatibilityEnvironment,
): ConfigInput {
  return {
    localSearch: {
      endpoint: environmentString(environment, [
        "ULTRASEARCH_SEARXNG_URL",
        "SEARXNG_URL",
      ]),
    },
    runtime: {
      mode: runtimeMode(
        environmentString(environment, ["ULTRASEARCH_RUNTIME_MODE"]),
      ),
    },
    routing: {
      mode: routingMode(
        environmentString(environment, [
          "ULTRASEARCH_ROUTING_MODE",
          "ROUTING_MODE",
        ]),
      ),
    },
    search: {
      hostedFallback: {
        enabled: hostedFallbackEnabledFromEnvironment(environment, [
          "ULTRASEARCH_HOSTED_FALLBACK_ENABLED",
          "HOSTED_SEARCH_FALLBACK_ENABLED",
        ]),
        withEngineFilter: environmentBoolean(environment, [
          "ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER",
          "HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER",
        ]),
        providerOrder: hostedProviderOrderFromValue(
          environmentStringList(environment, [
            "ULTRASEARCH_PROVIDER_ORDER",
            "HOSTED_SEARCH_PROVIDER_ORDER",
          ]),
        ),
        minimumResults: environmentNumber(environment, [
          "ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS",
          "HOSTED_SEARCH_FALLBACK_MIN_RESULTS",
        ]),
      },
    },
    cache: {
      url: environmentString(environment, [
        "ULTRASEARCH_CACHE_URL",
        "CACHE_URL",
        "VALKEY_URL",
        "REDIS_URL",
      ]),
      commandTimeoutMs: environmentNumber(environment, [
        "ULTRASEARCH_CACHE_COMMAND_TIMEOUT_MS",
        "CACHE_COMMAND_TIMEOUT_MS",
      ]),
      connectTimeoutMs: environmentNumber(environment, [
        "ULTRASEARCH_CACHE_CONNECT_TIMEOUT_MS",
        "CACHE_CONNECT_TIMEOUT_MS",
      ]),
      maxRetriesPerRequest: environmentNumber(environment, [
        "ULTRASEARCH_CACHE_MAX_RETRIES_PER_REQUEST",
        "CACHE_MAX_RETRIES_PER_REQUEST",
      ]),
    },
    providerControl: {
      searxng: providerControlFromEnvironment(
        environment,
        "ULTRASEARCH_SEARXNG",
        "SEARXNG",
      ),
      cloudflare: {
        ...providerControlFromEnvironment(
          environment,
          "ULTRASEARCH_CLOUDFLARE",
          "CLOUDFLARE",
        ),
        quickActionRps: environmentNumber(environment, [
          "ULTRASEARCH_CLOUDFLARE_QUICK_ACTION_RPS",
          "CLOUDFLARE_QUICK_ACTION_RPS",
        ]),
        quickActionBurst: environmentNumber(environment, [
          "ULTRASEARCH_CLOUDFLARE_QUICK_ACTION_BURST",
          "CLOUDFLARE_QUICK_ACTION_BURST",
        ]),
        rateMaxWaiters: environmentNumber(environment, [
          "ULTRASEARCH_CLOUDFLARE_RATE_MAX_WAITERS",
          "CLOUDFLARE_RATE_MAX_WAITERS",
        ]),
        rateMaxWaitMs: environmentNumber(environment, [
          "ULTRASEARCH_CLOUDFLARE_RATE_MAX_WAIT_MS",
          "CLOUDFLARE_RATE_MAX_WAIT_MS",
        ]),
      },
      crawl4ai: providerControlFromEnvironment(
        environment,
        "ULTRASEARCH_CRAWL4AI",
        "CRAWL4AI",
      ),
    },
    hostedSearch: {
      providers: Object.fromEntries(
        HOSTED_SEARCH_PROVIDER_IDS.map((provider) => [
          provider,
          hostedProviderFromEnvironment(environment, provider),
        ]),
      ) as HostedProviderInputs,
    },
    remoteFetch: {
      firecrawl: {
        enabled: environmentBoolean(environment, [
          "ULTRASEARCH_FIRECRAWL_ENABLED",
          "FIRECRAWL_ENABLED",
        ]),
        url: environmentString(environment, [
          "ULTRASEARCH_FIRECRAWL_URL",
          "FIRECRAWL_URL",
        ]),
        apiKey: environmentString(environment, [
          "ULTRASEARCH_FIRECRAWL_API_KEY",
          "FIRECRAWL_API_KEY",
        ]),
      },
    },
  };
}

function controlFromUserConfig(value: unknown) {
  const control = asObject(value);
  return {
    maxInFlight: numberFromValue(control.maxInFlight),
    maxQueue: numberFromValue(control.maxQueue),
    queueTimeoutMs: numberFromValue(control.queueTimeoutMs),
    circuitFailureThreshold: numberFromValue(control.circuitFailureThreshold),
    circuitCooldownMs: numberFromValue(control.circuitCooldownMs),
    circuitMaxCooldownMs: numberFromValue(control.circuitMaxCooldownMs),
  };
}

function budgetFromUserConfig(value: unknown) {
  const budget = asObject(value);
  return {
    monthlyUnits: numberFromValue(budget.monthlyUnits),
    unitsPerRequest: numberFromValue(budget.unitsPerRequest),
    warnPercent: numberFromValue(budget.warnPercent),
    failOpen: parseRuntimeConfigBoolean(budget.failOpen),
  };
}

function mergeBudgetInputs(
  canonicalValue: unknown,
  legacyValue: unknown,
  legacyGlobalValue: unknown,
) {
  const canonical = budgetFromUserConfig(canonicalValue);
  const legacy = budgetFromUserConfig(legacyValue);
  const legacyGlobal = budgetFromUserConfig(legacyGlobalValue);

  return {
    monthlyUnits: firstDefined(canonical.monthlyUnits, legacy.monthlyUnits),
    unitsPerRequest: firstDefined(
      canonical.unitsPerRequest,
      legacy.unitsPerRequest,
    ),
    warnPercent: firstDefined(canonical.warnPercent, legacy.warnPercent),
    failOpen: firstDefined(
      canonical.failOpen,
      legacy.failOpen,
      legacyGlobal.failOpen,
    ),
  };
}

function configInputFromUserConfig(value: unknown): ConfigInput {
  const config = asObject(value);
  const runtime = asObject(config.runtime);
  const search = asObject(config.search);
  const hostedFallback = asObject(search.hostedFallback);
  const cache = asObject(config.cache);
  const providerControl = asObject(config.providerControl);
  const canonicalHostedProviders = asObject(
    getObjectPath(config, ["hostedSearch", "providers"]),
  );
  const legacyProviders = asObject(config.providers);
  const legacyGlobalBudget = asObject(config.budget);
  const canonicalFirecrawl = asObject(
    getObjectPath(config, ["remoteFetch", "firecrawl"]),
  );
  const legacyFirecrawl = asObject(
    getObjectPath(config, ["providers", "firecrawl"]),
  );

  const hostedProviders = Object.fromEntries(
    HOSTED_SEARCH_PROVIDER_IDS.map((provider) => {
      const canonical = asObject(canonicalHostedProviders[provider]);
      const legacy = asObject(legacyProviders[provider]);
      const canonicalControl = asObject(canonical.control);
      const legacyControl = asObject(legacy.control);
      const canonicalBudget = asObject(canonical.budget);
      const legacyBudget = asObject(legacy.budget);

      return [
        provider,
        {
          control: Object.fromEntries(
            Object.entries(controlFromUserConfig(canonicalControl)).map(
              ([key, canonicalValue]) => [
                key,
                firstDefined(
                  canonicalValue,
                  controlFromUserConfig(legacyControl)[
                    key as keyof ReturnType<typeof controlFromUserConfig>
                  ],
                ),
              ],
            ),
          ),
          budget: mergeBudgetInputs(
            canonicalBudget,
            legacyBudget,
            legacyGlobalBudget,
          ),
        },
      ];
    }),
  ) as HostedProviderInputs;

  return {
    localSearch: {
      endpoint: firstDefined(
        stringFromValue(getObjectPath(config, ["localSearch", "endpoint"])),
        stringFromValue(getObjectPath(config, ["search", "searxngUrl"])),
      ),
    },
    runtime: {
      mode: runtimeMode(runtime.mode),
    },
    routing: {
      mode: firstDefined(
        routingMode(getObjectPath(config, ["routing", "mode"])),
        routingMode(getObjectPath(config, ["search", "routingMode"])),
      ),
    },
    search: {
      hostedFallback: {
        enabled: firstDefined(
          hostedFallbackEnabledFromValue(hostedFallback.enabled),
          hostedFallbackEnabledFromValue(search.hostedFallbackEnabled),
        ),
        withEngineFilter: firstDefined(
          parseRuntimeConfigBoolean(hostedFallback.withEngineFilter),
          parseRuntimeConfigBoolean(search.fallbackWithEngineFilter),
        ),
        providerOrder: firstDefined(
          hostedProviderOrderFromValue(hostedFallback.providerOrder),
          hostedProviderOrderFromValue(search.providerOrder),
        ),
        minimumResults: firstDefined(
          numberFromValue(hostedFallback.minimumResults),
          numberFromValue(search.fallbackMinResults),
        ),
      },
    },
    cache: {
      url: stringFromValue(cache.url),
      commandTimeoutMs: numberFromValue(cache.commandTimeoutMs),
      connectTimeoutMs: numberFromValue(cache.connectTimeoutMs),
      maxRetriesPerRequest: numberFromValue(cache.maxRetriesPerRequest),
    },
    providerControl: {
      searxng: controlFromUserConfig(providerControl.searxng),
      cloudflare: {
        ...controlFromUserConfig(providerControl.cloudflare),
        quickActionRps: numberFromValue(
          asObject(providerControl.cloudflare).quickActionRps,
        ),
        quickActionBurst: numberFromValue(
          asObject(providerControl.cloudflare).quickActionBurst,
        ),
        rateMaxWaiters: numberFromValue(
          asObject(providerControl.cloudflare).rateMaxWaiters,
        ),
        rateMaxWaitMs: numberFromValue(
          asObject(providerControl.cloudflare).rateMaxWaitMs,
        ),
      },
      crawl4ai: controlFromUserConfig(providerControl.crawl4ai),
    },
    hostedSearch: {
      providers: hostedProviders,
    },
    remoteFetch: {
      firecrawl: {
        enabled: firstDefined(
          parseRuntimeConfigBoolean(canonicalFirecrawl.enabled),
          parseRuntimeConfigBoolean(legacyFirecrawl.enabled),
        ),
        url: firstDefined(
          stringFromValue(canonicalFirecrawl.url),
          stringFromValue(legacyFirecrawl.url),
        ),
        apiKey: firstDefined(
          stringFromValue(canonicalFirecrawl.apiKey),
          stringFromValue(legacyFirecrawl.apiKey),
        ),
      },
    },
  };
}

function selectedProfile(
  options: ControlPlaneConfigOptions,
  environment: CompatibilityEnvironment,
  userConfig: unknown,
): { name: ConfigProfileName | undefined; source: ConfigSource } {
  const userProfile = stringFromValue(
    getObjectPath(asObject(userConfig), ["profile"]),
  );
  const candidates: Array<[unknown, ConfigSource]> = [
    [options.profile, "operation"],
    [environmentString(environment, ["ULTRASEARCH_PROFILE"]), "environment"],
    [userProfile, "user_config"],
  ];

  for (const [candidate, source] of candidates) {
    if (isConfigProfileName(candidate)) return { name: candidate, source };
  }
  return { name: undefined, source: "default" };
}

/**
 * Resolves the typed configuration contract from compatibility inputs. This is
 * the only Phase-002 path that applies precedence; callers consume its result.
 */
export function resolveControlPlaneConfig(
  options: ControlPlaneConfigOptions = {},
): ResolvedControlPlaneConfig {
  const environment = options.environment ?? process.env;
  const userConfig = options.userConfig ?? runtimeConfigSnapshot();
  const profile = selectedProfile(options, environment, userConfig);
  const effective = resolveEffectiveConfig({
    operation: options.operation,
    environment: configInputFromEnvironment(environment),
    userConfig: configInputFromUserConfig(userConfig),
    profile: profile.name,
  });

  return {
    ...effective,
    profile: {
      name: profile.name ?? null,
      source: profile.source,
    },
  };
}

export function getControlPlaneConfig(): ResolvedControlPlaneConfig {
  return resolveControlPlaneConfig();
}
