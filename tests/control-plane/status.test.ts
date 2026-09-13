import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveControlPlaneConfig } from "../../src/control-plane/config.js";
import type { ManagedRuntimeStatus } from "../../src/control-plane/runtime-lifecycle.js";
import {
  type ControlPlaneStatusDependencies,
  getControlPlaneStatus,
  probeLocalSearchEndpoint,
} from "../../src/control-plane/status.js";

// The status fixture resolves its config without an explicit `environment`
// layer, so the resolver falls back to `process.env` and an ambient Firecrawl
// value would win over the user-config fixture this suite pins. Capture and
// remove the Firecrawl compatibility names per test; restore them afterwards
// (FP-006 posture-independence pattern).
const AMBIENT_FIRECRAWL_ENV_NAMES = [
  "ULTRASEARCH_FIRECRAWL_ENABLED",
  "FIRECRAWL_ENABLED",
  "ULTRASEARCH_FIRECRAWL_URL",
  "FIRECRAWL_URL",
  "ULTRASEARCH_FIRECRAWL_API_KEY",
  "FIRECRAWL_API_KEY",
] as const;

const capturedAmbientFirecrawlEnv = new Map<string, string | undefined>();

beforeEach(() => {
  capturedAmbientFirecrawlEnv.clear();
  for (const name of AMBIENT_FIRECRAWL_ENV_NAMES) {
    capturedAmbientFirecrawlEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of AMBIENT_FIRECRAWL_ENV_NAMES) {
    const value = capturedAmbientFirecrawlEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  capturedAmbientFirecrawlEnv.clear();
});

function managedRuntimeStatus(): ManagedRuntimeStatus {
  return {
    state: "running",
    endpoint: "http://127.0.0.1:18099",
    port: 18_099,
    pid: 51_234,
    generation: 1,
    ownership: "ultrasearch_managed",
    verification: {
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: "c".repeat(64),
      patchSha256: "d".repeat(64),
      patchedFileSha256: "e".repeat(64),
      interpreterPath: "C:\\UltraSearch\\runtime\\.venv\\Scripts\\python.exe",
    },
    lastReadiness: {
      status: 200,
      at: "2026-09-12T00:00:00.000Z",
      elapsedMs: 25,
    },
    lastStop: null,
    lastCrash: null,
    lastRefusal: null,
    observedAt: "2026-09-12T00:00:00.000Z",
    stateFile: "C:\\UltraSearch\\runtime\\state\\managed-runtime.json",
  };
}

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
    readManagedRuntime: vi.fn().mockResolvedValue(managedRuntimeStatus()),
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

  it("adds the managed runtime projection without changing existing fields", async () => {
    const config = resolveControlPlaneConfig({});
    const deps = dependencies();

    const status = await getControlPlaneStatus({ config, dependencies: deps });

    expect(status.managedRuntime).toEqual(managedRuntimeStatus());
    expect(deps.readManagedRuntime).toHaveBeenCalledOnce();
    expect(status.runtime.lifecycle).toBe("unavailable");
    expect(status.localSearch.state).toBe("reachable");
    expect(status.cache.state).toBe("reachable");
  });

  it("reports an unavailable managed runtime projection when the reader fails", async () => {
    const config = resolveControlPlaneConfig({});
    const deps = dependencies();
    (deps.readManagedRuntime as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("state_corrupt: fixture"),
    );

    const status = await getControlPlaneStatus({ config, dependencies: deps });

    expect(status.managedRuntime).toBeNull();
    expect(status.runtime.mode).toBe("external_endpoint");
  });
});
