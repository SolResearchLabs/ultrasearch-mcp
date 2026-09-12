import { cachePing } from "../cache.js";
import { providerControlSnapshot } from "../provider-control.js";
import {
  configuredHostedSearchProviders,
  hostedSearchBudgetSnapshot,
  hostedSearchControlSnapshot,
} from "../search-providers/index.js";
import {
  getControlPlaneConfig,
  type ResolvedControlPlaneConfig,
} from "./config.js";
import { type ResolvedRoutingPolicy, resolveRoutingPolicy } from "./policy.js";
import { redactConfigForDiagnostics } from "./redaction.js";
import {
  type LocalSearchStatus,
  observeRuntime,
  type RuntimeClock,
  type RuntimeFetch,
  type RuntimeObservationOptions,
  type RuntimeObservationResult,
  type RuntimeStatus,
} from "./runtime.js";

export type ProbeState = LocalSearchStatus["state"];
export type LocalEndpointStatus = LocalSearchStatus;

export interface CacheStatus {
  state: "reachable" | "unreachable";
}

export interface ControlPlaneStatusDependencies {
  observeRuntime: (
    options: RuntimeObservationOptions,
  ) => Promise<RuntimeObservationResult>;
  probeCache: () => Promise<CacheStatus>;
  providerControlSnapshot: () => unknown;
  hostedSearchControlSnapshot: () => unknown;
  hostedSearchBudgetSnapshot: () => Promise<unknown>;
  configuredHostedSearchProviders: () => string[];
}

export interface ControlPlaneStatus {
  schemaVersion: 1;
  configuration: {
    values: unknown;
    sources: ResolvedControlPlaneConfig["sources"];
    profile: ResolvedControlPlaneConfig["profile"];
  };
  routing: ResolvedRoutingPolicy;
  localSearch: LocalEndpointStatus;
  runtime: RuntimeStatus;
  cache: CacheStatus;
  providers: {
    configuredHostedSearch: string[];
    control: unknown;
    hostedSearchControl: unknown;
    hostedSearchBudget: unknown;
    remoteFetch: {
      firecrawl: {
        classification: "explicit_remote_fetch_crawl_escalation";
        enabled: boolean;
        configured: boolean;
        apiKeyConfigured: boolean;
      };
    };
  };
}

export async function probeLocalSearchEndpoint(
  endpoint: string,
  fetcher: RuntimeFetch = fetch,
): Promise<LocalEndpointStatus> {
  return (
    await observeRuntime({
      mode: "external_endpoint",
      endpoint,
      fetcher,
    })
  ).localSearch;
}

const defaultDependencies: ControlPlaneStatusDependencies = {
  observeRuntime,
  probeCache: async () => ({
    state: (await cachePing()) ? "reachable" : "unreachable",
  }),
  providerControlSnapshot,
  hostedSearchControlSnapshot,
  hostedSearchBudgetSnapshot,
  configuredHostedSearchProviders,
};

export interface ControlPlaneStatusOptions {
  config?: ResolvedControlPlaneConfig;
  dependencies?: Partial<ControlPlaneStatusDependencies>;
  clock?: RuntimeClock;
}

function diagnosticConfigValues(
  config: ResolvedControlPlaneConfig,
  localSearch: LocalEndpointStatus,
): unknown {
  const values = redactConfigForDiagnostics(config.values);
  if (localSearch.endpoint !== "[redacted]") return values;

  return {
    ...values,
    localSearch: {
      ...values.localSearch,
      endpoint: "[redacted]",
    },
  };
}

function statusLocalSearch(
  config: ResolvedControlPlaneConfig,
  runtime: RuntimeStatus,
  localSearch: LocalEndpointStatus,
): LocalEndpointStatus {
  if (
    config.values.localSearch.endpoint.length === 0 ||
    runtime.endpoint !== null
  ) {
    return localSearch;
  }

  return {
    ...localSearch,
    endpoint: "[redacted]",
  };
}

/**
 * Reads local status without changing configuration, runtime state, provider
 * controls, or hosted-provider accounts. The only network operations are the
 * bounded loopback endpoint and cache probes.
 */
export async function getControlPlaneStatus(
  options: ControlPlaneStatusOptions = {},
): Promise<ControlPlaneStatus> {
  const config = options.config ?? getControlPlaneConfig();
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const firecrawl = config.values.remoteFetch.firecrawl;
  const runtimeOptions: RuntimeObservationOptions = {
    mode: config.values.runtime.mode,
    endpoint: config.values.localSearch.endpoint,
    ...(options.clock ? { clock: options.clock } : {}),
  };
  const [observation, cache, hostedSearchBudget] = await Promise.all([
    dependencies.observeRuntime(runtimeOptions),
    dependencies.probeCache(),
    dependencies.hostedSearchBudgetSnapshot(),
  ]);
  const { runtime } = observation;
  const localSearch = statusLocalSearch(
    config,
    runtime,
    observation.localSearch,
  );

  return {
    schemaVersion: 1,
    configuration: {
      values: diagnosticConfigValues(config, localSearch),
      sources: config.sources,
      profile: config.profile,
    },
    routing: resolveRoutingPolicy(config),
    localSearch,
    runtime,
    cache,
    providers: {
      configuredHostedSearch: dependencies.configuredHostedSearchProviders(),
      control: dependencies.providerControlSnapshot(),
      hostedSearchControl: dependencies.hostedSearchControlSnapshot(),
      hostedSearchBudget,
      remoteFetch: {
        firecrawl: {
          classification: firecrawl.classification,
          enabled: firecrawl.enabled,
          configured:
            firecrawl.enabled &&
            firecrawl.url.length > 0 &&
            firecrawl.apiKey.length > 0,
          apiKeyConfigured: firecrawl.apiKey.length > 0,
        },
      },
    },
  };
}
