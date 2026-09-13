import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderControlPlaneStatus } from "../../src/cli/configure.js";
import { resolveControlPlaneConfig } from "../../src/control-plane/config.js";
import {
  cleanupManagedRuntime,
  MANAGED_RUNTIME_HOST,
  MANAGED_RUNTIME_MARKER_FILE,
  MANAGED_RUNTIME_PORT,
  type ManagedRuntimeDependencies,
  type ManagedRuntimeLifecycleState,
  type ManagedRuntimeListener,
  type ManagedRuntimeOperationResult,
  type ManagedRuntimeOptions,
  type ManagedRuntimePaths,
  type ManagedRuntimeProcessFacts,
  type ManagedRuntimeProcessLayer,
  ManagedRuntimeRefusalError,
  type ManagedRuntimeSpawnRequest,
  type ManagedRuntimeStatus,
  type ManagedRuntimeSurvivorAssessment,
  type ManagedRuntimeSurvivorQuery,
  managedRuntimePathsForRoot,
  provisionManagedRuntime,
  readManagedRuntimeStatus,
  reconcileManagedRuntime,
  repairManagedRuntime,
  restartManagedRuntime,
  rootScopedSurvivors,
  startManagedRuntime,
  stopManagedRuntime,
} from "../../src/control-plane/runtime-lifecycle.js";
import {
  type ControlPlaneStatusDependencies,
  getControlPlaneStatus,
} from "../../src/control-plane/status.js";

/*
 * H2: operation x platform matrix for the managed lifecycle.
 *
 * Every lifecycle operation - including the read-only `status` and the
 * on-demand-supervision `reconcile` - refuses `unsupported_platform` on a
 * non-win32 injected `processLayer.platform`, before any filesystem write,
 * spawn, terminate, inspect, listener query, or survivor scan. On win32 the
 * same call passes the platform gate and reaches the next deterministic
 * fixture outcome (never "success by default"). The status projection seam
 * maps the refusal to `null` / `managed_runtime.state=unavailable`.
 *
 * Only the injected platform value varies; no test claims behavior on a real
 * non-Windows host (`docs/control-plane.md` contract, tested through fakes).
 */

const PRISTINE_CONTENTS =
  "import os\n\n\ndef initialize():\n    return False\n";
const PATCHED_CONTENTS = `${PRISTINE_CONTENTS}PATCHED = True\n`;
const ARCHIVE_CONTENTS = "synthetic pinned archive (never the real artifact)\n";
const PATCH_CONTENTS = [
  "diff --git a/searx/valkeydb.py b/searx/valkeydb.py",
  "--- a/searx/valkeydb.py",
  "+++ b/searx/valkeydb.py",
  "@@ -1,3 +1,4 @@",
  " import os",
  "+PATCHED = True",
  "",
].join("\n");
/** The resolved base CPython placeholder; the only interpreter ever recorded. */
const RESOLVED_INTERPRETER_CONTENTS =
  "synthetic resolved base CPython placeholder\n";
/** The venv redirector launcher placeholder; never recorded, never spawned. */
const VENV_LAUNCHER_CONTENTS =
  "synthetic venv redirector launcher placeholder\n";
const SITE_PACKAGES_CONTENTS = "fixture site-packages module\n";
const SPAWNED_AT = "2026-09-12T00:00:00.000Z";

const temporaryRoots: string[] = [];

function sha256Of(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

interface LayerCallCounts {
  spawn: number;
  inspect: number;
  listeners: number;
  terminate: number;
  survivors: number;
}

function zeroCalls(): LayerCallCounts {
  return { spawn: 0, inspect: 0, listeners: 0, terminate: 0, survivors: 0 };
}

/**
 * Minimal fake OS seam. Every method counts its calls so a platform refusal
 * can be asserted to be write-silent and process-silent on the fake layer
 * (the real layer never runs in this suite).
 */
class FakeProcessLayer implements ManagedRuntimeProcessLayer {
  platform: NodeJS.Platform = "win32";
  calls: LayerCallCounts = zeroCalls();
  private readonly processes = new Map<number, ManagedRuntimeProcessFacts>();
  private listeners: ManagedRuntimeListener[] = [];
  private nextPid = 61_000;

  spawn(request: ManagedRuntimeSpawnRequest): number {
    this.calls.spawn += 1;
    const pid = this.nextPid;
    this.nextPid += 1;
    this.processes.set(pid, {
      pid,
      executablePath: request.executablePath,
      startedAt: SPAWNED_AT,
    });
    this.listeners = [
      { address: MANAGED_RUNTIME_HOST, port: MANAGED_RUNTIME_PORT, pid },
    ];
    return pid;
  }

  inspect(pid: number): ManagedRuntimeProcessFacts | null {
    this.calls.inspect += 1;
    return this.processes.get(pid) ?? null;
  }

  listenersOnPort(port: number): ManagedRuntimeListener[] {
    this.calls.listeners += 1;
    return this.listeners.filter((listener) => listener.port === port);
  }

  terminate(pid: number, mode: "terminate" | "force"): void {
    this.calls.terminate += 1;
    this.processes.delete(pid);
    this.listeners = this.listeners.filter((listener) => listener.pid !== pid);
    if (mode === "force") return;
  }

  rootScopedSurvivors(
    query: ManagedRuntimeSurvivorQuery,
  ): ManagedRuntimeSurvivorAssessment {
    this.calls.survivors += 1;
    return rootScopedSurvivors([], query);
  }
}

interface PlatformFixture {
  root: string;
  paths: ManagedRuntimePaths;
  markerFile: string;
  layer: FakeProcessLayer;
  dependencies: ManagedRuntimeDependencies;
  options: () => ManagedRuntimeOptions;
  stateRecord: () => Record<string, unknown> | null;
}

function createFixture(): PlatformFixture {
  const root = mkdtempSync(join(tmpdir(), "ultrasearch-platform-matrix-"));
  temporaryRoots.push(root);
  const paths = managedRuntimePathsForRoot(root);
  const venvRoot = paths.venvRoot;
  const resolvedInterpreterPath = join(root, "python-base", "python.exe");
  const sitePackagesPath = join(venvRoot, "Lib", "site-packages");
  mkdirSync(join(paths.checkoutPath, "searx"), { recursive: true });
  mkdirSync(join(root, "artifacts"), { recursive: true });
  mkdirSync(join(venvRoot, "Scripts"), { recursive: true });
  mkdirSync(sitePackagesPath, { recursive: true });
  mkdirSync(dirname(resolvedInterpreterPath), { recursive: true });
  writeFileSync(
    join(paths.checkoutPath, "searx", "valkeydb.py"),
    PRISTINE_CONTENTS,
    "utf8",
  );
  writeFileSync(
    join(paths.checkoutPath, "searx", "settings.yml"),
    "fixture settings\n",
    "utf8",
  );
  writeFileSync(paths.archivePath, ARCHIVE_CONTENTS, "utf8");
  writeFileSync(paths.patchPath, PATCH_CONTENTS, "utf8");
  writeFileSync(
    join(venvRoot, "Scripts", "python.exe"),
    VENV_LAUNCHER_CONTENTS,
    "utf8",
  );
  writeFileSync(
    join(sitePackagesPath, "fixture_package.py"),
    SITE_PACKAGES_CONTENTS,
    "utf8",
  );
  writeFileSync(resolvedInterpreterPath, RESOLVED_INTERPRETER_CONTENTS, "utf8");
  writeFileSync(
    join(venvRoot, "pyvenv.cfg"),
    `home = ${dirname(resolvedInterpreterPath)}\nimplementation = CPython\ninclude-system-site-packages = false\n`,
    "utf8",
  );

  const markerFile = join(root, MANAGED_RUNTIME_MARKER_FILE);
  writeFileSync(
    markerFile,
    `${JSON.stringify({ schemaVersion: 1, kind: "fixture-marker" })}\n`,
    "utf8",
  );

  const layer = new FakeProcessLayer();
  const stateFile = join(root, "state", "managed-runtime.json");
  const dependencies: ManagedRuntimeDependencies = {
    applyWindowsPatch: (options) => {
      writeFileSync(
        join(options.checkoutPath, "searx", "valkeydb.py"),
        PATCHED_CONTENTS,
        "utf8",
      );
      return {
        applied: true,
        pinCommit: "a".repeat(40),
        treeId: "b".repeat(40),
        archiveSha256: sha256Of(ARCHIVE_CONTENTS),
        patchSha256: sha256Of(PATCH_CONTENTS),
      };
    },
    processLayer: layer,
    readinessProbe: async () => ({ status: 200 }),
    clock: () => new Date(SPAWNED_AT),
    sleep: async () => {},
    expectedDigests: {
      pristineValkeydbSha256: sha256Of(PRISTINE_CONTENTS),
      patchedValkeydbSha256: sha256Of(PATCHED_CONTENTS),
    },
  };

  return {
    root,
    paths,
    markerFile,
    layer,
    dependencies,
    options: () => ({ paths, dependencies }),
    stateRecord: () =>
      existsSync(stateFile)
        ? (JSON.parse(readFileSync(stateFile, "utf8")) as Record<
            string,
            unknown
          >)
        : null,
  };
}

/** Relative path (directories marked `/`) -> content digest for every entry. */
function snapshotTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!existsSync(root)) return entries;
  entries["/"] = "<root>";
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      const key = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        entries[`${key}/`] = "<dir>";
        walk(child, key);
      } else {
        entries[key] = sha256Of(readFileSync(child, "utf8"));
      }
    }
  };
  walk(root, "");
  return entries;
}

type OperationRunner = (options: ManagedRuntimeOptions) => Promise<unknown>;

interface OperationRow {
  name: string;
  baseline: "staged" | "provisioned";
  run: OperationRunner;
}

/**
 * The eight managed lifecycle operations. `baseline` is the preparation the
 * win32 rows need so that the platform gate is followed by a deterministic
 * fixture outcome rather than by an unrelated precondition refusal.
 */
const LIFECYCLE_OPERATIONS: OperationRow[] = [
  {
    name: "provision",
    baseline: "staged",
    run: (options) => provisionManagedRuntime(options),
  },
  {
    name: "start",
    baseline: "provisioned",
    run: (options) => startManagedRuntime(options),
  },
  {
    name: "stop",
    baseline: "provisioned",
    run: (options) => stopManagedRuntime(options),
  },
  {
    name: "restart",
    baseline: "provisioned",
    run: (options) => restartManagedRuntime(options),
  },
  {
    name: "repair",
    baseline: "provisioned",
    run: (options) => repairManagedRuntime(options),
  },
  {
    name: "cleanup",
    baseline: "provisioned",
    run: (options) => cleanupManagedRuntime(options),
  },
  {
    name: "status",
    baseline: "provisioned",
    run: (options) => readManagedRuntimeStatus(options),
  },
  {
    name: "reconcile",
    baseline: "provisioned",
    run: (options) => reconcileManagedRuntime(options),
  },
];

const NON_WIN32_PLATFORMS: NodeJS.Platform[] = ["linux", "darwin", "freebsd"];

const platformRefusalRows = NON_WIN32_PLATFORMS.flatMap((platform) =>
  LIFECYCLE_OPERATIONS.map((operation) => ({
    platform,
    operation: operation.name,
    baseline: operation.baseline,
    run: operation.run,
  })),
);

async function refusalOf(
  run: () => Promise<unknown>,
): Promise<ManagedRuntimeRefusalError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ManagedRuntimeRefusalError) return error;
    throw error;
  }
  throw new Error("expected the managed runtime operation to refuse");
}

interface Win32Case {
  operation: string;
  baseline: "staged" | "provisioned";
  expect: { outcome?: string; state?: ManagedRuntimeLifecycleState };
}

const WIN32_CASES: Win32Case[] = [
  {
    operation: "provision",
    baseline: "staged",
    expect: { outcome: "provisioned", state: "provisioned" },
  },
  {
    operation: "start",
    baseline: "provisioned",
    expect: { outcome: "started", state: "running" },
  },
  {
    operation: "stop",
    baseline: "provisioned",
    expect: { outcome: "already_stopped", state: "provisioned" },
  },
  {
    operation: "restart",
    baseline: "provisioned",
    expect: { outcome: "restarted", state: "running" },
  },
  {
    operation: "repair",
    baseline: "provisioned",
    expect: { outcome: "already_provisioned", state: "provisioned" },
  },
  {
    operation: "cleanup",
    baseline: "provisioned",
    expect: { outcome: "deleted" },
  },
  {
    operation: "status",
    baseline: "provisioned",
    expect: { state: "provisioned" },
  },
  {
    operation: "reconcile",
    baseline: "provisioned",
    expect: { state: "provisioned" },
  },
];

/** Normalized (outcome, state) projection of the raw operation result. */
function observeResult(value: unknown): {
  outcome?: string;
  state?: ManagedRuntimeLifecycleState;
} {
  if (value === null || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const status = record.status;
  const statusState =
    status !== null && typeof status === "object"
      ? ((status as Record<string, unknown>)
          .state as ManagedRuntimeLifecycleState)
      : undefined;
  if (typeof record.outcome === "string") {
    return { outcome: record.outcome, state: statusState };
  }
  if (typeof record.state === "string") {
    return { state: record.state as ManagedRuntimeLifecycleState };
  }
  return {};
}

function statusDependencies(
  readManagedRuntime: ControlPlaneStatusDependencies["readManagedRuntime"],
): ControlPlaneStatusDependencies {
  return {
    observeRuntime: async () => ({
      runtime: {
        mode: "unavailable",
        ownership: "external",
        observation: "not_probed",
        lifecycle: "unavailable",
        observedAt: SPAWNED_AT,
        endpoint: null,
        diagnostic: null,
      },
      localSearch: { state: "not_probed", endpoint: null },
    }),
    probeCache: async () => ({ state: "unreachable" as const }),
    providerControlSnapshot: () => ({ searxng: { active: 0 } }),
    hostedSearchControlSnapshot: () => ({ exa: { active: 0 } }),
    hostedSearchBudgetSnapshot: async () => ({}),
    configuredHostedSearchProviders: () => [],
    readManagedRuntime,
  };
}

describe("Control Plane platform gate matrix", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A root that resisted deletion is reported by its own test.
      }
      expect(existsSync(root)).toBe(false);
    }
  });

  it("matrix completeness: all eight managed lifecycle operations are enumerated", () => {
    expect(
      LIFECYCLE_OPERATIONS.map((operation) => operation.name).sort(),
    ).toEqual([
      "cleanup",
      "provision",
      "reconcile",
      "repair",
      "restart",
      "start",
      "status",
      "stop",
    ]);
    expect(platformRefusalRows).toHaveLength(24);
  });

  it.each(
    platformRefusalRows,
  )("$operation on $platform refuses unsupported_platform before any write, spawn, terminate, inspect, listener query, or survivor scan", async ({
    platform,
    baseline,
    run,
  }) => {
    const fixture = createFixture();
    if (baseline === "provisioned") {
      const provisioned = await provisionManagedRuntime(fixture.options());
      expect(provisioned.outcome).toBe("provisioned");
      fixture.layer.calls = zeroCalls();
    }
    const before = snapshotTree(fixture.root);
    fixture.layer.platform = platform;

    const error = await refusalOf(() => run(fixture.options()));

    expect(error.code).toBe("unsupported_platform");
    expect(error.detail).toContain(platform);
    expect(error.detail).toContain("Windows-first");
    // Zero writes: the refusal happens before the root lock and before any
    // state artifact; the tree (files and directories) is byte-identical.
    expect(snapshotTree(fixture.root)).toEqual(before);
    // Zero process-layer traffic: no spawn, inspect, terminate, listener
    // query, or survivor scan for the refusal.
    expect(fixture.layer.calls).toEqual(zeroCalls());
    // And the record written by the win32 baseline is untouched (the staged
    // baseline has no record at all, and the refusal never creates one).
    if (baseline === "provisioned") {
      expect(fixture.stateRecord()).toMatchObject({ state: "provisioned" });
    } else {
      expect(fixture.stateRecord()).toBeNull();
    }
  });

  it("refuses cleanup with unsupported_platform for an existing managed root but keeps already_absent for a root that does not exist", async () => {
    const existing = createFixture();
    existing.layer.platform = "darwin";
    const existingError = await refusalOf(() =>
      cleanupManagedRuntime(existing.options()),
    );
    expect(existingError.code).toBe("unsupported_platform");
    expect(existsSync(existing.root)).toBe(true);

    // The documented exception: a root path that does not exist has nothing
    // to verify, and an absent runtime is already absent on any platform.
    const absent = createFixture();
    absent.layer.platform = "darwin";
    rmSync(absent.root, { recursive: true, force: true });
    const cleaned = await cleanupManagedRuntime(absent.options());
    expect(cleaned).toMatchObject({
      outcome: "already_absent",
      lastState: "absent",
      pathAbsent: true,
      listenersAfter: 0,
      survivorPids: [],
    });
    expect(absent.layer.calls).toEqual(zeroCalls());
  });

  it.each(
    WIN32_CASES,
  )("$operation on win32 passes the platform gate and reaches the fixture outcome", async ({
    operation,
    baseline,
    expect: expected,
  }) => {
    const fixture = createFixture();
    if (baseline === "provisioned") {
      const provisioned: ManagedRuntimeOperationResult =
        await provisionManagedRuntime(fixture.options());
      expect(provisioned.outcome).toBe("provisioned");
    }
    const row = LIFECYCLE_OPERATIONS.find((entry) => entry.name === operation);
    if (row === undefined) throw new Error(`unknown operation ${operation}`);

    const observed = observeResult(await row.run(fixture.options()));

    expect(observed.outcome).toBe(expected.outcome);
    if (expected.state !== undefined) {
      expect(observed.state).toBe(expected.state);
    }
  });

  it("refuses the read-only status on a non-win32 platform even when a full state record exists", async () => {
    const fixture = createFixture();
    const provisioned = await provisionManagedRuntime(fixture.options());
    expect(provisioned.outcome).toBe("provisioned");
    const stateTextBefore = readFileSync(
      join(fixture.root, "state", "managed-runtime.json"),
      "utf8",
    );
    fixture.layer.platform = "linux";

    const error = await refusalOf(() =>
      readManagedRuntimeStatus(fixture.options()),
    );

    expect(error.code).toBe("unsupported_platform");
    expect(
      readFileSync(join(fixture.root, "state", "managed-runtime.json"), "utf8"),
    ).toBe(stateTextBefore);
    expect(fixture.layer.calls).toEqual(zeroCalls());
  });

  it("maps the status-projection refusal to null and managed_runtime.state=unavailable", async () => {
    const readManagedRuntime =
      async (): Promise<ManagedRuntimeStatus | null> => {
        throw new ManagedRuntimeRefusalError(
          "unsupported_platform",
          "process and listener identity verification is Windows-first",
        );
      };
    const status = await getControlPlaneStatus({
      config: resolveControlPlaneConfig({}),
      dependencies: statusDependencies(readManagedRuntime),
    });

    expect(status.managedRuntime).toBeNull();
    const human = renderControlPlaneStatus(status, "status", "human");
    expect(human).toContain("managed_runtime.state=unavailable");
    expect(human).not.toContain("managed_runtime.pid");
    const json = renderControlPlaneStatus(status, "doctor", "json");
    expect(
      (JSON.parse(json) as { managedRuntime: unknown }).managedRuntime,
    ).toBeNull();
  });
});
