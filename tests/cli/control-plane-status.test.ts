import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getControlPlaneConfig, getControlPlaneStatus } = vi.hoisted(() => ({
  getControlPlaneConfig: vi.fn(),
  getControlPlaneStatus: vi.fn(),
}));

vi.mock("../../src/control-plane/index.js", () => ({
  getControlPlaneStatus,
  getControlPlaneConfig,
}));

import {
  printDoctor,
  printDoctorStatus,
  printStatus,
  renderControlPlaneStatus,
  runCliCommand,
} from "../../src/cli/configure.js";

const status = {
  schemaVersion: 1 as const,
  configuration: {
    values: {
      localSearch: { endpoint: "http://127.0.0.1:8099" },
      remoteFetch: {
        firecrawl: {
          enabled: true,
          url: "https://firecrawl.example.test",
          apiKey: "[redacted]",
        },
      },
    },
    sources: {
      localSearchEndpoint: "default",
      routingMode: "default",
      firecrawlEnabled: "user_config",
      firecrawlUrl: "user_config",
      firecrawlApiKey: "user_config",
    },
    profile: { name: "local", source: "user_config" },
  },
  routing: {
    mode: "local_first" as const,
    localSearch: { enabled: true },
    hostedSearch: {
      enabled: true,
      invocation: "after_local_hard_failure_or_zero_usable_results" as const,
    },
    offlineFetch: { enabled: false, liveNetworkAllowed: false as const },
  },
  localSearch: {
    state: "reachable" as const,
    endpoint: "http://127.0.0.1:8099",
    statusCode: 200,
  },
  runtime: {
    mode: "external_endpoint" as const,
    ownership: "external" as const,
    observation: "reachable" as const,
    lifecycle: "unavailable" as const,
    observedAt: "2026-09-11T00:00:00.000Z",
    endpoint: "http://127.0.0.1:8099",
    diagnostic: null,
  },
  cache: { state: "reachable" as const },
  providers: {
    configuredHostedSearch: ["exa"],
    control: { searxng: { active: 0 } },
    hostedSearchControl: { exa: { active: 0 } },
    hostedSearchBudget: { exa: { allowed: true, state: "disabled" } },
    remoteFetch: {
      firecrawl: {
        enabled: true,
        configured: true,
        apiKeyConfigured: true,
      },
    },
  },
};

function captureStdout<T>(run: () => Promise<T> | T): Promise<{
  output: string;
  result: T;
}> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  return Promise.resolve(run())
    .then((result) => ({ output: lines.join("\n"), result }))
    .finally(() => {
      console.log = original;
    });
}

describe("Control Plane CLI diagnostics", () => {
  beforeEach(() => {
    getControlPlaneStatus.mockResolvedValue(status);
    getControlPlaneConfig.mockReturnValue({
      values: {
        localSearch: { endpoint: "http://127.0.0.1:8099" },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    getControlPlaneConfig.mockReset();
    getControlPlaneStatus.mockReset();
  });

  it("renders the same redacted JSON status contract for doctor and status", async () => {
    const doctor = await captureStdout(() => printDoctorStatus("json"));
    const commandStatus = await captureStdout(() => printStatus("json"));

    expect(getControlPlaneStatus).toHaveBeenCalledTimes(2);
    expect(JSON.parse(doctor.output)).toEqual(status);
    expect(JSON.parse(commandStatus.output)).toEqual(status);
    expect(doctor.output).toBe(commandStatus.output);
    expect(doctor.output).not.toContain("plaintext-test-value");
  });

  it("renders stable human status output from the same status contract", async () => {
    const doctor = renderControlPlaneStatus(status, "doctor", "human");
    const first = renderControlPlaneStatus(status, "status", "human");
    const second = renderControlPlaneStatus(status, "status", "human");

    expect(first).toBe(second);
    expect(doctor).toContain("UltraSearch MCP doctor");
    expect(first).toContain("UltraSearch MCP status");
    expect(first).toContain("routing.mode=local_first");
    expect(first).toContain("local_search.state=reachable");
    expect(first).toContain("runtime.mode=external_endpoint");
    expect(first).toContain("runtime.ownership=external");
    expect(first).toContain("runtime.observation=reachable");
    expect(first).toContain("runtime.lifecycle=unavailable");
    expect(first).toContain("runtime.observed_at=2026-09-11T00:00:00.000Z");
    expect(first).toContain("runtime.endpoint=http://127.0.0.1:8099");
    expect(first).toContain("runtime.diagnostic=none");
    expect(first).toContain("cache.state=reachable");
    expect(first).toContain("firecrawl.configured=true");
    expect(first).not.toContain("plaintext-test-value");
  });

  it("routes both diagnostic commands through one shared non-mutating status call", async () => {
    const doctor = await captureStdout(() =>
      runCliCommand(["doctor", "--json"]),
    );
    const commandStatus = await captureStdout(() => runCliCommand(["status"]));

    expect(doctor.result).toBe(true);
    expect(commandStatus.result).toBe(true);
    expect(getControlPlaneStatus).toHaveBeenCalledTimes(2);
    expect(JSON.parse(doctor.output)).toEqual(status);
    expect(commandStatus.output).toContain("UltraSearch MCP status");
  });

  it("leaves MCP startup commands for the normal transport path", async () => {
    await expect(runCliCommand([])).resolves.toBe(false);
    await expect(runCliCommand(["not-a-cli-command"])).resolves.toBe(false);
    expect(getControlPlaneStatus).not.toHaveBeenCalled();
  });

  it("redacts an unsafe endpoint from synchronous doctor output", async () => {
    getControlPlaneConfig.mockReturnValue({
      values: {
        localSearch: {
          endpoint: "https://search.example.invalid/private?view=full",
        },
      },
    });

    const { output: doctor } = await captureStdout(() => printDoctor());

    expect(doctor).toContain("searxng_url=[redacted]");
    expect(doctor).not.toContain("search.example.invalid");
  });
});
