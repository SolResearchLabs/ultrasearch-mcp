import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProvisioningRefusalError,
  type SearxngWindowsProvisioningOptions,
  type SearxngWindowsProvisioningResult,
} from "../../src/control-plane/provisioning.js";
import {
  cleanupManagedRuntime,
  defaultManagedRuntimeRoot,
  MANAGED_RUNTIME_HOST,
  MANAGED_RUNTIME_LOCK_FILE,
  MANAGED_RUNTIME_MARKER_FILE,
  MANAGED_RUNTIME_PORT,
  MANAGED_RUNTIME_REFUSAL_CODES,
  MANAGED_RUNTIME_STATE_FILE,
  type ManagedRuntimeDependencies,
  type ManagedRuntimeListener,
  type ManagedRuntimeOptions,
  type ManagedRuntimePaths,
  type ManagedRuntimeProcessCandidate,
  type ManagedRuntimeProcessFacts,
  type ManagedRuntimeProcessLayer,
  type ManagedRuntimeReadinessProbe,
  ManagedRuntimeRefusalError,
  type ManagedRuntimeSpawnRequest,
  type ManagedRuntimeSurvivorAssessment,
  type ManagedRuntimeSurvivorQuery,
  managedRuntimePathsForRoot,
  provisionManagedRuntime,
  readManagedRuntimeStatus,
  reconcileManagedRuntime,
  repairManagedRuntime,
  restartManagedRuntime,
  rootScopedSurvivors,
  SEARXNG_PATCHED_VALKEYDB_SHA256,
  SEARXNG_PRISTINE_VALKEYDB_SHA256,
  setManagedRuntimePortForTests,
  startManagedRuntime,
  stopManagedRuntime,
} from "../../src/control-plane/runtime-lifecycle.js";

const REPOSITORY_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

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
/** The venv's redirector launcher placeholder; never recorded, never spawned. */
const VENV_LAUNCHER_CONTENTS =
  "synthetic venv redirector launcher placeholder\n";
const SITE_PACKAGES_CONTENTS = "fixture site-packages module\n";
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const seenRefusalCodes = new Set<string>();
const temporaryRoots: string[] = [];

function sha256Of(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function fixtureGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `fixture git ${args.join(" ")} exited ${result.status}: ${result.stderr}`,
    );
  }
}

async function expectRefusal(
  run: () => Promise<unknown>,
): Promise<ManagedRuntimeRefusalError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ManagedRuntimeRefusalError) {
      seenRefusalCodes.add(error.code);
      return error;
    }
    throw error;
  }
  throw new Error("expected the managed runtime operation to refuse");
}

interface FakeProvisioner {
  calls: SearxngWindowsProvisioningOptions[];
  apply: (
    options: SearxngWindowsProvisioningOptions,
  ) => SearxngWindowsProvisioningResult;
}

function createFakeProvisioner(
  behavior: "apply" | "refuse" = "apply",
): FakeProvisioner {
  const calls: SearxngWindowsProvisioningOptions[] = [];
  return {
    calls,
    apply: (options: SearxngWindowsProvisioningOptions) => {
      calls.push(options);
      if (behavior === "refuse") {
        throw new ProvisioningRefusalError("apply_failed", "fixture refusal");
      }
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
  };
}

/**
 * The fake's process row: the enumerated candidate the root-scoped survivor
 * predicate examines, plus the inspector facts the layer also answers with.
 */
interface FakeProcessRow extends ManagedRuntimeProcessFacts {
  parentPid: number | null;
  commandLine: string | null;
}

class FakeProcessLayer implements ManagedRuntimeProcessLayer {
  platform: NodeJS.Platform = "win32";
  spawnBehavior: "ok" | "fail" | "no_pid" = "ok";
  listenerMode: "one" | "zero" | "two" | "foreign" | "wildcard" = "one";
  terminateBehavior: "exits" | "exits_on_force" | "stubborn" = "exits";
  leaveListenersAfterTerminate = false;
  /**
   * When set, the spawned process reports this executable path instead of the
   * requested one (a redirector launcher or a forking wrapper image).
   */
  spawnExecutableOverride: string | null = null;
  /** Number of upcoming inspect calls that throw instead of answering. */
  inspectFailuresRemaining = 0;
  listenerScript: ManagedRuntimeListener[][] | null = null;
  port = MANAGED_RUNTIME_PORT;
  spawned: Array<{ request: ManagedRuntimeSpawnRequest; pid: number }> = [];
  terminations: Array<{ pid: number; mode: "terminate" | "force" }> = [];

  private readonly processes = new Map<number, FakeProcessRow>();
  private listeners: ManagedRuntimeListener[] = [];
  private nextPid = 51_000;

  get lastPid(): number {
    return this.nextPid - 1;
  }

  spawn(request: ManagedRuntimeSpawnRequest): number {
    if (this.spawnBehavior === "fail") {
      throw new Error("fixture spawn failure");
    }
    if (this.spawnBehavior === "no_pid") return 0;
    const pid = this.nextPid;
    this.nextPid += 1;
    this.spawned.push({ request, pid });
    this.processes.set(pid, {
      pid,
      executablePath: this.spawnExecutableOverride ?? request.executablePath,
      startedAt: "2026-09-12T00:00:00.000Z",
      parentPid: process.pid,
      commandLine: `"${request.executablePath}" ${request.args.join(" ")}`,
    });
    if (this.listenerMode === "one" || this.listenerMode === "wildcard") {
      this.listeners = [
        {
          address:
            this.listenerMode === "wildcard" ? "0.0.0.0" : MANAGED_RUNTIME_HOST,
          port: this.port,
          pid,
        },
      ];
    } else if (this.listenerMode === "zero") {
      this.listeners = [];
    } else if (this.listenerMode === "two") {
      this.listeners = [
        { address: MANAGED_RUNTIME_HOST, port: this.port, pid },
        { address: MANAGED_RUNTIME_HOST, port: this.port, pid: pid + 1 },
      ];
    } else {
      this.listeners = [
        { address: MANAGED_RUNTIME_HOST, port: this.port, pid: pid + 7 },
      ];
    }
    return pid;
  }

  inspect(pid: number): ManagedRuntimeProcessFacts | null {
    if (this.inspectFailuresRemaining > 0) {
      this.inspectFailuresRemaining -= 1;
      throw new Error("fixture inspector failure");
    }
    return this.processes.get(pid) ?? null;
  }

  listenersOnPort(port: number): ManagedRuntimeListener[] {
    if (this.listenerScript !== null && this.listenerScript.length > 0) {
      return (this.listenerScript.shift() ?? []).filter(
        (listener) => listener.port === port,
      );
    }
    return this.listeners.filter((listener) => listener.port === port);
  }

  terminate(pid: number, mode: "terminate" | "force"): void {
    this.terminations.push({ pid, mode });
    if (this.terminateBehavior === "stubborn") return;
    if (this.terminateBehavior === "exits_on_force" && mode === "terminate") {
      return;
    }
    this.processes.delete(pid);
    if (!this.leaveListenersAfterTerminate) {
      this.listeners = this.listeners.filter(
        (listener) => listener.pid !== pid,
      );
    }
  }

  /**
   * The fake enumerates its rows and hands them to the module's real
   * root-scoped survivor predicate, so the typed suite exercises the predicate
   * itself - not a fake re-implementation of it.
   */
  rootScopedSurvivors(
    query: ManagedRuntimeSurvivorQuery,
  ): ManagedRuntimeSurvivorAssessment {
    return rootScopedSurvivors(this.processCandidates(), query);
  }

  /** The enumerated rows the survivor predicate examines, in insertion order. */
  processCandidates(): ManagedRuntimeProcessCandidate[] {
    return [...this.processes.values()].map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      executablePath: row.executablePath,
      commandLine: row.commandLine,
    }));
  }

  /** Registers an enumerated process row (a same-image foreign process, an
   * orphan referencing the managed root, or a malformed/fail-closed row). */
  addProcessCandidate(candidate: ManagedRuntimeProcessCandidate): void {
    this.processes.set(candidate.pid, {
      pid: candidate.pid,
      executablePath: candidate.executablePath,
      startedAt: "2026-09-12T00:00:00.000Z",
      parentPid: candidate.parentPid,
      commandLine: candidate.commandLine,
    });
  }

  addForeignListener(pid = 900_001): void {
    this.listeners = [
      ...this.listeners,
      { address: MANAGED_RUNTIME_HOST, port: this.port, pid },
    ];
    this.processes.set(pid, {
      pid,
      executablePath: "foreign.exe",
      startedAt: "2026-09-12T00:00:00.000Z",
      parentPid: 900_000,
      commandLine: "foreign.exe --listen",
    });
  }

  setListenerAddress(address: string): void {
    this.listeners = this.listeners.map((listener) => ({
      ...listener,
      address,
    }));
  }

  registerProcess(pid: number): void {
    this.processes.set(pid, {
      pid,
      executablePath: "fixture.exe",
      startedAt: "2026-09-12T00:00:00.000Z",
      parentPid: 812_000,
      commandLine: "fixture.exe --lock-holder",
    });
  }

  crashChild(): void {
    for (const { pid } of this.spawned) this.processes.delete(pid);
    this.listeners = [];
  }

  replaceChildIdentity(pid: number): void {
    const facts = this.processes.get(pid);
    if (facts !== undefined) {
      this.processes.set(pid, {
        ...facts,
        startedAt: "2030-01-01T00:00:00.000Z",
      });
    }
  }
}

interface FakeClock {
  clock: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

function createFakeClock(): FakeClock {
  let current = Date.parse("2026-09-12T00:00:00.000Z");
  return {
    clock: () => new Date(current),
    sleep: async (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

interface ReadinessScript {
  calls: string[];
  probe: ManagedRuntimeReadinessProbe;
}

function createReadinessScript(
  entries: Array<number | "reject">,
): ReadinessScript {
  let index = 0;
  const calls: string[] = [];
  return {
    calls,
    probe: async (url: string) => {
      calls.push(url);
      const entry = entries[Math.min(index, entries.length - 1)];
      index += 1;
      if (entry === "reject") {
        throw new Error("ECONNREFUSED 127.0.0.1:18099");
      }
      return { status: entry ?? 200 };
    },
  };
}

interface RuntimeFixture {
  root: string;
  paths: ManagedRuntimePaths;
  venvRoot: string;
  venvLauncherPath: string;
  resolvedInterpreterPath: string;
  pyvenvCfgPath: string;
  sitePackagesPath: string;
  provisioner: FakeProvisioner;
  layer: FakeProcessLayer;
  readiness: ReadinessScript;
  clock: FakeClock;
  stateFile: string;
  markerFile: string;
  dependencies: ManagedRuntimeDependencies;
  options: (
    overrides?: Partial<ManagedRuntimeOptions>,
  ) => ManagedRuntimeOptions;
  stateRecord: () => Record<string, unknown> | null;
}

function createRuntimeFixture(): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "ultrasearch-managed-runtime-"));
  temporaryRoots.push(root);
  const paths = managedRuntimePathsForRoot(root);
  const venvRoot = paths.venvRoot;
  const venvLauncherPath = join(venvRoot, "Scripts", "python.exe");
  const resolvedInterpreterPath = join(root, "python-base", "python.exe");
  const pyvenvCfgPath = join(venvRoot, "pyvenv.cfg");
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
  // A staged venv tree: the redirector launcher is present but must never be
  // recorded or spawned; the resolved base interpreter lives outside the venv
  // root and is named by `pyvenv.cfg`.
  writeFileSync(venvLauncherPath, VENV_LAUNCHER_CONTENTS, "utf8");
  writeFileSync(
    join(sitePackagesPath, "fixture_package.py"),
    SITE_PACKAGES_CONTENTS,
    "utf8",
  );
  writeFileSync(resolvedInterpreterPath, RESOLVED_INTERPRETER_CONTENTS, "utf8");
  writeFileSync(
    pyvenvCfgPath,
    `home = ${dirname(resolvedInterpreterPath)}\nimplementation = CPython\ninclude-system-site-packages = false\n`,
    "utf8",
  );

  const provisioner = createFakeProvisioner();
  const layer = new FakeProcessLayer();
  const readiness = createReadinessScript([200]);
  const clock = createFakeClock();
  const dependencies: ManagedRuntimeDependencies = {
    applyWindowsPatch: provisioner.apply,
    processLayer: layer,
    readinessProbe: readiness.probe,
    clock: clock.clock,
    sleep: clock.sleep,
    expectedDigests: {
      pristineValkeydbSha256: sha256Of(PRISTINE_CONTENTS),
      patchedValkeydbSha256: sha256Of(PATCHED_CONTENTS),
    },
  };
  const stateFile = join(root, MANAGED_RUNTIME_STATE_FILE);

  return {
    root,
    paths,
    venvRoot,
    venvLauncherPath,
    resolvedInterpreterPath,
    pyvenvCfgPath,
    sitePackagesPath,
    provisioner,
    layer,
    readiness,
    clock,
    stateFile,
    markerFile: join(root, MANAGED_RUNTIME_MARKER_FILE),
    dependencies,
    options: (overrides = {}) => ({
      paths,
      dependencies,
      ...overrides,
    }),
    stateRecord: () =>
      existsSync(stateFile)
        ? (JSON.parse(readFileSync(stateFile, "utf8")) as Record<
            string,
            unknown
          >)
        : null,
  };
}

async function provisionedFixture(): Promise<RuntimeFixture> {
  const fixture = createRuntimeFixture();
  const provision = await provisionManagedRuntime(fixture.options());
  expect(provision.outcome).toBe("provisioned");
  return fixture;
}

async function startedFixture(): Promise<{
  fixture: RuntimeFixture;
  pid: number;
}> {
  const fixture = await provisionedFixture();
  const started = await startManagedRuntime(fixture.options());
  expect(started.outcome).toBe("started");
  return { fixture, pid: started.status.pid ?? -1 };
}

/** Relative path -> content digest for every file below `root`. */
function snapshotDirectory(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      const key = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(child, key);
      else snapshot[key] = sha256Of(readFileSync(child, "utf8"));
    }
  };
  walk(root, "");
  return snapshot;
}

/**
 * Synthetic persisted record in any persisted-capable lifecycle state. It is
 * used to exercise the crash rule for states that no production writer emits
 * (`stopping`, `unverified`) and to re-cover the `starting` transient.
 */
function writeSyntheticStateRecord(
  fixture: RuntimeFixture,
  overrides: Record<string, unknown>,
): void {
  mkdirSync(dirname(fixture.stateFile), { recursive: true });
  writeFileSync(
    fixture.stateFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        state: "unverified",
        generation: 0,
        pinCommit: null,
        treeId: null,
        archiveSha256: null,
        patchSha256: null,
        patchedFileSha256: null,
        interpreterPath: null,
        interpreterSha256: null,
        checkoutPath: fixture.paths.checkoutPath,
        port: MANAGED_RUNTIME_PORT,
        endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
        childPid: null,
        childStartedAt: null,
        childExecutable: null,
        environmentKeys: [],
        lastReadiness: null,
        lastStop: null,
        lastCrash: null,
        lastRefusal: null,
        lockEvents: [],
        updatedAt: "2026-09-12T00:00:00.000Z",
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("Control Plane managed runtime lifecycle", () => {
  beforeEach(() => {
    delete process.env.TINYFISH_API_KEY;
    delete process.env.PYTHONDONTWRITEBYTECODE;
  });

  afterEach(() => {
    setManagedRuntimePortForTests(undefined);
    delete process.env.TINYFISH_API_KEY;
    delete process.env.PYTHONDONTWRITEBYTECODE;
    for (const root of temporaryRoots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A fixture that resisted deletion is reported by its own test.
      }
    }
  });

  it("carries the recorded port, host, and Stage C2/C3 digest constants", () => {
    expect(MANAGED_RUNTIME_PORT).toBe(18_099);
    expect(MANAGED_RUNTIME_HOST).toBe("127.0.0.1");
    expect(SEARXNG_PRISTINE_VALKEYDB_SHA256).toBe(
      "9c8330ecbd983d11f0972a741a8f80bff555dcbb08f00ac08022621c0870ca37",
    );
    expect(SEARXNG_PATCHED_VALKEYDB_SHA256).toBe(
      "288f9e284299033e6074fe3de577db4ae92dfc006973fd2771beca2078980658",
    );
    expect(defaultManagedRuntimeRoot()).toContain("UltraSearch");
  });

  it("provisions a staged root through the patch seam and is idempotent", async () => {
    const fixture = await provisionedFixture();

    expect(fixture.provisioner.calls).toHaveLength(1);
    expect(fixture.provisioner.calls[0]).toEqual({
      checkoutPath: fixture.paths.checkoutPath,
      patchPath: fixture.paths.patchPath,
      archivePath: fixture.paths.archivePath,
    });
    expect(existsSync(fixture.markerFile)).toBe(true);
    const record = fixture.stateRecord();
    expect(record).toMatchObject({
      schemaVersion: 1,
      state: "provisioned",
      generation: 0,
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
      port: MANAGED_RUNTIME_PORT,
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
    });

    const second = await provisionManagedRuntime(fixture.options());
    expect(second.outcome).toBe("already_provisioned");
    expect(second.status.state).toBe("provisioned");
    expect(fixture.provisioner.calls).toHaveLength(1);
    expect(readdirSync(dirname(fixture.stateFile))).toEqual([
      "managed-runtime.json",
    ]);
  });

  it("fails closed with the recorded digests when no test identity is injected", async () => {
    const fixture = createRuntimeFixture();
    const { expectedDigests, ...withoutTestIdentity } = fixture.dependencies;
    expect(expectedDigests?.patchedValkeydbSha256).toBe(
      sha256Of(PATCHED_CONTENTS),
    );

    const error = await expectRefusal(() =>
      provisionManagedRuntime({
        paths: fixture.paths,
        dependencies: withoutTestIdentity,
      }),
    );

    expect(error.code).toBe("patch_state_unknown");
    expect(fixture.provisioner.calls).toHaveLength(0);
  });

  it("delegates to the production helper, which refuses a synthetic checkout", async () => {
    const fixture = createRuntimeFixture();
    fixtureGit(fixture.paths.checkoutPath, ["init"]);
    fixtureGit(fixture.paths.checkoutPath, [
      "config",
      "core.autocrlf",
      "false",
    ]);
    fixtureGit(fixture.paths.checkoutPath, ["add", "-A"]);
    fixtureGit(fixture.paths.checkoutPath, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ]);
    const { applyWindowsPatch, ...withoutInjectedPatch } = fixture.dependencies;
    expect(applyWindowsPatch).toBeTypeOf("function");

    const error = await expectRefusal(() =>
      provisionManagedRuntime({
        paths: fixture.paths,
        dependencies: withoutInjectedPatch,
      }),
    );

    expect(error.code).toBe("provisioning_refused");
    expect(error.detail).toContain("pin_mismatch");
    expect(
      readFileSync(
        join(fixture.paths.checkoutPath, "searx", "valkeydb.py"),
        "utf8",
      ),
    ).toBe(PRISTINE_CONTENTS);
  });

  it("refuses a checkout whose valkeydb file matches neither recorded digest", async () => {
    const fixture = createRuntimeFixture();
    writeFileSync(
      join(fixture.paths.checkoutPath, "searx", "valkeydb.py"),
      "mutated\n",
      "utf8",
    );

    const error = await expectRefusal(() =>
      provisionManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("patch_state_unknown");
    expect(fixture.provisioner.calls).toHaveLength(0);
  });

  it("refuses a patched checkout without a verification record", async () => {
    const fixture = createRuntimeFixture();
    writeFileSync(
      join(fixture.paths.checkoutPath, "searx", "valkeydb.py"),
      PATCHED_CONTENTS,
      "utf8",
    );

    const error = await expectRefusal(() =>
      provisionManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("patch_state_unknown");
    expect(fixture.provisioner.calls).toHaveLength(0);
    // A refusal never creates state artifacts where no record exists yet.
    expect(fixture.stateRecord()).toBeNull();
  });

  it("refuses missing checkout, archive, patch, and interpreter artifacts", async () => {
    const missingCheckout = createRuntimeFixture();
    rmSync(join(missingCheckout.paths.checkoutPath, "searx", "valkeydb.py"));
    const checkoutError = await expectRefusal(() =>
      provisionManagedRuntime(missingCheckout.options()),
    );
    expect(checkoutError.code).toBe("checkout_missing");

    const missingArchive = createRuntimeFixture();
    rmSync(missingArchive.paths.archivePath);
    const archiveError = await expectRefusal(() =>
      provisionManagedRuntime(missingArchive.options()),
    );
    expect(archiveError.code).toBe("archive_missing");

    const missingPatch = createRuntimeFixture();
    rmSync(missingPatch.paths.patchPath);
    const patchError = await expectRefusal(() =>
      provisionManagedRuntime(missingPatch.options()),
    );
    expect(patchError.code).toBe("patch_missing");

    const missingInterpreter = createRuntimeFixture();
    rmSync(missingInterpreter.resolvedInterpreterPath);
    const interpreterError = await expectRefusal(() =>
      provisionManagedRuntime(missingInterpreter.options()),
    );
    expect(interpreterError.code).toBe("interpreter_missing");
    expect(missingInterpreter.provisioner.calls).toHaveLength(0);
  });

  it("carries a provisioning refusal verbatim", async () => {
    const fixture = createRuntimeFixture();
    const refusing = createFakeProvisioner("refuse");
    const error = await expectRefusal(() =>
      provisionManagedRuntime({
        paths: fixture.paths,
        dependencies: {
          ...fixture.dependencies,
          applyWindowsPatch: refusing.apply,
        },
      }),
    );

    expect(error.code).toBe("provisioning_refused");
    expect(error.detail).toContain("apply_failed");
    expect(refusing.calls).toHaveLength(1);
  });

  it("refuses non-isolated managed roots", async () => {
    const driveRoot = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(parse(tmpdir()).root),
      }),
    );
    expect(driveRoot.code).toBe("managed_root_refused");

    const homeRoot = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(homedir()),
      }),
    );
    expect(homeRoot.code).toBe("managed_root_refused");

    const installationRoot = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(join(REPOSITORY_ROOT, "runtime")),
      }),
    );
    expect(installationRoot.code).toBe("managed_root_refused");

    const repository = mkdtempSync(join(tmpdir(), "ultrasearch-runtime-repo-"));
    temporaryRoots.push(repository);
    fixtureGit(repository, ["init"]);
    const gitWorkingTree = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(repository),
      }),
    );
    expect(gitWorkingTree.code).toBe("managed_root_refused");
  });

  it("refuses a reparse point as the managed root", async (context) => {
    const target = mkdtempSync(join(tmpdir(), "ultrasearch-runtime-target-"));
    temporaryRoots.push(target);
    const link = `${target}-junction`;
    try {
      symlinkSync(target, link, "junction");
    } catch (error) {
      context.skip(
        `host cannot create a junction, so the root reparse check is unproven here: ${String(error)}`,
      );
    }
    temporaryRoots.push(link);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(link),
      }),
    );

    expect(error.code).toBe("managed_root_refused");
  });

  it("refuses a managed root below an ancestor reparse point", async (context) => {
    const target = mkdtempSync(
      join(tmpdir(), "ultrasearch-runtime-ancestor-target-"),
    );
    temporaryRoots.push(target);
    const link = `${target}-ancestor-junction`;
    try {
      symlinkSync(target, link, "junction");
    } catch (error) {
      context.skip(
        `host cannot create a junction, so the ancestor reparse check is unproven here: ${String(error)}`,
      );
    }
    temporaryRoots.push(link);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(join(link, "runtime")),
      }),
    );

    expect(error.code).toBe("managed_root_refused");
  });

  it("refuses a case-variant home root on a case-insensitive filesystem", async (context) => {
    if (process.platform !== "win32") {
      context.skip(
        "case-insensitive path comparison applies to the Windows (NTFS) host only",
      );
    }
    const home = homedir();
    const variant = home.toUpperCase();

    const error = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(variant),
      }),
    );

    expect(error.code).toBe("managed_root_refused");
  });

  it("refuses a corrupt or schema-invalid state file", async () => {
    const corrupt = createRuntimeFixture();
    mkdirSync(dirname(corrupt.stateFile), { recursive: true });
    writeFileSync(corrupt.stateFile, "{not json", "utf8");
    const corruptError = await expectRefusal(() =>
      readManagedRuntimeStatus(corrupt.options()),
    );
    expect(corruptError.code).toBe("state_corrupt");

    const invalid = createRuntimeFixture();
    mkdirSync(dirname(invalid.stateFile), { recursive: true });
    writeFileSync(
      invalid.stateFile,
      JSON.stringify({ schemaVersion: 2 }),
      "utf8",
    );
    const startError = await expectRefusal(() =>
      startManagedRuntime(invalid.options()),
    );
    expect(startError.code).toBe("state_corrupt");
  });

  it("refuses a mutating operation while a live lock is held", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.registerProcess(812_345);
    writeFileSync(
      join(fixture.root, MANAGED_RUNTIME_LOCK_FILE),
      JSON.stringify({ pid: 812_345, at: "2026-09-12T00:00:00.000Z" }),
      "utf8",
    );

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("state_conflict");
    expect(fixture.layer.spawned).toHaveLength(0);
    // A refusal raised before the lock is acquired writes nothing.
    expect(fixture.stateRecord()).toMatchObject({ state: "provisioned" });
  });

  it("clears a dead lock only in repair and records the event", async () => {
    const fixture = await provisionedFixture();
    writeFileSync(
      join(fixture.root, MANAGED_RUNTIME_LOCK_FILE),
      JSON.stringify({ pid: 999_999, at: "2026-09-12T00:00:00.000Z" }),
      "utf8",
    );

    const repaired = await repairManagedRuntime(fixture.options());

    expect(repaired.outcome).toBe("already_provisioned");
    expect(fixture.stateRecord()?.lockEvents).toMatchObject([
      { pid: 999_999, reason: "dead_lock_cleared" },
    ]);
    expect(existsSync(join(fixture.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );
  });

  it("persists a repair refusal over the existing record", async () => {
    const fixture = await provisionedFixture();
    rmSync(fixture.resolvedInterpreterPath);

    const error = await expectRefusal(() =>
      repairManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("interpreter_missing");
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "interpreter_missing" },
    });
  });

  it("starts the recorded interpreter with a strict allowlisted environment", async () => {
    process.env.TINYFISH_API_KEY = "canary-provider-key";
    const fixture = await provisionedFixture();

    const started = await startManagedRuntime(fixture.options());

    expect(started.outcome).toBe("started");
    expect(started.status).toMatchObject({
      state: "running",
      generation: 1,
      pid: fixture.layer.lastPid,
      ownership: "ultrasearch_managed",
      port: MANAGED_RUNTIME_PORT,
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
      lastReadiness: {
        status: 200,
        at: "2026-09-12T00:00:00.000Z",
        elapsedMs: 0,
      },
    });
    expect(fixture.readiness.calls).toEqual([
      `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}/`,
    ]);

    const spawn = fixture.layer.spawned[0];
    expect(spawn?.pid).toBe(fixture.layer.lastPid);
    expect(spawn?.request.executablePath).toBe(fixture.resolvedInterpreterPath);
    expect(spawn?.request.executablePath).not.toBe(fixture.venvLauncherPath);
    // The `-B` launch flag is the belt half of the bytecode-write guard: the
    // child must not write bytecode into `.venv` (`DQ-036` R1).
    expect(spawn?.request.args).toEqual(["-B", "-m", "searx.webapp"]);
    expect(spawn?.request.cwd).toBe(fixture.paths.checkoutPath);
    const environment = spawn?.request.environment ?? {};
    expect(environment.TEMP).toBe(join(fixture.root, "tmp"));
    expect(environment.TMP).toBe(join(fixture.root, "tmp"));
    // Site-packages derive from the venv root, never from the interpreter path.
    expect(environment.PYTHONPATH).toBe(fixture.sitePackagesPath);
    expect(environment.PYTHONPATH).toBe(
      join(fixture.venvRoot, "Lib", "site-packages"),
    );
    const interpreterDerivedSitePackages = join(
      dirname(dirname(fixture.resolvedInterpreterPath)),
      "Lib",
      "site-packages",
    );
    expect(environment.PYTHONPATH).not.toBe(interpreterDerivedSitePackages);
    // The value is bound to the constant "1" by the module - not sourced from
    // ambient `process.env` - because the child must not write bytecode into
    // `.venv` (`DQ-036` R1).
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(environment.SEARXNG_SETTINGS_PATH).toBe(
      join(fixture.paths.checkoutPath, "searx", "settings.yml"),
    );
    expect(environment.SEARXNG_DISABLE_ETC_SETTINGS).toBe("1");
    expect(environment).not.toHaveProperty("SEARXNG_PORT");
    expect(environment).not.toHaveProperty("SEARXNG_BIND");
    expect(environment.SEARXNG_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(environment).not.toHaveProperty("TINYFISH_API_KEY");
    expect(environment).not.toHaveProperty("ULTRASEARCH_TINYFISH_API_KEY");

    const stateText = readFileSync(fixture.stateFile, "utf8");
    const secret = environment.SEARXNG_SECRET ?? "";
    expect(stateText).not.toContain(secret);
    expect(stateText).not.toContain("canary-provider-key");
    expect(fixture.stateRecord()).toMatchObject({
      state: "running",
      generation: 1,
      childPid: fixture.layer.lastPid,
      childExecutable: fixture.resolvedInterpreterPath,
    });
    expect(fixture.stateRecord()?.environmentKeys).toContain("SEARXNG_SECRET");
    expect(fixture.stateRecord()?.environmentKeys).toContain(
      "PYTHONDONTWRITEBYTECODE",
    );
    expect(readdirSync(dirname(fixture.stateFile))).toEqual([
      "managed-runtime.json",
    ]);
  });

  it("uses an explicitly supplied caller-staged settings path and keeps fixed readiness", async () => {
    const fixture = await provisionedFixture();
    const settingsPath = join(fixture.root, "searxng-settings.yml");
    writeFileSync(
      settingsPath,
      [
        "server:",
        '  bind_address: "127.0.0.1"',
        "  port: 18099",
        "search:",
        "  formats:",
        "    - html",
        "    - json",
        "use_default_settings:",
        "  engines:",
        "    keep_only:",
        "      - wikipedia",
        "      - bing",
        "      - duckduckgo",
        "",
      ].join("\n"),
      "utf8",
    );

    const started = await startManagedRuntime(
      fixture.options({ settingsPath }),
    );

    expect(started.outcome).toBe("started");
    const environment = fixture.layer.spawned[0]?.request.environment ?? {};
    expect(environment.SEARXNG_SETTINGS_PATH).toBe(settingsPath);
    expect(environment).not.toHaveProperty("SEARXNG_PORT");
    expect(environment).not.toHaveProperty("SEARXNG_BIND");
    expect(fixture.readiness.calls).toEqual([
      `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}/`,
    ]);
  });

  it("binds PYTHONDONTWRITEBYTECODE=1 in the child env when the ambient variable is unset", async () => {
    // child must not write bytecode into `.venv` (`DQ-036` R1): the value is
    // bound by the module's child-env builder, not inherited, so an unset
    // ambient variable cannot leave the child unprotected.
    delete process.env.PYTHONDONTWRITEBYTECODE;
    const fixture = await provisionedFixture();
    const started = await startManagedRuntime(fixture.options());
    expect(started.outcome).toBe("started");
    const environment = fixture.layer.spawned[0]?.request.environment ?? {};
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
  });

  it("binds PYTHONDONTWRITEBYTECODE=1 in the child env when the ambient variable is set to something else", async () => {
    // child must not write bytecode into `.venv` (`DQ-036` R1): the allowlist
    // value is bound to the constant "1" in the builder, so an ambient "0"
    // must never be forwarded into the child environment.
    process.env.PYTHONDONTWRITEBYTECODE = "0";
    const fixture = await provisionedFixture();
    const started = await startManagedRuntime(fixture.options());
    expect(started.outcome).toBe("started");
    const environment = fixture.layer.spawned[0]?.request.environment ?? {};
    expect(environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    // The lifecycle never mutates the ambient variable itself.
    expect(process.env.PYTHONDONTWRITEBYTECODE).toBe("0");
  });

  it("passes -B to the process layer so the child cannot write bytecode into .venv", async () => {
    const fixture = await provisionedFixture();
    const started = await startManagedRuntime(fixture.options());
    expect(started.outcome).toBe("started");
    // child must not write bytecode into `.venv` (`DQ-036` R1): `-B` is the
    // belt half of the guard and must be on the args handed to the spawn.
    const args = fixture.layer.spawned[0]?.request.args ?? [];
    expect(args).toContain("-B");
    expect(args).toEqual(["-B", "-m", "searx.webapp"]);
  });

  it("resolves the base interpreter from pyvenv.cfg and records its digest, never the venv launcher", async () => {
    const fixture = await provisionedFixture();

    expect(fixture.stateRecord()).toMatchObject({
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
    });
    expect(fixture.stateRecord()?.interpreterPath).not.toBe(
      fixture.venvLauncherPath,
    );
    // The launcher is still staged and byte-identical: it was read past, not
    // replaced, copied, or deleted.
    expect(readFileSync(fixture.venvLauncherPath, "utf8")).toBe(
      VENV_LAUNCHER_CONTENTS,
    );

    const status = await readManagedRuntimeStatus(fixture.options());
    expect(status.verification?.interpreterPath).toBe(
      fixture.resolvedInterpreterPath,
    );
  });

  it("accepts an explicit resolved-interpreter override and refuses the venv launcher as an override", async () => {
    const overridden = createRuntimeFixture();
    rmSync(overridden.pyvenvCfgPath);

    const provisioned = await provisionManagedRuntime(
      overridden.options({
        paths: {
          ...overridden.paths,
          interpreterPath: overridden.resolvedInterpreterPath,
        },
      }),
    );

    expect(provisioned.outcome).toBe("provisioned");
    expect(overridden.stateRecord()).toMatchObject({
      interpreterPath: overridden.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
    });

    const launcher = createRuntimeFixture();
    rmSync(launcher.pyvenvCfgPath);
    const error = await expectRefusal(() =>
      provisionManagedRuntime(
        launcher.options({
          paths: {
            ...launcher.paths,
            interpreterPath: launcher.venvLauncherPath,
          },
        }),
      ),
    );

    expect(error.code).toBe("interpreter_redirector_detected");
    expect(error.detail).toContain(launcher.venvLauncherPath);
    expect(launcher.provisioner.calls).toHaveLength(0);
    expect(launcher.stateRecord()).toBeNull();
  });

  it("refuses a venv that cannot resolve an unambiguous base interpreter", async () => {
    const noConfig = createRuntimeFixture();
    rmSync(noConfig.pyvenvCfgPath);
    const missingConfig = await expectRefusal(() =>
      provisionManagedRuntime(noConfig.options()),
    );
    expect(missingConfig.code).toBe("interpreter_missing");
    expect(noConfig.provisioner.calls).toHaveLength(0);

    const launcherHome = createRuntimeFixture();
    writeFileSync(
      launcherHome.pyvenvCfgPath,
      `home = ${join(launcherHome.venvRoot, "Scripts")}\n`,
      "utf8",
    );
    const redirector = await expectRefusal(() =>
      provisionManagedRuntime(launcherHome.options()),
    );
    expect(redirector.code).toBe("interpreter_redirector_detected");

    const ambiguous = createRuntimeFixture();
    writeFileSync(
      ambiguous.pyvenvCfgPath,
      `home = ${dirname(ambiguous.resolvedInterpreterPath)}\nexecutable = ${ambiguous.venvLauncherPath}\n`,
      "utf8",
    );
    const ambiguousError = await expectRefusal(() =>
      provisionManagedRuntime(ambiguous.options()),
    );
    expect(ambiguousError.code).toBe("interpreter_missing");
    expect(ambiguousError.detail).toContain("ambiguous");
    expect(ambiguous.provisioner.calls).toHaveLength(0);
  });

  it("performs zero writes inside the venv tree across provision, start, stop, and repair", async () => {
    const fixture = createRuntimeFixture();
    const before = snapshotDirectory(fixture.venvRoot);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const provisioned = await provisionManagedRuntime(fixture.options());
    expect(provisioned.outcome).toBe("provisioned");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);

    const started = await startManagedRuntime(fixture.options());
    expect(started.outcome).toBe("started");
    // The mechanism behind this snapshot equality is in effect on the spawn
    // that just ran: `-B` plus the bound `PYTHONDONTWRITEBYTECODE=1` - child
    // must not write bytecode into `.venv` (`DQ-036` R1).
    const spawn = fixture.layer.spawned[0]?.request;
    expect(spawn?.args).toContain("-B");
    expect(spawn?.environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);

    const stopped = await stopManagedRuntime(fixture.options());
    expect(stopped.outcome).toBe("stopped");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);

    // A second full start/stop cycle (generation 2) must leave the venv tree
    // byte-identical too, with the same bytecode guard on its spawn.
    const restarted = await startManagedRuntime(fixture.options());
    expect(restarted.outcome).toBe("started");
    const secondSpawn = fixture.layer.spawned[1]?.request;
    expect(secondSpawn?.args).toContain("-B");
    expect(secondSpawn?.environment.PYTHONDONTWRITEBYTECODE).toBe("1");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);

    const stoppedAgain = await stopManagedRuntime(fixture.options());
    expect(stoppedAgain.outcome).toBe("stopped");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);

    const repaired = await repairManagedRuntime(fixture.options());
    expect(repaired.outcome).toBe("already_provisioned");
    expect(snapshotDirectory(fixture.venvRoot)).toEqual(before);
  });

  it("refuses a recorded interpreter that resolves to a redirector launcher", async () => {
    const substituted = await provisionedFixture();
    writeFileSync(
      substituted.resolvedInterpreterPath,
      VENV_LAUNCHER_CONTENTS,
      "utf8",
    );
    const substitutedError = await expectRefusal(() =>
      startManagedRuntime(substituted.options()),
    );
    expect(substitutedError.code).toBe("interpreter_redirector_detected");
    expect(substitutedError.detail).toContain("redirector");
    expect(substituted.layer.spawned).toHaveLength(0);
    expect(substituted.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "interpreter_redirector_detected" },
    });

    const recorded = await provisionedFixture();
    const state = JSON.parse(
      readFileSync(recorded.stateFile, "utf8"),
    ) as Record<string, unknown>;
    state.interpreterPath = recorded.venvLauncherPath;
    state.interpreterSha256 = sha256Of(VENV_LAUNCHER_CONTENTS);
    writeFileSync(
      recorded.stateFile,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    const launcherError = await expectRefusal(() =>
      startManagedRuntime(recorded.options()),
    );
    expect(launcherError.code).toBe("interpreter_redirector_detected");
    expect(launcherError.detail).toContain(recorded.venvLauncherPath);
    expect(recorded.layer.spawned).toHaveLength(0);
  });

  it("keeps listener_invariant_violated as the B-2 backstop for a forking launcher image", async () => {
    const fixture = await provisionedFixture();
    // The staged file matches the recorded digest but behaves like the venv
    // redirector: the spawned image forks the process that owns the listener.
    writeFileSync(
      fixture.resolvedInterpreterPath,
      VENV_LAUNCHER_CONTENTS,
      "utf8",
    );
    const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    state.interpreterSha256 = sha256Of(VENV_LAUNCHER_CONTENTS);
    writeFileSync(
      fixture.stateFile,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );
    fixture.layer.listenerMode = "foreign";

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("listener_invariant_violated");
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "listener_invariant_violated" },
    });
  });

  it("refuses a post-spawn identity mismatch before readiness and stops the child", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.spawnExecutableOverride = fixture.venvLauncherPath;

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("interpreter_redirector_detected");
    expect(error.detail).toContain(fixture.venvLauncherPath);
    expect(fixture.readiness.calls).toHaveLength(0);
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
      lastRefusal: { code: "interpreter_redirector_detected" },
    });
  });

  it("upgrades a pre-repair record without a resolved-interpreter digest through repair", async () => {
    const fixture = await provisionedFixture();
    const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    state.interpreterPath = fixture.venvLauncherPath;
    state.interpreterSha256 = null;
    writeFileSync(
      fixture.stateFile,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    const startError = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );
    expect(startError.code).toBe("interpreter_missing");
    expect(fixture.layer.spawned).toHaveLength(0);

    const repaired = await repairManagedRuntime(fixture.options());
    expect(repaired.outcome).toBe("already_provisioned");
    expect(fixture.stateRecord()).toMatchObject({
      state: "provisioned",
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
    });
  });

  it("reports already_running without spawning a second child", async () => {
    const { fixture } = await startedFixture();

    const second = await startManagedRuntime(fixture.options());

    expect(second.outcome).toBe("already_running");
    expect(second.status.state).toBe("running");
    expect(fixture.layer.spawned).toHaveLength(1);
  });

  it("refuses to start from a failed record before repair or cleanup", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.spawnBehavior = "fail";

    const failed = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );
    expect(failed.code).toBe("spawn_failed");
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "spawn_failed" },
    });

    const refused = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );
    expect(refused.code).toBe("already_failed");
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "already_failed" },
    });

    const repaired = await repairManagedRuntime(fixture.options());
    expect(repaired.outcome).toBe("already_provisioned");
    expect(repaired.status.state).toBe("provisioned");

    fixture.layer.spawnBehavior = "ok";
    const restarted = await startManagedRuntime(fixture.options());
    expect(restarted.outcome).toBe("started");
  });

  it("refuses start when the checkout digest drifted after provisioning", async () => {
    const fixture = await provisionedFixture();
    writeFileSync(
      join(fixture.paths.checkoutPath, "searx", "valkeydb.py"),
      `${PATCHED_CONTENTS}# drift\n`,
      "utf8",
    );

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("patch_state_unknown");
    expect(fixture.layer.spawned).toHaveLength(0);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "patch_state_unknown" },
    });
  });

  it("refuses start when the recorded interpreter is missing", async () => {
    const fixture = await provisionedFixture();
    rmSync(fixture.resolvedInterpreterPath);

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("interpreter_missing");
    expect(fixture.layer.spawned).toHaveLength(0);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "interpreter_missing" },
    });
  });

  it("refuses start when a foreign listener owns the port", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.addForeignListener();

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("port_in_use_foreign");
    expect(fixture.layer.spawned).toHaveLength(0);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "port_in_use_foreign" },
    });
  });

  it("refuses every lifecycle operation including status on a non-Windows platform", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.platform = "linux";

    for (const operation of [
      () => provisionManagedRuntime(fixture.options()),
      () => repairManagedRuntime(fixture.options()),
      () => startManagedRuntime(fixture.options()),
      () => stopManagedRuntime(fixture.options()),
      () => reconcileManagedRuntime(fixture.options()),
      () => readManagedRuntimeStatus(fixture.options()),
      () => cleanupManagedRuntime(fixture.options()),
    ]) {
      const error = await expectRefusal(operation);
      expect(error.code).toBe("unsupported_platform");
    }
    // The record is untouched: an unsupported platform refuses before mutating.
    expect(fixture.stateRecord()).toMatchObject({ state: "provisioned" });

    // The one documented exception: an absent root is already absent.
    const absent = createRuntimeFixture();
    absent.layer.platform = "linux";
    rmSync(absent.root, { recursive: true, force: true });
    const cleaned = await cleanupManagedRuntime(absent.options());
    expect(cleaned.outcome).toBe("already_absent");
  });

  it("refuses a spawn that fails or returns no pid", async () => {
    const failing = await provisionedFixture();
    failing.layer.spawnBehavior = "fail";
    const failure = await expectRefusal(() =>
      startManagedRuntime(failing.options()),
    );
    expect(failure.code).toBe("spawn_failed");

    const pidless = await provisionedFixture();
    pidless.layer.spawnBehavior = "no_pid";
    const noPid = await expectRefusal(() =>
      startManagedRuntime(pidless.options()),
    );
    expect(noPid.code).toBe("spawn_failed");
    expect(pidless.stateRecord()).toMatchObject({ state: "failed" });
  });

  it("stops and records a just-spawned child when the inspector fails before the starting record", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.inspectFailuresRemaining = 1;

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("spawn_failed");
    expect(error.detail).toContain("could not be inspected");
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(
      fixture.layer.rootScopedSurvivors({
        managedRoot: fixture.root,
        recordedChildPid: fixture.layer.lastPid,
      }),
    ).toEqual({
      survivorsPresent: false,
      survivorPids: [],
      unverifiableReason: null,
    });
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
      lastRefusal: { code: "spawn_failed" },
    });
  });

  it("times out readiness and stops the child it spawned", async () => {
    const fixture = await provisionedFixture();
    fixture.readiness = createReadinessScript(["reject"]);
    fixture.dependencies.readinessProbe = fixture.readiness.probe;

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("readiness_timeout");
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
      lastRefusal: { code: "readiness_timeout" },
    });
  });

  it("refuses a readiness probe that reports a 500 or above", async () => {
    const fixture = await provisionedFixture();
    fixture.readiness = createReadinessScript([503]);
    fixture.dependencies.readinessProbe = fixture.readiness.probe;

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("readiness_rejected");
    expect(fixture.layer.terminations).toHaveLength(1);
    expect(fixture.stateRecord()).toMatchObject({ state: "failed" });
  });

  it("refuses a listener reported on the wildcard address 0.0.0.0", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.listenerMode = "wildcard";

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("listener_invariant_violated");
    expect(error.detail).toContain("0.0.0.0:18099");
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "listener_invariant_violated" },
    });
  });

  it("refuses zero, duplicated, foreign-owner, or wildcard listeners after readiness", async () => {
    for (const listenerMode of [
      "zero",
      "two",
      "foreign",
      "wildcard",
    ] as const) {
      const fixture = await provisionedFixture();
      fixture.layer.listenerMode = listenerMode;

      const error = await expectRefusal(() =>
        startManagedRuntime(fixture.options()),
      );

      expect(error.code).toBe("listener_invariant_violated");
      expect(fixture.layer.terminations).toEqual([
        { pid: fixture.layer.lastPid, mode: "terminate" },
      ]);
      expect(fixture.stateRecord()).toMatchObject({
        state: "failed",
        lastRefusal: { code: "listener_invariant_violated" },
      });
    }
  });

  it("stops only the verified recorded child and confirms the exit", async () => {
    const { fixture, pid } = await startedFixture();

    const stopped = await stopManagedRuntime(fixture.options());

    expect(stopped.outcome).toBe("stopped");
    expect(stopped.status.state).toBe("provisioned");
    expect(fixture.layer.terminations).toEqual([{ pid, mode: "terminate" }]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "provisioned",
      childPid: null,
      lastStop: { at: "2026-09-12T00:00:00.000Z", method: "terminate" },
    });
    expect(await fixture.layer.listenersOnPort(MANAGED_RUNTIME_PORT)).toEqual(
      [],
    );
  });

  it("escalates to a forced stop when the child ignores termination", async () => {
    const { fixture, pid } = await startedFixture();
    fixture.layer.terminateBehavior = "exits_on_force";

    const stopped = await stopManagedRuntime(fixture.options());

    expect(stopped.outcome).toBe("stopped");
    expect(fixture.layer.terminations).toEqual([
      { pid, mode: "terminate" },
      { pid, mode: "force" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      lastStop: { method: "force" },
      childPid: null,
    });
  });

  it("reports already_stopped for a provisioned or absent record", async () => {
    const { fixture } = await startedFixture();
    await stopManagedRuntime(fixture.options());

    const stoppedAgain = await stopManagedRuntime(fixture.options());
    expect(stoppedAgain.outcome).toBe("already_stopped");
    expect(stoppedAgain.note).toBe("the managed runtime is not running");

    const fresh = createRuntimeFixture();
    const absent = await stopManagedRuntime(fresh.options());
    expect(absent.outcome).toBe("already_stopped");
    expect(absent.status.state).toBe("absent");
    expect(fresh.layer.terminations).toHaveLength(0);
  });

  it("refuses to stop a pid whose identity no longer matches", async () => {
    const { fixture, pid } = await startedFixture();
    fixture.layer.replaceChildIdentity(pid);

    const error = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("pid_identity_mismatch");
    expect(fixture.layer.terminations).toHaveLength(0);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "pid_identity_mismatch" },
    });
  });

  it("refuses stop_timeout when the child survives both termination attempts", async () => {
    const { fixture, pid } = await startedFixture();
    fixture.layer.terminateBehavior = "stubborn";

    const error = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("stop_timeout");
    expect(fixture.layer.terminations).toEqual([
      { pid, mode: "terminate" },
      { pid, mode: "force" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "stop_timeout" },
    });
  });

  it("refuses stop_unverified when a listener or survivor remains", async () => {
    const { fixture } = await startedFixture();
    fixture.layer.leaveListenersAfterTerminate = true;

    const error = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("stop_unverified");
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "stop_unverified" },
    });
  });

  it("restarts with a new generation and a new recorded child", async () => {
    const { fixture, pid } = await startedFixture();

    const restarted = await restartManagedRuntime(fixture.options());

    expect(restarted.outcome).toBe("restarted");
    expect(restarted.status).toMatchObject({ state: "running", generation: 2 });
    expect(restarted.status.pid).not.toBe(pid);
    expect(fixture.layer.spawned).toHaveLength(2);
  });

  it("reconciles a crashed child to a persisted stale record", async () => {
    const { fixture } = await startedFixture();
    fixture.layer.crashChild();

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { detection: "child_not_running" },
    });
    expect(fixture.layer.terminations).toHaveLength(0);
  });

  it("passes a loopback listener at start and reconciles a wildcard address to stale", async () => {
    // startedFixture asserts the loopback listener passes the start invariant.
    const { fixture } = await startedFixture();

    fixture.layer.setListenerAddress("0.0.0.0");
    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { detection: "listener_invariant_violated" },
    });
    expect(fixture.layer.terminations).toHaveLength(0);
  });

  it("computes stale without writing in the read-only status", async () => {
    const { fixture } = await startedFixture();
    const before = readFileSync(fixture.stateFile, "utf8");
    fixture.layer.crashChild();

    const status = await readManagedRuntimeStatus(fixture.options());

    expect(status.state).toBe("stale");
    expect(status.pid).toBe(fixture.layer.lastPid);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
  });

  it("recovers a stale record on start and keeps the crash history", async () => {
    const { fixture } = await startedFixture();
    fixture.layer.crashChild();
    await reconcileManagedRuntime(fixture.options());

    const restarted = await startManagedRuntime(fixture.options());

    expect(restarted.outcome).toBe("started");
    expect(restarted.status).toMatchObject({ state: "running", generation: 2 });
    expect(fixture.stateRecord()?.lastCrash).not.toBeNull();
    expect(fixture.layer.spawned).toHaveLength(2);
  });

  it("treats a persisted starting record as stale on reconcile (the start writer's transient)", async () => {
    const fixture = createRuntimeFixture();
    writeSyntheticStateRecord(fixture, {
      state: "starting",
      childPid: 77_001,
      childExecutable: fixture.resolvedInterpreterPath,
    });

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { detection: "persisted_starting_transient" },
    });
  });

  it("treats a persisted stopping record as stale on reconcile (no writer persists stopping)", async () => {
    const fixture = createRuntimeFixture();
    writeSyntheticStateRecord(fixture, {
      state: "stopping",
      childPid: 77_002,
      childExecutable: fixture.resolvedInterpreterPath,
    });

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { detection: "persisted_stopping_transient" },
    });
  });

  it("keeps a persisted unverified record read-only (no writer persists unverified) until provision re-provisions it", async () => {
    const fixture = createRuntimeFixture();
    writeFileSync(fixture.markerFile, "{}\n", "utf8");
    writeSyntheticStateRecord(fixture, { state: "unverified" });
    const before = readFileSync(fixture.stateFile, "utf8");

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("unverified");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);

    const provisioned = await provisionManagedRuntime(fixture.options());
    expect(provisioned.outcome).toBe("provisioned");
    expect(provisioned.status.state).toBe("provisioned");
  });

  it("reports an absent managed root without creating anything", async () => {
    const fixture = createRuntimeFixture();

    const status = await readManagedRuntimeStatus(fixture.options());

    expect(status).toMatchObject({
      state: "absent",
      pid: null,
      generation: 0,
      ownership: "none",
      verification: null,
      stateFile: fixture.stateFile,
    });
    expect(existsSync(join(fixture.root, "state"))).toBe(false);
  });

  it("deletes the managed root with a deletion proof and is idempotent", async () => {
    const fixture = await provisionedFixture();

    const cleaned = await cleanupManagedRuntime(fixture.options());

    expect(cleaned).toMatchObject({
      outcome: "deleted",
      managedRoot: fixture.root,
      lastState: "provisioned",
      pathAbsent: true,
      port: MANAGED_RUNTIME_PORT,
      listenersAfter: 0,
      survivorPids: [],
      clearedLockPids: [],
    });
    expect(existsSync(fixture.root)).toBe(false);

    const again = await cleanupManagedRuntime(fixture.options());
    expect(again.outcome).toBe("already_absent");
    expect(again.pathAbsent).toBe(true);
  });

  it("retries a transient EPERM whole-root deletion and proves cleanup after success", async () => {
    const fixture = await provisionedFixture();
    const sleeps: number[] = [];
    let calls = 0;
    fixture.dependencies.sleep = async (milliseconds) => {
      sleeps.push(milliseconds);
    };
    fixture.dependencies.removeRoot = (path) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("EPERM fixture"), {
          code: "EPERM",
          errno: -4048,
          syscall: "unlink",
          path: join(fixture.venvRoot, "locked.pyd"),
        });
      }
      rmSync(path, { recursive: true, force: true });
    };

    const cleaned = await cleanupManagedRuntime(fixture.options());

    expect(calls).toBe(2);
    expect(sleeps).toEqual([100]);
    expect(cleaned).toMatchObject({
      outcome: "deleted",
      pathAbsent: true,
      listenersAfter: 0,
      survivorPids: [],
    });
    expect(existsSync(fixture.root)).toBe(false);
    expect(existsSync(fixture.markerFile)).toBe(false);
  });

  it("bounds persistent EPERM cleanup, preserves the cause, and restores the marker", async () => {
    const fixture = await provisionedFixture();
    const sleeps: number[] = [];
    let calls = 0;
    const lockedPath = join(
      fixture.venvRoot,
      "Lib",
      "site-packages",
      "markupsafe",
      "_speedups.cp312-win_amd64.pyd",
    );
    fixture.dependencies.sleep = async (milliseconds) => {
      sleeps.push(milliseconds);
    };
    fixture.dependencies.removeRoot = () => {
      calls += 1;
      rmSync(fixture.markerFile, { force: true });
      throw Object.assign(
        new Error(`EPERM: operation not permitted, unlink '${lockedPath}'`),
        { code: "EPERM", errno: -4048, syscall: "unlink", path: lockedPath },
      );
    };

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(calls).toBe(8);
    expect(sleeps).toEqual([100, 250, 500, 1_000, 2_000, 4_000, 8_000]);
    expect(error.code).toBe("cleanup_incomplete");
    expect(error.detail).toContain("pathAbsent=false");
    expect(error.detail).toContain("code=EPERM");
    expect(error.detail).toContain("errno=-4048");
    expect(error.detail).toContain("syscall=unlink");
    expect(error.detail).toContain(lockedPath);
    expect((error.cause as { code?: unknown }).code).toBe("EPERM");
    expect(existsSync(fixture.root)).toBe(true);
    expect(existsSync(fixture.markerFile)).toBe(true);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "cleanup_incomplete" },
    });
  });

  it("refuses cleanup of a directory without the managed marker and leaves it byte-identical", async () => {
    const fixture = createRuntimeFixture();
    mkdirSync(join(fixture.root, "searxng"), { recursive: true });
    const before = snapshotDirectory(fixture.root);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("root_marker_missing");
    expect(existsSync(fixture.root)).toBe(true);
    expect(existsSync(join(fixture.root, "state"))).toBe(false);
    expect(existsSync(join(fixture.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );
    expect(snapshotDirectory(fixture.root)).toEqual(before);
  });

  it("refuses cleanup while the recorded child is active", async () => {
    const { fixture } = await startedFixture();

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("cleanup_refused");
    expect(existsSync(fixture.paths.managedRoot)).toBe(true);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "cleanup_refused" },
    });
  });

  it("refuses cleanup_incomplete when the deletion proof fails", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.listenerScript = [
      [],
      [
        {
          address: MANAGED_RUNTIME_HOST,
          port: MANAGED_RUNTIME_PORT,
          pid: 900_002,
        },
      ],
    ];

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("cleanup_incomplete");
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("control A: a foreign same-image process with no root reference is not a survivor", async () => {
    const { fixture, pid } = await startedFixture();
    // The pre-flight regression, modeled on the real-world case: a long-lived
    // host process runs the exact recorded interpreter image with an
    // unrelated command line and no reference to the managed root.
    const foreign: ManagedRuntimeProcessCandidate = {
      pid: 910_001,
      parentPid: 910_000,
      executablePath: fixture.resolvedInterpreterPath,
      commandLine:
        '"C:\\tools\\codex-router\\.venv\\Scripts\\litellm.exe" --config C:\\tools\\codex-router\\litellm.yaml --host 127.0.0.1 --port 4200',
    };

    // Unit-level: the module's own predicate over the modeled row is
    // conclusive zero survivors despite the equal image path.
    expect(
      rootScopedSurvivors([foreign], {
        managedRoot: fixture.root,
        recordedChildPid: pid,
      }),
    ).toEqual({
      survivorsPresent: false,
      survivorPids: [],
      unverifiableReason: null,
    });

    // Integration: the same same-image row neither blocks stop nor cleanup.
    fixture.layer.addProcessCandidate(foreign);

    const stopped = await stopManagedRuntime(fixture.options());
    expect(stopped.outcome).toBe("stopped");
    expect(fixture.stateRecord()).toMatchObject({
      state: "provisioned",
      childPid: null,
    });

    const cleaned = await cleanupManagedRuntime(fixture.options());
    expect(cleaned.outcome).toBe("deleted");
    expect(cleaned.survivorPids).toEqual([]);
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("control B: a root-referencing orphan is a survivor and refuses stop and cleanup", async () => {
    const { fixture, pid } = await startedFixture();
    const orphanPid = 910_002;
    const orphanCommandLine = `"${fixture.resolvedInterpreterPath}" -m searx.webapp --settings ${join(fixture.root, "searxng", "searx", "settings.yml")}`;
    // Same interpreter image, but the root reference is the only tie to the
    // managed runtime: the parent chain does not reach the recorded child.
    const orphan: ManagedRuntimeProcessCandidate = {
      pid: orphanPid,
      parentPid: 910_000,
      executablePath: fixture.resolvedInterpreterPath,
      commandLine: orphanCommandLine,
    };
    const survivorsOf = (commandLine: string): number[] =>
      rootScopedSurvivors([{ ...orphan, commandLine }], {
        managedRoot: fixture.root,
        recordedChildPid: pid,
      }).survivorPids;

    expect(survivorsOf(orphanCommandLine)).toEqual([orphanPid]);
    // Path-component boundary: nested references, quoting, case variants, and
    // separator variants match; a longer sibling component does not.
    expect(survivorsOf(`${fixture.root}\\tmp\\heartbeat`)).toEqual([orphanPid]);
    expect(survivorsOf(`--settings="${fixture.root}"`)).toEqual([orphanPid]);
    expect(survivorsOf(fixture.root.toUpperCase())).toEqual([orphanPid]);
    expect(survivorsOf(fixture.root.split("\\").join("/"))).toEqual([
      orphanPid,
    ]);
    expect(survivorsOf(`${fixture.root}-sibling\\file`)).toEqual([]);
    expect(survivorsOf(`${fixture.root}x\\file`)).toEqual([]);

    // Unit-level: the cleanup fallback with no state record keeps the same
    // root-scoped rule, keyed on the target root path alone.
    expect(
      rootScopedSurvivors([{ ...orphan, parentPid: null }], {
        managedRoot: fixture.root,
        recordedChildPid: null,
      }),
    ).toEqual({
      survivorsPresent: true,
      survivorPids: [orphanPid],
      unverifiableReason: null,
    });

    // Descendant rule: rows whose enumerated parent chain reaches the
    // recorded child are survivors with no root reference at all - directly
    // (pid 910_005) and through an intermediate enumerated row (910_006).
    const descendant: ManagedRuntimeProcessCandidate = {
      pid: 910_005,
      parentPid: pid,
      executablePath: "C:\\uv\\python\\cpython\\python.exe",
      commandLine: '"C:\\uv\\python\\cpython\\python.exe" -m searx.webapp',
    };
    const grandchild: ManagedRuntimeProcessCandidate = {
      pid: 910_006,
      parentPid: descendant.pid,
      executablePath: "C:\\uv\\python\\cpython\\python.exe",
      commandLine:
        '"C:\\uv\\python\\cpython\\python.exe" -m searx.webapp --worker',
    };
    expect(
      rootScopedSurvivors([descendant, grandchild], {
        managedRoot: fixture.root,
        recordedChildPid: pid,
      }),
    ).toEqual({
      survivorsPresent: true,
      survivorPids: [910_005, 910_006],
      unverifiableReason: null,
    });

    fixture.layer.addProcessCandidate(orphan);

    const stopError = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );
    expect(stopError.code).toBe("stop_unverified");
    expect(stopError.detail).toContain(
      "root-owned survivor process(es) remain",
    );

    const cleanupError = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );
    expect(cleanupError.code).toBe("cleanup_incomplete");

    // The fallback rule refuses the same way for a marker-only root with no
    // state record at all.
    const fallback = createRuntimeFixture();
    writeFileSync(fallback.markerFile, "{}\n", "utf8");
    fallback.layer.addProcessCandidate({
      pid: 910_003,
      parentPid: null,
      executablePath: fallback.resolvedInterpreterPath,
      commandLine: `"${fallback.resolvedInterpreterPath}" -m searx.webapp --data ${fallback.root}`,
    });
    const fallbackError = await expectRefusal(() =>
      cleanupManagedRuntime(fallback.options()),
    );
    expect(fallbackError.code).toBe("cleanup_incomplete");
    expect(existsSync(fallback.root)).toBe(false);
  });

  it("control C: an unresolvable root or recorded child pid fails closed", async () => {
    const fixture = await provisionedFixture();
    const candidates: ManagedRuntimeProcessCandidate[] = [
      {
        pid: 910_004,
        parentPid: 910_000,
        executablePath: fixture.resolvedInterpreterPath,
        commandLine: `"${fixture.resolvedInterpreterPath}" -m searx.webapp`,
      },
    ];

    // Unit-level: an unresolvable managed root reports survivors present,
    // never zero, for the recorded-child scan...
    for (const managedRoot of ["", "   ", "relative\\root"]) {
      const assessment = rootScopedSurvivors(candidates, {
        managedRoot,
        recordedChildPid: 77_001,
      });
      expect(assessment.survivorsPresent).toBe(true);
      expect(assessment.survivorPids).toEqual([]);
      expect(assessment.unverifiableReason).not.toBeNull();
    }
    // ...and for the cleanup fallback keyed on the root path alone.
    expect(
      rootScopedSurvivors(candidates, {
        managedRoot: "",
        recordedChildPid: null,
      }).survivorsPresent,
    ).toBe(true);

    // A recorded child pid that cannot resolve to a process identity - zero,
    // negative, non-integer, or missing at runtime - refuses the same way
    // instead of being read as zero survivors.
    for (const recordedChildPid of [
      0,
      -1,
      1.5,
      Number.NaN,
      undefined as unknown as number,
    ]) {
      const assessment = rootScopedSurvivors(candidates, {
        managedRoot: fixture.root,
        recordedChildPid,
      });
      expect(assessment.survivorsPresent).toBe(true);
      expect(assessment.survivorPids).toEqual([]);
      expect(assessment.unverifiableReason).not.toBeNull();
    }

    // Fail-closed on an unresolvable parent chain: with a recorded child to
    // anchor ancestry, a row whose own parent pid cannot resolve counts as a
    // survivor (it cannot be ruled out as a descendant) even with no root
    // reference in its command line.
    expect(
      rootScopedSurvivors(
        [
          {
            pid: 910_007,
            parentPid: null,
            executablePath: "C:\\uv\\python\\cpython\\python.exe",
            commandLine:
              '"C:\\uv\\python\\cpython\\python.exe" -m searx.webapp',
          },
        ],
        { managedRoot: fixture.root, recordedChildPid: 77_001 },
      ),
    ).toMatchObject({
      survivorsPresent: true,
      survivorPids: [910_007],
      unverifiableReason: expect.any(String),
    });

    // Integration: a persisted record whose child pid cannot resolve (0) is
    // fail-closed in cleanup instead of being read as zero survivors.
    const state = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    state.childPid = 0;
    writeFileSync(
      fixture.stateFile,
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
    );

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );
    expect(error.code).toBe("cleanup_incomplete");
    expect(error.detail).toContain("inconclusive");
  });

  it("uses the module-level test port override and the default port otherwise", async () => {
    const fixture = createRuntimeFixture();
    setManagedRuntimePortForTests(18_123);
    const overridden = await readManagedRuntimeStatus(fixture.options());
    expect(overridden.port).toBe(18_123);

    setManagedRuntimePortForTests(undefined);
    const standard = await readManagedRuntimeStatus(fixture.options());
    expect(standard.port).toBe(18_099);
  });

  it("covers every typed refusal code in this suite", () => {
    const missing = MANAGED_RUNTIME_REFUSAL_CODES.filter(
      (code) => !seenRefusalCodes.has(code),
    );

    expect(missing).toEqual([]);
  });
});
