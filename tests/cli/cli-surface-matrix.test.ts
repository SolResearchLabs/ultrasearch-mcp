import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H6 CLI surface matrix: exercises the thin `runtime <operation> [--json]`
// command and the doctor/status managed-runtime projection through the mocked
// Control Plane barrel. It pins argument parsing, dispatch (no reimplemented
// lifecycle logic), human/JSON rendering, refusal rendering, usage lines, and
// the CURRENT exit posture: a handled refusal prints and exits 0 because no
// `process.exitCode` is ever assigned. Changing that is a product decision.

const mocks = vi.hoisted(() => {
  class Refusal extends Error {
    readonly code: string;
    readonly detail: string;

    constructor(code: string, detail: string) {
      super(`Managed runtime refused (${code}): ${detail}`);
      this.name = "ManagedRuntimeRefusalError";
      this.code = code;
      this.detail = detail;
    }
  }

  return {
    Refusal,
    cleanup: vi.fn(),
    getControlPlaneConfig: vi.fn(),
    getControlPlaneStatus: vi.fn(),
    pathsForRoot: vi.fn((root: string) => ({
      managedRoot: root,
      checkoutPath: `${root}\\searxng`,
      archivePath: `${root}\\searxng-source.tar`,
      patchPath: `${root}\\artifacts\\valkeydb-windows.patch`,
      interpreterPath: `${root}\\.venv\\Scripts\\python.exe`,
    })),
    provision: vi.fn(),
    readStatus: vi.fn(),
    repair: vi.fn(),
    restart: vi.fn(),
    root: vi.fn(() => "C:\\managed-runtime-root"),
    start: vi.fn(),
    stop: vi.fn(),
  };
});

vi.mock("../../src/control-plane/index.js", () => ({
  ManagedRuntimeRefusalError: mocks.Refusal,
  cleanupManagedRuntime: mocks.cleanup,
  defaultManagedRuntimeRoot: mocks.root,
  getControlPlaneConfig: mocks.getControlPlaneConfig,
  getControlPlaneStatus: mocks.getControlPlaneStatus,
  managedRuntimePathsForRoot: mocks.pathsForRoot,
  provisionManagedRuntime: mocks.provision,
  readManagedRuntimeStatus: mocks.readStatus,
  repairManagedRuntime: mocks.repair,
  restartManagedRuntime: mocks.restart,
  startManagedRuntime: mocks.start,
  stopManagedRuntime: mocks.stop,
}));

import {
  printHelp,
  renderControlPlaneStatus,
  runCliCommand,
} from "../../src/cli/configure.js";
import { RUNTIME_CLI_OPERATIONS } from "../../src/cli/runtime.js";
import { resolveControlPlaneConfig } from "../../src/control-plane/config.js";
import { resolveRoutingPolicy } from "../../src/control-plane/policy.js";
import type { ManagedRuntimeStatus } from "../../src/control-plane/runtime-lifecycle.js";
import type { ControlPlaneStatus } from "../../src/control-plane/status.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(
  repoRoot,
  "tests",
  "__missing-cli-matrix-config__.json",
);

const RUNNING_STATUS: ManagedRuntimeStatus = {
  state: "running",
  endpoint: "http://127.0.0.1:18099",
  port: 18_099,
  pid: 51_234,
  generation: 2,
  ownership: "ultrasearch_managed",
  verification: null,
  lastReadiness: { status: 200, at: "2026-09-12T00:00:00.000Z", elapsedMs: 12 },
  lastStop: null,
  lastCrash: null,
  lastRefusal: null,
  observedAt: "2026-09-12T00:00:00.000Z",
  stateFile: "C:\\managed-runtime-root\\state\\managed-runtime.json",
};

const PROVISIONED_STATUS: ManagedRuntimeStatus = {
  ...RUNNING_STATUS,
  state: "provisioned",
  pid: null,
};

const OPERATION_RESULTS = {
  provision: { outcome: "provisioned" as const, status: PROVISIONED_STATUS },
  start: { outcome: "started" as const, status: RUNNING_STATUS },
  stop: { outcome: "stopped" as const, status: PROVISIONED_STATUS },
  restart: { outcome: "restarted" as const, status: RUNNING_STATUS },
  repair: {
    outcome: "already_provisioned" as const,
    status: PROVISIONED_STATUS,
  },
};

const CLEANUP_RESULT = {
  outcome: "deleted" as const,
  managedRoot: "C:\\managed-runtime-root",
  lastState: "provisioned" as const,
  pathAbsent: true,
  port: 18_099,
  listenersAfter: 0,
  survivorPids: [],
  clearedLockPids: [],
  verifiedAt: "2026-09-12T00:00:00.000Z",
};

const defaultPaths = mocks.pathsForRoot("C:\\managed-runtime-root");

const USAGE_TEXT = [
  "UltraSearch MCP runtime",
  "",
  "Usage:",
  "  ultrasearch-mcp runtime <operation> [--json]",
  "",
  "Operations:",
  "  provision   Verify the staged root and apply the pinned Windows patch",
  "  start       Start the managed local runtime on 127.0.0.1:18099",
  "  stop        Stop the managed runtime after verifying its recorded process",
  "  restart     Verified stop followed by start",
  "  status      Print the read-only managed runtime status",
  "  repair      Re-verify provisioning; re-apply the patch from a pristine checkout",
  "  cleanup     Delete the managed root after verification and proof",
].join("\n");

function statusFixture(
  managedRuntime: ManagedRuntimeStatus | null,
): ControlPlaneStatus {
  // Built from the real resolver so every typed field (values, sources,
  // profile, routing) is production-shaped rather than a hand-rolled subset.
  const resolved = resolveControlPlaneConfig({ userConfig: {} });
  return {
    schemaVersion: 1,
    configuration: {
      values: resolved.values,
      sources: resolved.sources,
      profile: resolved.profile,
    },
    routing: resolveRoutingPolicy(resolved),
    localSearch: {
      state: "reachable",
      endpoint: "http://127.0.0.1:8099",
      statusCode: 200,
    },
    runtime: {
      mode: "external_endpoint",
      ownership: "external",
      observation: "reachable",
      lifecycle: "unavailable",
      observedAt: "2026-09-12T00:00:00.000Z",
      endpoint: "http://127.0.0.1:8099",
      diagnostic: null,
    },
    managedRuntime,
    cache: { state: "reachable" },
    providers: {
      configuredHostedSearch: ["exa"],
      control: { searxng: { active: 0 } },
      hostedSearchControl: { exa: { active: 0 } },
      hostedSearchBudget: { exa: { allowed: true, state: "disabled" } },
      remoteFetch: {
        firecrawl: {
          classification: "explicit_remote_fetch_crawl_escalation",
          enabled: true,
          configured: true,
          apiKeyConfigured: true,
        },
      },
    },
  };
}

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

function refusal(
  code = "port_in_use_foreign",
): InstanceType<typeof mocks.Refusal> {
  return new mocks.Refusal(code, "a listener owns the port");
}

let savedConfigPath: string | undefined;

beforeEach(() => {
  savedConfigPath = process.env.ULTRASEARCH_CONFIG;
  process.env.ULTRASEARCH_CONFIG = CONFIG_PATH;
  mocks.getControlPlaneStatus.mockResolvedValue(statusFixture(RUNNING_STATUS));
  mocks.getControlPlaneConfig.mockReturnValue({
    values: { localSearch: { endpoint: "http://127.0.0.1:8099" } },
  });
  mocks.provision.mockResolvedValue(OPERATION_RESULTS.provision);
  mocks.start.mockResolvedValue(OPERATION_RESULTS.start);
  mocks.stop.mockResolvedValue(OPERATION_RESULTS.stop);
  mocks.restart.mockResolvedValue(OPERATION_RESULTS.restart);
  mocks.repair.mockResolvedValue(OPERATION_RESULTS.repair);
  mocks.readStatus.mockResolvedValue(RUNNING_STATUS);
  mocks.cleanup.mockResolvedValue(CLEANUP_RESULT);
});

afterEach(() => {
  vi.clearAllMocks();
  if (savedConfigPath === undefined) delete process.env.ULTRASEARCH_CONFIG;
  else process.env.ULTRASEARCH_CONFIG = savedConfigPath;
});

describe("H6 runtime command dispatch matrix", () => {
  it("dispatches every operation to its Control Plane barrel export with the default root", async () => {
    const expected = {
      provision: mocks.provision,
      start: mocks.start,
      stop: mocks.stop,
      restart: mocks.restart,
      status: mocks.readStatus,
      repair: mocks.repair,
      cleanup: mocks.cleanup,
    };
    expect(RUNTIME_CLI_OPERATIONS).toEqual([
      "provision",
      "start",
      "stop",
      "restart",
      "status",
      "repair",
      "cleanup",
    ]);

    for (const operation of RUNTIME_CLI_OPERATIONS) {
      const { result } = await captureStdout(() =>
        runCliCommand(["runtime", operation]),
      );
      expect(result).toBe(true);
      expect(expected[operation]).toHaveBeenCalledWith({ paths: defaultPaths });
    }
    expect(mocks.root).toHaveBeenCalledTimes(RUNTIME_CLI_OPERATIONS.length);
    expect(mocks.pathsForRoot).toHaveBeenCalledWith("C:\\managed-runtime-root");
  });

  it("ignores trailing arguments after the operation", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "status", "--json", "ignored"]),
    );
    expect(JSON.parse(output)).toEqual(RUNNING_STATUS);
  });

  it("rethrows a non-refusal error instead of swallowing it", async () => {
    mocks.start.mockRejectedValue(new Error("unexpected lifecycle crash"));
    await expect(
      captureStdout(() => runCliCommand(["runtime", "start"])),
    ).rejects.toThrow("unexpected lifecycle crash");
  });
});

describe("H6 human output matrix (per operation)", () => {
  it("provision renders the outcome and the projected status", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "provision"]),
    );
    expect(output).toContain("UltraSearch MCP runtime");
    expect(output).toContain("managed_runtime.operation=provision");
    expect(output).toContain("managed_runtime.outcome=provisioned");
    expect(output).toContain("managed_runtime.state=provisioned");
    expect(output).toContain("managed_runtime.pid=none");
  });

  it("start renders the started status with the recorded pid", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "start"]),
    );
    expect(output).toContain("managed_runtime.outcome=started");
    expect(output).toContain("managed_runtime.state=running");
    expect(output).toContain("managed_runtime.pid=51234");
    expect(output).toContain("managed_runtime.generation=2");
    expect(output).toContain("managed_runtime.ownership=ultrasearch_managed");
  });

  it("stop renders the stopped outcome", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "stop"]),
    );
    expect(output).toContain("managed_runtime.outcome=stopped");
    expect(output).toContain("managed_runtime.state=provisioned");
  });

  it("restart renders the restarted outcome", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "restart"]),
    );
    expect(output).toContain("managed_runtime.outcome=restarted");
    expect(output).toContain("managed_runtime.state=running");
  });

  it("status renders the read-only status lines without an outcome line", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "status"]),
    );
    expect(output).toContain("managed_runtime.operation=status");
    expect(output).toContain("managed_runtime.state=running");
    expect(output).toContain("managed_runtime.endpoint=http://127.0.0.1:18099");
    expect(output).toContain("managed_runtime.port=18099");
    expect(output).toContain("managed_runtime.state_file=");
    expect(output).not.toContain("managed_runtime.outcome=");
  });

  it("repair renders the idempotent outcome", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "repair"]),
    );
    expect(output).toContain("managed_runtime.outcome=already_provisioned");
  });

  it("cleanup renders the full cleanup proof", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "cleanup"]),
    );
    expect(output).toContain("managed_runtime.outcome=deleted");
    expect(output).toContain("managed_runtime.last_state=provisioned");
    expect(output).toContain("managed_runtime.path_absent=true");
    expect(output).toContain("managed_runtime.listeners_after=0");
    expect(output).toContain("managed_runtime.survivors_after=0");
    expect(output).toContain("managed_runtime.cleared_lock_pids=none");
    expect(mocks.cleanup).toHaveBeenCalledWith({ paths: defaultPaths });
  });
});

describe("H6 --json output matrix (per operation)", () => {
  const expectations: Array<{
    operation: (typeof RUNTIME_CLI_OPERATIONS)[number];
    expected: unknown;
  }> = [
    { operation: "provision", expected: OPERATION_RESULTS.provision },
    { operation: "start", expected: OPERATION_RESULTS.start },
    { operation: "stop", expected: OPERATION_RESULTS.stop },
    { operation: "restart", expected: OPERATION_RESULTS.restart },
    { operation: "status", expected: RUNNING_STATUS },
    { operation: "repair", expected: OPERATION_RESULTS.repair },
    { operation: "cleanup", expected: CLEANUP_RESULT },
  ];

  for (const { operation, expected } of expectations) {
    it(`${operation} --json prints the barrel result verbatim`, async () => {
      const { output } = await captureStdout(() =>
        runCliCommand(["runtime", operation, "--json"]),
      );
      expect(JSON.parse(output)).toEqual(expected);
    });
  }

  it("prints byte-identical sorted output across repeated runs", async () => {
    const first = await captureStdout(() =>
      runCliCommand(["runtime", "start", "--json"]),
    );
    const second = await captureStdout(() =>
      runCliCommand(["runtime", "start", "--json"]),
    );
    expect(first.output).toBe(second.output);
    // Keys are recursively sorted: "outcome" leads although the fixture object
    // declares it after "status"; inside the status, "endpoint" precedes
    // "state" although the fixture declares state first.
    expect(first.output.indexOf('"endpoint"')).toBeLessThan(
      first.output.indexOf('"state"'),
    );
    expect(first.output.startsWith('{\n  "outcome":')).toBe(true);
  });
});

describe("H6 usage and help matrix", () => {
  it("prints exactly the usage text when the operation is missing", async () => {
    const { output, result } = await captureStdout(() =>
      runCliCommand(["runtime"]),
    );
    expect(result).toBe(true);
    expect(output).toBe(USAGE_TEXT);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("prints the same usage text for the literal help operation", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "help"]),
    );
    expect(output).toBe(USAGE_TEXT);
  });

  it("prints usage plus a machine-readable line for an unknown operation", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "definitely-not-an-operation"]),
    );
    expect(
      output.startsWith(
        `${USAGE_TEXT}\nmanaged_runtime.unknown_operation=definitely-not-an-operation`,
      ),
    ).toBe(true);
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("treats a bare --json token as an unknown operation, not a format flag", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "--json"]),
    );
    expect(output).toContain("managed_runtime.unknown_operation=--json");
    expect(output).toContain("Usage:");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("ignores --json on the help path and still prints the human usage text", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "help", "--json"]),
    );
    expect(output).toBe(USAGE_TEXT);
  });

  it("lists doctor, status, and runtime with their flags in the CLI help", async () => {
    const { output } = await captureStdout(() => printHelp());
    expect(output).toContain("UltraSearch MCP");
    expect(output).toContain("ultrasearch-mcp doctor [--json]");
    expect(output).toContain("ultrasearch-mcp status [--json]");
    expect(output).toContain("ultrasearch-mcp runtime <op> [--json]");
    expect(output).toContain("ultrasearch-mcp init-config");
    expect(output).toContain(`Default config file: ${CONFIG_PATH}`);
  });
});

describe("H6 refusal rendering matrix", () => {
  const refusing = {
    provision: mocks.provision,
    start: mocks.start,
    stop: mocks.stop,
    restart: mocks.restart,
    status: mocks.readStatus,
    repair: mocks.repair,
    cleanup: mocks.cleanup,
  };

  for (const operation of RUNTIME_CLI_OPERATIONS) {
    it(`${operation} renders a handled refusal in both formats`, async () => {
      refusing[operation].mockRejectedValue(refusal());

      const human = await captureStdout(() =>
        runCliCommand(["runtime", operation]),
      );
      const json = await captureStdout(() =>
        runCliCommand(["runtime", operation, "--json"]),
      );

      expect(human.result).toBe(true);
      expect(human.output).toContain(`managed_runtime.operation=${operation}`);
      expect(human.output).toContain("managed_runtime.refused=true");
      expect(human.output).toContain(
        "managed_runtime.refusal_code=port_in_use_foreign",
      );
      expect(human.output).toContain(
        "managed_runtime.detail=a listener owns the port",
      );

      expect(JSON.parse(json.output)).toEqual({
        operation,
        refused: true,
        code: "port_in_use_foreign",
        detail: "a listener owns the port",
      });
      // Sorted keys: "code" leads even though the rendered object starts with
      // "operation".
      expect(json.output.startsWith('{\n  "code":')).toBe(true);
      expect(json.output.indexOf('"code"')).toBeLessThan(
        json.output.indexOf('"operation"'),
      );
    });
  }
});

describe("H6 exit posture pin (current behavior, not a recommendation)", () => {
  it("a handled refusal prints and never sets process.exitCode", async () => {
    const before = process.exitCode;
    mocks.start.mockRejectedValue(refusal());
    const { result } = await captureStdout(() =>
      runCliCommand(["runtime", "start"]),
    );
    expect(result).toBe(true);
    expect(process.exitCode).toBe(before);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("no CLI module assigns process.exitCode and the command surface never exits directly", () => {
    const cliDir = join(repoRoot, "src", "cli");
    const cliFiles = readdirSync(cliDir).filter((name) => name.endsWith(".ts"));
    expect(cliFiles.length).toBeGreaterThanOrEqual(2);
    for (const file of cliFiles) {
      expect(readFileSync(join(cliDir, file), "utf8")).not.toContain(
        "process.exitCode",
      );
    }
    for (const file of ["configure.ts", "runtime.ts"]) {
      expect(readFileSync(join(cliDir, file), "utf8")).not.toContain(
        "process.exit(",
      );
    }
    // The MCP entry point exits with a literal 0 after every CLI command, so
    // a handled refusal cannot produce a non-zero process status.
    const entry = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");
    expect(entry).toContain("process.exit(0)");
  });
});

describe("H6 doctor/status managed-runtime projection", () => {
  it("renders every managed_runtime.* line for a running projection", () => {
    const status = statusFixture(RUNNING_STATUS);
    const doctor = renderControlPlaneStatus(status, "doctor", "human");
    const commandStatus = renderControlPlaneStatus(status, "status", "human");

    expect(doctor).toContain("UltraSearch MCP doctor");
    for (const output of [doctor, commandStatus]) {
      expect(output).toContain("managed_runtime.state=running");
      expect(output).toContain(
        "managed_runtime.endpoint=http://127.0.0.1:18099",
      );
      expect(output).toContain("managed_runtime.port=18099");
      expect(output).toContain("managed_runtime.pid=51234");
      expect(output).toContain("managed_runtime.generation=2");
      expect(output).toContain("managed_runtime.ownership=ultrasearch_managed");
    }
  });

  it("renders state=unavailable and no pid line when the projection is null", () => {
    const output = renderControlPlaneStatus(
      statusFixture(null),
      "status",
      "human",
    );
    expect(output).toContain("managed_runtime.state=unavailable");
    expect(output).not.toContain("managed_runtime.pid");
    expect(output).not.toContain("managed_runtime.endpoint=");
  });

  it("carries the projection through the doctor/status command path", async () => {
    const doctor = await captureStdout(() =>
      runCliCommand(["doctor", "--json"]),
    );
    const commandStatus = await captureStdout(() =>
      runCliCommand(["status", "--json"]),
    );
    expect(mocks.getControlPlaneStatus).toHaveBeenCalledTimes(2);
    expect(JSON.parse(doctor.output)).toEqual(statusFixture(RUNNING_STATUS));
    expect(JSON.parse(doctor.output).managedRuntime.state).toBe("running");
    expect(commandStatus.output).toBe(doctor.output);
  });

  it("renders the unavailable projection through the command path", async () => {
    mocks.getControlPlaneStatus.mockResolvedValue(statusFixture(null));
    const { output } = await captureStdout(() => runCliCommand(["status"]));
    expect(output).toContain("managed_runtime.state=unavailable");
  });

  it("keeps the human status line set stable across repeated renders", () => {
    const status = statusFixture(RUNNING_STATUS);
    const first = renderControlPlaneStatus(status, "status", "human");
    const second = renderControlPlaneStatus(status, "status", "human");
    expect(first).toBe(second);
    expect(first).toContain("routing.mode=local_first");
    expect(first).toContain("cache.state=reachable");
  });
});
