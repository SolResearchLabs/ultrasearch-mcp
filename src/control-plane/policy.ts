import type { RoutingMode } from "../config/schema.js";
import type { ResolvedControlPlaneConfig } from "./config.js";

export type HostedSearchInvocation =
  | "never"
  | "after_local_hard_failure_or_zero_usable_results"
  | "sequential_supplement_or_fallback"
  | "primary";

export interface ResolvedRoutingPolicy {
  mode: RoutingMode;
  localSearch: {
    enabled: boolean;
  };
  hostedSearch: {
    enabled: boolean;
    invocation: HostedSearchInvocation;
    withEngineFilter: boolean;
  };
  offlineFetch: {
    enabled: boolean;
    liveNetworkAllowed: false;
  };
}

export function resolveRoutingPolicy(
  config: Pick<ResolvedControlPlaneConfig, "values">,
): ResolvedRoutingPolicy {
  switch (config.values.routing.mode) {
    case "local_only":
      return {
        mode: "local_only",
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: false,
          invocation: "never",
          withEngineFilter:
            config.values.search.hostedFallback.withEngineFilter,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "local_first":
      return {
        mode: "local_first",
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: true,
          invocation: "after_local_hard_failure_or_zero_usable_results",
          withEngineFilter:
            config.values.search.hostedFallback.withEngineFilter,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "hybrid":
      return {
        mode: "hybrid",
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: true,
          invocation: "sequential_supplement_or_fallback",
          withEngineFilter:
            config.values.search.hostedFallback.withEngineFilter,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "hosted_only":
      return {
        mode: "hosted_only",
        localSearch: { enabled: false },
        hostedSearch: {
          enabled: true,
          invocation: "primary",
          withEngineFilter:
            config.values.search.hostedFallback.withEngineFilter,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "offline_fetch_only":
      return {
        mode: "offline_fetch_only",
        localSearch: { enabled: false },
        hostedSearch: {
          enabled: false,
          invocation: "never",
          withEngineFilter:
            config.values.search.hostedFallback.withEngineFilter,
        },
        offlineFetch: { enabled: true, liveNetworkAllowed: false },
      };
  }
}
