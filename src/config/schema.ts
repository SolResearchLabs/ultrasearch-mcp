import { CONFIG_PROFILES, type ConfigProfileName } from "./profiles.js";

export const LOCAL_SEARCH_ENDPOINT = "http://127.0.0.1:8099" as const;

export const ROUTING_MODES = [
  "local_only",
  "local_first",
  "hybrid",
  "hosted_only",
  "offline_fetch_only",
] as const;

export const RUNTIME_MODES = [
  "external_endpoint",
  "operator_compose",
  "unavailable",
] as const;

export const HOSTED_SEARCH_PROVIDER_IDS = [
  "tinyfish",
  "exa",
  "parallel",
  "brave",
] as const;

export const FIRECRAWL_CLASSIFICATION =
  "explicit_remote_fetch_crawl_escalation" as const;

export type RoutingMode = (typeof ROUTING_MODES)[number];
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export type HostedSearchProviderId =
  (typeof HOSTED_SEARCH_PROVIDER_IDS)[number];
export type FirecrawlClassification = typeof FIRECRAWL_CLASSIFICATION;
export type ConfigSource =
  | "operation"
  | "environment"
  | "user_config"
  | "profile"
  | "default";

export interface ProviderControlSettings {
  maxInFlight: number;
  maxQueue: number;
  queueTimeoutMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
  circuitMaxCooldownMs: number;
}

export interface CloudflareProviderControlSettings
  extends ProviderControlSettings {
  quickActionRps: number;
  quickActionBurst: number;
  rateMaxWaiters: number;
  rateMaxWaitMs: number;
}

export interface HostedSearchBudgetSettings {
  monthlyUnits: number | undefined;
  unitsPerRequest: number;
  warnPercent: number;
  failOpen: boolean;
}

export interface HostedSearchProviderSettings {
  control: ProviderControlSettings;
  budget: HostedSearchBudgetSettings;
}

export interface UltraSearchConfig {
  localSearch: {
    endpoint: string;
  };
  runtime: {
    mode: RuntimeMode;
  };
  routing: {
    mode: RoutingMode;
  };
  search: {
    hostedFallback: {
      enabled: boolean | "auto";
      withEngineFilter: boolean;
      providerOrder: HostedSearchProviderId[];
      minimumResults: number;
    };
  };
  cache: {
    url: string;
    commandTimeoutMs: number;
    connectTimeoutMs: number;
    maxRetriesPerRequest: number;
  };
  providerControl: {
    searxng: ProviderControlSettings;
    cloudflare: CloudflareProviderControlSettings;
    crawl4ai: ProviderControlSettings;
  };
  hostedSearch: {
    providers: Record<HostedSearchProviderId, HostedSearchProviderSettings>;
  };
  remoteFetch: {
    firecrawl: {
      classification: FirecrawlClassification;
      enabled: boolean;
      url: string;
      apiKey: string;
    };
  };
}

export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? Item[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

export type ConfigInput = DeepPartial<UltraSearchConfig>;

export interface ConfigLayers {
  operation?: ConfigInput;
  environment?: ConfigInput;
  userConfig?: ConfigInput;
  profile?: ConfigProfileName;
}

export interface ProviderControlSources {
  maxInFlight: ConfigSource;
  maxQueue: ConfigSource;
  queueTimeoutMs: ConfigSource;
  circuitFailureThreshold: ConfigSource;
  circuitCooldownMs: ConfigSource;
  circuitMaxCooldownMs: ConfigSource;
}

export interface CloudflareProviderControlSources
  extends ProviderControlSources {
  quickActionRps: ConfigSource;
  quickActionBurst: ConfigSource;
  rateMaxWaiters: ConfigSource;
  rateMaxWaitMs: ConfigSource;
}

export interface HostedSearchBudgetSources {
  monthlyUnits: ConfigSource;
  unitsPerRequest: ConfigSource;
  warnPercent: ConfigSource;
  failOpen: ConfigSource;
}

export interface EffectiveConfigSources {
  localSearchEndpoint: ConfigSource;
  runtimeMode: ConfigSource;
  routingMode: ConfigSource;
  hostedFallbackEnabled: ConfigSource;
  hostedFallbackWithEngineFilter: ConfigSource;
  hostedProviderOrder: ConfigSource;
  hostedFallbackMinimumResults: ConfigSource;
  cacheUrl: ConfigSource;
  cacheCommandTimeoutMs: ConfigSource;
  cacheConnectTimeoutMs: ConfigSource;
  cacheMaxRetriesPerRequest: ConfigSource;
  firecrawlEnabled: ConfigSource;
  firecrawlUrl: ConfigSource;
  firecrawlApiKey: ConfigSource;
  providerControl: {
    searxng: ProviderControlSources;
    cloudflare: CloudflareProviderControlSources;
    crawl4ai: ProviderControlSources;
  };
  hostedSearch: {
    providers: Record<
      HostedSearchProviderId,
      {
        control: ProviderControlSources;
        budget: HostedSearchBudgetSources;
      }
    >;
  };
}

export interface EffectiveConfig {
  values: UltraSearchConfig;
  sources: EffectiveConfigSources;
}

const DEFAULT_PROVIDER_CONTROL: ProviderControlSettings = {
  maxInFlight: 2,
  maxQueue: 8,
  queueTimeoutMs: 5_000,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 30_000,
  circuitMaxCooldownMs: 300_000,
};

const DEFAULT_HOSTED_SEARCH_PROVIDER: HostedSearchProviderSettings = {
  control: DEFAULT_PROVIDER_CONTROL,
  budget: {
    monthlyUnits: undefined,
    unitsPerRequest: 1,
    warnPercent: 80,
    failOpen: false,
  },
};

export const DEFAULT_CONFIG: UltraSearchConfig = {
  localSearch: {
    endpoint: LOCAL_SEARCH_ENDPOINT,
  },
  runtime: {
    mode: "external_endpoint",
  },
  routing: {
    mode: "local_first",
  },
  search: {
    hostedFallback: {
      enabled: "auto",
      withEngineFilter: false,
      providerOrder: [...HOSTED_SEARCH_PROVIDER_IDS],
      minimumResults: 1,
    },
  },
  cache: {
    url: "redis://localhost:6381",
    commandTimeoutMs: 2_500,
    connectTimeoutMs: 3_000,
    maxRetriesPerRequest: 2,
  },
  providerControl: {
    searxng: {
      maxInFlight: 6,
      maxQueue: 24,
      queueTimeoutMs: 5_000,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 30_000,
      circuitMaxCooldownMs: 300_000,
    },
    cloudflare: {
      maxInFlight: 12,
      maxQueue: 24,
      queueTimeoutMs: 5_000,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 30_000,
      circuitMaxCooldownMs: 300_000,
      quickActionRps: 0.1,
      quickActionBurst: 1,
      rateMaxWaiters: 24,
      rateMaxWaitMs: 30_000,
    },
    crawl4ai: {
      maxInFlight: 1,
      maxQueue: 8,
      queueTimeoutMs: 5_000,
      circuitFailureThreshold: 3,
      circuitCooldownMs: 30_000,
      circuitMaxCooldownMs: 300_000,
    },
  },
  hostedSearch: {
    providers: {
      tinyfish: DEFAULT_HOSTED_SEARCH_PROVIDER,
      exa: DEFAULT_HOSTED_SEARCH_PROVIDER,
      parallel: DEFAULT_HOSTED_SEARCH_PROVIDER,
      brave: DEFAULT_HOSTED_SEARCH_PROVIDER,
    },
  },
  remoteFetch: {
    firecrawl: {
      classification: FIRECRAWL_CLASSIFICATION,
      enabled: false,
      url: "",
      apiKey: "",
    },
  },
};

export interface ConfigSchemaField {
  readonly kind: "field";
  readonly sensitive?: boolean;
}

export interface ConfigSchemaGroup {
  readonly [key: string]: ConfigSchemaNode;
}

export type ConfigSchemaNode = ConfigSchemaField | ConfigSchemaGroup;

const FIELD = { kind: "field" } as const;
const CONTROL_SCHEMA = {
  maxInFlight: FIELD,
  maxQueue: FIELD,
  queueTimeoutMs: FIELD,
  circuitFailureThreshold: FIELD,
  circuitCooldownMs: FIELD,
  circuitMaxCooldownMs: FIELD,
} as const satisfies ConfigSchemaGroup;
const HOSTED_PROVIDER_SCHEMA = {
  control: CONTROL_SCHEMA,
  budget: {
    monthlyUnits: FIELD,
    unitsPerRequest: FIELD,
    warnPercent: FIELD,
    failOpen: FIELD,
  },
} as const satisfies ConfigSchemaGroup;

/**
 * Metadata for values that can appear in diagnostics. The resolver remains
 * strongly typed by UltraSearchConfig; this companion tree lets diagnostics
 * recursively redact newly classified sensitive fields without hard-coding
 * field paths in every client.
 */
export const CONFIG_SCHEMA = {
  localSearch: {
    endpoint: FIELD,
  },
  runtime: {
    mode: FIELD,
  },
  routing: {
    mode: FIELD,
  },
  search: {
    hostedFallback: {
      enabled: FIELD,
      withEngineFilter: FIELD,
      providerOrder: FIELD,
      minimumResults: FIELD,
    },
  },
  cache: {
    url: FIELD,
    commandTimeoutMs: FIELD,
    connectTimeoutMs: FIELD,
    maxRetriesPerRequest: FIELD,
  },
  providerControl: {
    searxng: CONTROL_SCHEMA,
    cloudflare: {
      ...CONTROL_SCHEMA,
      quickActionRps: FIELD,
      quickActionBurst: FIELD,
      rateMaxWaiters: FIELD,
      rateMaxWaitMs: FIELD,
    },
    crawl4ai: CONTROL_SCHEMA,
  },
  hostedSearch: {
    providers: {
      tinyfish: HOSTED_PROVIDER_SCHEMA,
      exa: HOSTED_PROVIDER_SCHEMA,
      parallel: HOSTED_PROVIDER_SCHEMA,
      brave: HOSTED_PROVIDER_SCHEMA,
    },
  },
  remoteFetch: {
    firecrawl: {
      classification: FIELD,
      enabled: FIELD,
      url: FIELD,
      apiKey: { kind: "field", sensitive: true },
    },
  },
} as const satisfies ConfigSchemaGroup;

export function isConfigSchemaField(
  node: ConfigSchemaNode,
): node is ConfigSchemaField {
  return (
    typeof node === "object" &&
    node !== null &&
    "kind" in node &&
    node.kind === "field"
  );
}

export function isRoutingMode(value: unknown): value is RoutingMode {
  return (
    typeof value === "string" && ROUTING_MODES.includes(value as RoutingMode)
  );
}

export function isRuntimeMode(value: unknown): value is RuntimeMode {
  return (
    typeof value === "string" && RUNTIME_MODES.includes(value as RuntimeMode)
  );
}

export function isHostedSearchProviderId(
  value: unknown,
): value is HostedSearchProviderId {
  return (
    typeof value === "string" &&
    HOSTED_SEARCH_PROVIDER_IDS.includes(value as HostedSearchProviderId)
  );
}

type LayerEntry = readonly [ConfigInput | undefined, ConfigSource];

function profileInput(profileName: ConfigProfileName | undefined): ConfigInput {
  if (!profileName) return {};
  return {
    routing: {
      mode: CONFIG_PROFILES[profileName].routingMode,
    },
  };
}

function getInputPath(input: ConfigInput | undefined, path: string[]): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveValue<T>(
  layers: LayerEntry[],
  path: string[],
  fallback: T,
  parse: (value: unknown) => T | undefined,
): [T, ConfigSource] {
  for (const [input, source] of layers) {
    const value = parse(getInputPath(input, path));
    if (value !== undefined) return [value, source];
  }
  return [fallback, "default"];
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseRoutingMode(value: unknown): RoutingMode | undefined {
  return isRoutingMode(value) ? value : undefined;
}

function parseRuntimeMode(value: unknown): RuntimeMode | undefined {
  return isRuntimeMode(value) ? value : undefined;
}

function parseHostedFallbackEnabled(
  value: unknown,
): boolean | "auto" | undefined {
  return value === "auto" || typeof value === "boolean" ? value : undefined;
}

function parseProviderOrder(
  value: unknown,
): HostedSearchProviderId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<HostedSearchProviderId>();
  const order: HostedSearchProviderId[] = [];
  for (const candidate of value) {
    if (!isHostedSearchProviderId(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    order.push(candidate);
  }
  return order.length > 0 ? order : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parsePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function parsePercent(value: unknown): number | undefined {
  const parsed = parsePositiveNumber(value);
  return parsed === undefined ? undefined : Math.min(99.9, Math.max(1, parsed));
}

function resolveProviderControl(
  layers: LayerEntry[],
  path: string[],
  defaults: ProviderControlSettings,
): {
  value: ProviderControlSettings;
  sources: ProviderControlSources;
} {
  const [maxInFlight, maxInFlightSource] = resolveValue(
    layers,
    [...path, "maxInFlight"],
    defaults.maxInFlight,
    parsePositiveInteger,
  );
  const [maxQueue, maxQueueSource] = resolveValue(
    layers,
    [...path, "maxQueue"],
    defaults.maxQueue,
    parseNonNegativeInteger,
  );
  const [queueTimeoutMs, queueTimeoutMsSource] = resolveValue(
    layers,
    [...path, "queueTimeoutMs"],
    defaults.queueTimeoutMs,
    parsePositiveInteger,
  );
  const [circuitFailureThreshold, circuitFailureThresholdSource] = resolveValue(
    layers,
    [...path, "circuitFailureThreshold"],
    defaults.circuitFailureThreshold,
    parsePositiveInteger,
  );
  const [circuitCooldownMs, circuitCooldownMsSource] = resolveValue(
    layers,
    [...path, "circuitCooldownMs"],
    defaults.circuitCooldownMs,
    parsePositiveInteger,
  );
  const [circuitMaxCooldownMs, circuitMaxCooldownMsSource] = resolveValue(
    layers,
    [...path, "circuitMaxCooldownMs"],
    defaults.circuitMaxCooldownMs,
    parsePositiveInteger,
  );

  return {
    value: {
      maxInFlight,
      maxQueue,
      queueTimeoutMs,
      circuitFailureThreshold,
      circuitCooldownMs,
      circuitMaxCooldownMs,
    },
    sources: {
      maxInFlight: maxInFlightSource,
      maxQueue: maxQueueSource,
      queueTimeoutMs: queueTimeoutMsSource,
      circuitFailureThreshold: circuitFailureThresholdSource,
      circuitCooldownMs: circuitCooldownMsSource,
      circuitMaxCooldownMs: circuitMaxCooldownMsSource,
    },
  };
}

function resolveCloudflareProviderControl(
  layers: LayerEntry[],
  defaults: CloudflareProviderControlSettings,
): {
  value: CloudflareProviderControlSettings;
  sources: CloudflareProviderControlSources;
} {
  const control = resolveProviderControl(
    layers,
    ["providerControl", "cloudflare"],
    defaults,
  );
  const [quickActionRps, quickActionRpsSource] = resolveValue(
    layers,
    ["providerControl", "cloudflare", "quickActionRps"],
    defaults.quickActionRps,
    parsePositiveNumber,
  );
  const [quickActionBurst, quickActionBurstSource] = resolveValue(
    layers,
    ["providerControl", "cloudflare", "quickActionBurst"],
    defaults.quickActionBurst,
    parsePositiveInteger,
  );
  const [rateMaxWaiters, rateMaxWaitersSource] = resolveValue(
    layers,
    ["providerControl", "cloudflare", "rateMaxWaiters"],
    defaults.rateMaxWaiters,
    parseNonNegativeInteger,
  );
  const [rateMaxWaitMs, rateMaxWaitMsSource] = resolveValue(
    layers,
    ["providerControl", "cloudflare", "rateMaxWaitMs"],
    defaults.rateMaxWaitMs,
    parsePositiveInteger,
  );

  return {
    value: {
      ...control.value,
      quickActionRps,
      quickActionBurst,
      rateMaxWaiters,
      rateMaxWaitMs,
    },
    sources: {
      ...control.sources,
      quickActionRps: quickActionRpsSource,
      quickActionBurst: quickActionBurstSource,
      rateMaxWaiters: rateMaxWaitersSource,
      rateMaxWaitMs: rateMaxWaitMsSource,
    },
  };
}

function resolveHostedSearchProvider(
  layers: LayerEntry[],
  provider: HostedSearchProviderId,
  defaults: HostedSearchProviderSettings,
): {
  value: HostedSearchProviderSettings;
  sources: {
    control: ProviderControlSources;
    budget: HostedSearchBudgetSources;
  };
} {
  const control = resolveProviderControl(
    layers,
    ["hostedSearch", "providers", provider, "control"],
    defaults.control,
  );
  const [monthlyUnits, monthlyUnitsSource] = resolveValue<number | undefined>(
    layers,
    ["hostedSearch", "providers", provider, "budget", "monthlyUnits"],
    defaults.budget.monthlyUnits,
    parsePositiveNumber,
  );
  const [unitsPerRequest, unitsPerRequestSource] = resolveValue(
    layers,
    ["hostedSearch", "providers", provider, "budget", "unitsPerRequest"],
    defaults.budget.unitsPerRequest,
    parsePositiveNumber,
  );
  const [warnPercent, warnPercentSource] = resolveValue(
    layers,
    ["hostedSearch", "providers", provider, "budget", "warnPercent"],
    defaults.budget.warnPercent,
    parsePercent,
  );
  const [failOpen, failOpenSource] = resolveValue(
    layers,
    ["hostedSearch", "providers", provider, "budget", "failOpen"],
    defaults.budget.failOpen,
    parseBoolean,
  );

  return {
    value: {
      control: control.value,
      budget: {
        monthlyUnits,
        unitsPerRequest,
        warnPercent,
        failOpen,
      },
    },
    sources: {
      control: control.sources,
      budget: {
        monthlyUnits: monthlyUnitsSource,
        unitsPerRequest: unitsPerRequestSource,
        warnPercent: warnPercentSource,
        failOpen: failOpenSource,
      },
    },
  };
}

export function resolveEffectiveConfig(
  configLayers: ConfigLayers = {},
): EffectiveConfig {
  const layers: LayerEntry[] = [
    [configLayers.operation, "operation"],
    [configLayers.environment, "environment"],
    [configLayers.userConfig, "user_config"],
    [profileInput(configLayers.profile), "profile"],
  ];

  const [endpoint, localSearchEndpoint] = resolveValue(
    layers,
    ["localSearch", "endpoint"],
    DEFAULT_CONFIG.localSearch.endpoint,
    parseString,
  );
  const [runtimeMode, runtimeModeSource] = resolveValue(
    layers,
    ["runtime", "mode"],
    DEFAULT_CONFIG.runtime.mode,
    parseRuntimeMode,
  );
  const [mode, routingMode] = resolveValue(
    layers,
    ["routing", "mode"],
    DEFAULT_CONFIG.routing.mode,
    parseRoutingMode,
  );
  const [hostedFallbackEnabled, hostedFallbackEnabledSource] = resolveValue(
    layers,
    ["search", "hostedFallback", "enabled"],
    DEFAULT_CONFIG.search.hostedFallback.enabled,
    parseHostedFallbackEnabled,
  );
  const [hostedFallbackWithEngineFilter, hostedFallbackWithEngineFilterSource] =
    resolveValue(
      layers,
      ["search", "hostedFallback", "withEngineFilter"],
      DEFAULT_CONFIG.search.hostedFallback.withEngineFilter,
      parseBoolean,
    );
  const [hostedProviderOrder, hostedProviderOrderSource] = resolveValue(
    layers,
    ["search", "hostedFallback", "providerOrder"],
    DEFAULT_CONFIG.search.hostedFallback.providerOrder,
    parseProviderOrder,
  );
  const [hostedFallbackMinimumResults, hostedFallbackMinimumResultsSource] =
    resolveValue(
      layers,
      ["search", "hostedFallback", "minimumResults"],
      DEFAULT_CONFIG.search.hostedFallback.minimumResults,
      parseNonNegativeInteger,
    );
  const [cacheUrl, cacheUrlSource] = resolveValue(
    layers,
    ["cache", "url"],
    DEFAULT_CONFIG.cache.url,
    parseString,
  );
  const [cacheCommandTimeoutMs, cacheCommandTimeoutMsSource] = resolveValue(
    layers,
    ["cache", "commandTimeoutMs"],
    DEFAULT_CONFIG.cache.commandTimeoutMs,
    parsePositiveInteger,
  );
  const [cacheConnectTimeoutMs, cacheConnectTimeoutMsSource] = resolveValue(
    layers,
    ["cache", "connectTimeoutMs"],
    DEFAULT_CONFIG.cache.connectTimeoutMs,
    parsePositiveInteger,
  );
  const [cacheMaxRetriesPerRequest, cacheMaxRetriesPerRequestSource] =
    resolveValue(
      layers,
      ["cache", "maxRetriesPerRequest"],
      DEFAULT_CONFIG.cache.maxRetriesPerRequest,
      parsePositiveInteger,
    );
  const [firecrawlEnabled, firecrawlEnabledSource] = resolveValue(
    layers,
    ["remoteFetch", "firecrawl", "enabled"],
    DEFAULT_CONFIG.remoteFetch.firecrawl.enabled,
    parseBoolean,
  );
  const [firecrawlUrl, firecrawlUrlSource] = resolveValue(
    layers,
    ["remoteFetch", "firecrawl", "url"],
    DEFAULT_CONFIG.remoteFetch.firecrawl.url,
    parseString,
  );
  const [firecrawlApiKey, firecrawlApiKeySource] = resolveValue(
    layers,
    ["remoteFetch", "firecrawl", "apiKey"],
    DEFAULT_CONFIG.remoteFetch.firecrawl.apiKey,
    parseString,
  );
  const searxngControl = resolveProviderControl(
    layers,
    ["providerControl", "searxng"],
    DEFAULT_CONFIG.providerControl.searxng,
  );
  const cloudflareControl = resolveCloudflareProviderControl(
    layers,
    DEFAULT_CONFIG.providerControl.cloudflare,
  );
  const crawl4aiControl = resolveProviderControl(
    layers,
    ["providerControl", "crawl4ai"],
    DEFAULT_CONFIG.providerControl.crawl4ai,
  );
  const hostedProviders = Object.fromEntries(
    HOSTED_SEARCH_PROVIDER_IDS.map((provider) => [
      provider,
      resolveHostedSearchProvider(
        layers,
        provider,
        DEFAULT_CONFIG.hostedSearch.providers[provider],
      ),
    ]),
  ) as Record<
    HostedSearchProviderId,
    ReturnType<typeof resolveHostedSearchProvider>
  >;

  return {
    values: {
      localSearch: { endpoint },
      runtime: { mode: runtimeMode },
      routing: { mode },
      search: {
        hostedFallback: {
          enabled: hostedFallbackEnabled,
          withEngineFilter: hostedFallbackWithEngineFilter,
          providerOrder: hostedProviderOrder,
          minimumResults: hostedFallbackMinimumResults,
        },
      },
      cache: {
        url: cacheUrl,
        commandTimeoutMs: cacheCommandTimeoutMs,
        connectTimeoutMs: cacheConnectTimeoutMs,
        maxRetriesPerRequest: cacheMaxRetriesPerRequest,
      },
      providerControl: {
        searxng: searxngControl.value,
        cloudflare: cloudflareControl.value,
        crawl4ai: crawl4aiControl.value,
      },
      hostedSearch: {
        providers: Object.fromEntries(
          HOSTED_SEARCH_PROVIDER_IDS.map((provider) => [
            provider,
            hostedProviders[provider].value,
          ]),
        ) as Record<HostedSearchProviderId, HostedSearchProviderSettings>,
      },
      remoteFetch: {
        firecrawl: {
          classification: FIRECRAWL_CLASSIFICATION,
          enabled: firecrawlEnabled,
          url: firecrawlUrl,
          apiKey: firecrawlApiKey,
        },
      },
    },
    sources: {
      localSearchEndpoint,
      runtimeMode: runtimeModeSource,
      routingMode,
      hostedFallbackEnabled: hostedFallbackEnabledSource,
      hostedFallbackWithEngineFilter: hostedFallbackWithEngineFilterSource,
      hostedProviderOrder: hostedProviderOrderSource,
      hostedFallbackMinimumResults: hostedFallbackMinimumResultsSource,
      cacheUrl: cacheUrlSource,
      cacheCommandTimeoutMs: cacheCommandTimeoutMsSource,
      cacheConnectTimeoutMs: cacheConnectTimeoutMsSource,
      cacheMaxRetriesPerRequest: cacheMaxRetriesPerRequestSource,
      firecrawlEnabled: firecrawlEnabledSource,
      firecrawlUrl: firecrawlUrlSource,
      firecrawlApiKey: firecrawlApiKeySource,
      providerControl: {
        searxng: searxngControl.sources,
        cloudflare: cloudflareControl.sources,
        crawl4ai: crawl4aiControl.sources,
      },
      hostedSearch: {
        providers: Object.fromEntries(
          HOSTED_SEARCH_PROVIDER_IDS.map((provider) => [
            provider,
            hostedProviders[provider].sources,
          ]),
        ) as EffectiveConfigSources["hostedSearch"]["providers"],
      },
    },
  };
}
