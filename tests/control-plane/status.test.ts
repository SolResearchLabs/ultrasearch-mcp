import { describe, expect, it, vi } from "vitest";
import { resolveControlPlaneConfig } from "../../src/control-plane/config.js";
import {
  type ControlPlaneStatusDependencies,
  getControlPlaneStatus,
  probeLocalSearchEndpoint,
} from "../../src/control-plane/status.js";

function dependencies(): ControlPlaneStatusDependencies {
  return {
    observeRuntime: vi.fn().mockResolvedValue({
      runtime: {
        mode: "external_endpoint",
        ownership: "external",
        observation: "reachable",
        lifecycle: "unavailable",
        observedAt: "2026-09-11T00:00:00.000Z",
        endpoint: "http://127.0.0.1:8099",
        diagnostic: null,
      },
      localSearch: {
        state: "reachable",
        endpoint: "http://127.0.0.1:8099",
        statusCode: 200,
      },
    }),
    probeCache: vi.fn().mockResolvedValue({ state: "reachable" }),
    providerControlSnapshot: vi.fn().mockReturnValue({
      searxng: { active: 0 },
    }),
    hostedSearchControlSnapshot: vi.fn().mockReturnValue({
      exa: { active: 0 },
    }),
    hostedSearchBudgetSnapshot: vi.fn().mockResolvedValue({
      exa: { state: "disabled", allowed: true },
    }),
    configuredHostedSearchProviders: vi.fn().mockReturnValue(["exa"]),
  };
}

describe("Control Plane status", () => {
  it("assembles one redacted non-mutating status result from bounded probes and snapshots", async () => {
    const config = resolveControlPlaneConfig({
      userConfig: {
        providers: {
          firecrawl: {
            enabled: true,
            url: "https://firecrawl.example.test",
            apiKey: "status-secret",
          },
        },
      },
    });
    const deps = dependencies();

    const status = await getControlPlaneStatus({ config, dependencies: deps });

    expect(status).toMatchObject({
      schemaVersion: 1,
      configuration: {
        values: {
          remoteFetch: { firecrawl: { apiKey: "[redacted]" } },
        },
      },
      localSearch: {
        state: "reachable",
        endpoint: "http://127.0.0.1:8099",
      },
      runtime: {
        mode: "external_endpoint",
        ownership: "external",
        observation: "reachable",
        lifecycle: "unavailable",
        observedAt: "2026-09-11T00:00:00.000Z",
        endpoint: "http://127.0.0.1:8099",
        diagnostic: null,
      },
      cache: { state: "reachable" },
      providers: {
        configuredHostedSearch: ["exa"],
        remoteFetch: {
          firecrawl: {
            classification: "explicit_remote_fetch_crawl_escalation",
            enabled: true,
            configured: true,
            apiKeyConfigured: true,
          },
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("status-secret");
    expect(deps.observeRuntime).toHaveBeenCalledOnce();
    expect(deps.probeCache).toHaveBeenCalledOnce();
    expect(deps.hostedSearchBudgetSnapshot).toHaveBeenCalledOnce();
    expect(config.values.remoteFetch.firecrawl.apiKey).toBe("status-secret");
  });

  it("derives local search and runtime from one injected observation", async () => {
    const config = resolveControlPlaneConfig({
      operation: {
        runtime: { mode: "operator_compose" },
        localSearch: { endpoint: "http://localhost:8099/operator" },
      },
    });
    const deps = dependencies();
    const clock = vi.fn(() => new Date("2026-09-11T01:02:03.000Z"));

    const status = await getControlPlaneStatus({
      config,
      dependencies: deps,
      clock,
    });

    expect(deps.observeRuntime).toHaveBeenCalledOnce();
    expect(deps.observeRuntime).toHaveBeenCalledWith({
      mode: "operator_compose",
      endpoint: "http://localhost:8099/operator",
      clock,
    });
    const observation = await (deps.observeRuntime as ReturnType<typeof vi.fn>)
      .mock.results[0].value;
    expect(status.runtime).toBe(observation.runtime);
    expect(status.localSearch).toBe(observation.localSearch);
  });

  it("redacts unsafe endpoints in every external status projection", async () => {
    const endpoint = "https://remote.example.test/private?token=fixture";
    const config = resolveControlPlaneConfig({
      operation: { localSearch: { endpoint } },
    });
    const deps = dependencies();
    (deps.observeRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      runtime: {
        mode: "unavailable",
        ownership: "external",
        observation: "not_probed",
        lifecycle: "unavailable",
        observedAt: "2026-09-11T00:00:00.000Z",
        endpoint: null,
        diagnostic: "endpoint_is_not_loopback",
      },
      localSearch: {
        state: "not_probed",
        endpoint,
        reason: "endpoint_is_not_loopback",
      },
    });

    const status = await getControlPlaneStatus({ config, dependencies: deps });

    expect(status.runtime.endpoint).toBeNull();
    expect(status.localSearch.endpoint).toBe("[redacted]");
    expect(status.configuration.values).toMatchObject({
      localSearch: { endpoint: "[redacted]" },
    });
    expect(config.values.localSearch.endpoint).toBe(endpoint);
    expect(JSON.stringify(status)).not.toContain(endpoint);
  });

  it("keeps the compatibility probe bounded to one healthz request", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));

    const status = await probeLocalSearchEndpoint(
      "http://127.0.0.1:8099/",
      fetcher,
    );

    expect(status).toMatchObject({
      state: "reachable",
      endpoint: "http://127.0.0.1:8099",
      statusCode: 204,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8099/healthz",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
