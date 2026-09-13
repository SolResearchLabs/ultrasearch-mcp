import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    provision: vi.fn(),
    readStatus: vi.fn(),
    repair: vi.fn(),
    restart: vi.fn(),
    root: vi.fn(() => "C:\\managed-runtime-root"),
    pathsForRoot: vi.fn((root: string) => ({
      managedRoot: root,
      checkoutPath: `${root}\\searxng`,
      archivePath: `${root}\\searxng-source.tar`,
      patchPath: `${root}\\artifacts\\valkeydb-windows.patch`,
      interpreterPath: `${root}\\.venv\\Scripts\\python.exe`,
    })),
    start: vi.fn(),
    stop: vi.fn(),
  };
});

vi.mock("../../src/control-plane/index.js", () => ({
  ManagedRuntimeRefusalError: mocks.Refusal,
  cleanupManagedRuntime: mocks.cleanup,
  defaultManagedRuntimeRoot: mocks.root,
  getControlPlaneConfig: vi.fn(),
  getControlPlaneStatus: vi.fn(),
  managedRuntimePathsForRoot: mocks.pathsForRoot,
  provisionManagedRuntime: mocks.provision,
  readManagedRuntimeStatus: mocks.readStatus,
  repairManagedRuntime: mocks.repair,
  restartManagedRuntime: mocks.restart,
  startManagedRuntime: mocks.start,
  stopManagedRuntime: mocks.stop,
}));

import { printHelp, runCliCommand } from "../../src/cli/configure.js";
import { RUNTIME_CLI_OPERATIONS } from "../../src/cli/runtime.js";

const managedStatus = {
  state: "running" as const,
  endpoint: "http://127.0.0.1:18099",
  port: 18_099,
  pid: 51_234,
  generation: 2,
  ownership: "ultrasearch_managed" as const,
  verification: {
    pinCommit: "a".repeat(40),
    treeId: "b".repeat(40),
    archiveSha256: "c".repeat(64),
    patchSha256: "d".repeat(64),
    patchedFileSha256: "e".repeat(64),
    interpreterPath: "C:\\managed-runtime-root\\.venv\\Scripts\\python.exe",
  },
  lastReadiness: { status: 200, at: "2026-09-12T00:00:00.000Z", elapsedMs: 12 },
  lastStop: null,
  lastCrash: null,
  lastRefusal: null,
  observedAt: "2026-09-12T00:00:00.000Z",
  stateFile: "C:\\managed-runtime-root\\state\\managed-runtime.json",
};

const operationResult = { outcome: "started" as const, status: managedStatus };

const cleanupResult = {
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

describe("managed runtime CLI surface", () => {
  beforeEach(() => {
    mocks.provision.mockResolvedValue({
      outcome: "provisioned",
      status: { ...managedStatus, state: "provisioned", pid: null },
    });
    mocks.start.mockResolvedValue(operationResult);
    mocks.stop.mockResolvedValue({
      outcome: "stopped",
      status: { ...managedStatus, state: "provisioned", pid: null },
    });
    mocks.restart.mockResolvedValue({
      outcome: "restarted",
      status: managedStatus,
    });
    mocks.repair.mockResolvedValue({
      outcome: "already_provisioned",
      status: { ...managedStatus, state: "provisioned", pid: null },
    });
    mocks.cleanup.mockResolvedValue(cleanupResult);
    mocks.readStatus.mockResolvedValue(managedStatus);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches each operation to the Control Plane module with the default root", async () => {
    const expected = {
      provision: mocks.provision,
      start: mocks.start,
      stop: mocks.stop,
      restart: mocks.restart,
      status: mocks.readStatus,
      repair: mocks.repair,
      cleanup: mocks.cleanup,
    };

    for (const operation of RUNTIME_CLI_OPERATIONS) {
      const { result } = await captureStdout(() =>
        runCliCommand(["runtime", operation]),
      );

      expect(result).toBe(true);
      expect(expected[operation]).toHaveBeenCalledWith({
        paths: defaultPaths,
      });
    }
    expect(mocks.root).toHaveBeenCalled();
    expect(mocks.pathsForRoot).toHaveBeenCalledWith("C:\\managed-runtime-root");
  });

  it("prints a stable JSON result with --json", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "start", "--json"]),
    );

    expect(JSON.parse(output)).toEqual(operationResult);
  });

  it("prints the read-only status projection in human form", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "status"]),
    );

    expect(output).toContain("UltraSearch MCP runtime");
    expect(output).toContain("managed_runtime.operation=status");
    expect(output).toContain("managed_runtime.state=running");
    expect(output).toContain("managed_runtime.endpoint=http://127.0.0.1:18099");
    expect(output).toContain("managed_runtime.port=18099");
    expect(output).toContain("managed_runtime.pid=51234");
    expect(output).toContain("managed_runtime.generation=2");
    expect(output).toContain("managed_runtime.ownership=ultrasearch_managed");
    expect(output).not.toContain("SEARXNG_SECRET");
  });

  it("renders a cleanup proof and never reimplements lifecycle rules", async () => {
    const { output } = await captureStdout(() =>
      runCliCommand(["runtime", "cleanup"]),
    );

    expect(output).toContain("managed_runtime.outcome=deleted");
    expect(output).toContain("managed_runtime.path_absent=true");
    expect(output).toContain("managed_runtime.listeners_after=0");
    expect(output).toContain("managed_runtime.survivors_after=0");
    expect(mocks.cleanup).toHaveBeenCalledWith({ paths: defaultPaths });
  });

  it("renders a typed refusal without throwing", async () => {
    mocks.start.mockRejectedValue(
      new mocks.Refusal("port_in_use_foreign", "a listener owns the port"),
    );

    const human = await captureStdout(() =>
      runCliCommand(["runtime", "start"]),
    );
    const json = await captureStdout(() =>
      runCliCommand(["runtime", "start", "--json"]),
    );

    expect(human.result).toBe(true);
    expect(human.output).toContain("managed_runtime.refused=true");
    expect(human.output).toContain(
      "managed_runtime.refusal_code=port_in_use_foreign",
    );
    expect(JSON.parse(json.output)).toEqual({
      operation: "start",
      refused: true,
      code: "port_in_use_foreign",
      detail: "a listener owns the port",
    });
  });

  it("prints usage for a missing or unknown operation without calling the module", async () => {
    const missing = await captureStdout(() => runCliCommand(["runtime"]));
    const unknown = await captureStdout(() =>
      runCliCommand(["runtime", "definitely-not-an-operation"]),
    );

    expect(missing.result).toBe(true);
    expect(missing.output).toContain("ultrasearch-mcp runtime <operation>");
    expect(unknown.output).toContain(
      "managed_runtime.unknown_operation=definitely-not-an-operation",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.readStatus).not.toHaveBeenCalled();
  });

  it("lists the runtime command with its --json flag in the CLI help", async () => {
    const { output } = await captureStdout(() => printHelp());

    expect(output).toContain("ultrasearch-mcp runtime <op> [--json]");
  });
});
