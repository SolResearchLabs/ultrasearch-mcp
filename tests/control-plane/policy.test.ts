import { describe, expect, it } from "vitest";
import type { RoutingMode } from "../../src/config/schema.js";
import { resolveControlPlaneConfig } from "../../src/control-plane/config.js";
import { resolveRoutingPolicy } from "../../src/control-plane/policy.js";

const cases: Array<{
  mode: RoutingMode;
  localSearch: boolean;
  hostedSearch: boolean;
  hostedInvocation:
    | "never"
    | "after_local_hard_failure_or_zero_usable_results"
    | "sequential_supplement_or_fallback"
    | "primary";
  offlineOnly: boolean;
}> = [
  {
    mode: "local_only",
    localSearch: true,
    hostedSearch: false,
    hostedInvocation: "never",
    offlineOnly: false,
  },
  {
    mode: "local_first",
    localSearch: true,
    hostedSearch: true,
    hostedInvocation: "after_local_hard_failure_or_zero_usable_results",
    offlineOnly: false,
  },
  {
    mode: "hybrid",
    localSearch: true,
    hostedSearch: true,
    hostedInvocation: "sequential_supplement_or_fallback",
    offlineOnly: false,
  },
  {
    mode: "hosted_only",
    localSearch: false,
    hostedSearch: true,
    hostedInvocation: "primary",
    offlineOnly: false,
  },
  {
    mode: "offline_fetch_only",
    localSearch: false,
    hostedSearch: false,
    hostedInvocation: "never",
    offlineOnly: true,
  },
];

describe("Control Plane routing policy", () => {
  it.each(
    cases,
  )("resolves $mode without handing route interpretation to clients", ({
    mode,
    localSearch,
    hostedSearch,
    hostedInvocation,
    offlineOnly,
  }) => {
    const config = resolveControlPlaneConfig({
      operation: { routing: { mode } },
    });

    expect(resolveRoutingPolicy(config)).toMatchObject({
      mode,
      localSearch: { enabled: localSearch },
      hostedSearch: { enabled: hostedSearch, invocation: hostedInvocation },
      offlineFetch: {
        enabled: offlineOnly,
        liveNetworkAllowed: false,
      },
    });
  });

  it("hands the canonical engine-filter setting to Core without changing mode restrictions", () => {
    const config = resolveControlPlaneConfig({
      operation: {
        routing: { mode: "hybrid" },
        search: {
          hostedFallback: {
            withEngineFilter: true,
          },
        },
      },
    });

    expect(resolveRoutingPolicy(config)).toMatchObject({
      mode: "hybrid",
      hostedSearch: {
        enabled: true,
        invocation: "sequential_supplement_or_fallback",
        withEngineFilter: true,
      },
    });

    const localOnlyConfig = resolveControlPlaneConfig({
      operation: {
        routing: { mode: "local_only" },
        search: {
          hostedFallback: {
            withEngineFilter: true,
          },
        },
      },
    });

    expect(resolveRoutingPolicy(localOnlyConfig).hostedSearch).toMatchObject({
      enabled: false,
      invocation: "never",
      withEngineFilter: true,
    });
  });
});
