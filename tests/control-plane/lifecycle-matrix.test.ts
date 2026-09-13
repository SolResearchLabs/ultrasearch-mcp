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
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProvisioningRefusalError,
  type SearxngWindowsProvisioningOptions,
  type SearxngWindowsProvisioningResult,
} from "../../src/control-plane/provisioning.js";
import {
  cleanupManagedRuntime,
  MANAGED_RUNTIME_CHILD_ENVIRONMENT_KEYS,
  MANAGED_RUNTIME_HOST,
  MANAGED_RUNTIME_LOCK_FILE,
  MANAGED_RUNTIME_MARKER_FILE,
  MANAGED_RUNTIME_PORT,
  MANAGED_RUNTIME_REFUSAL_CODES,
  MANAGED_RUNTIME_STATE_FILE,
  type ManagedRuntimeCleanupResult,
  type ManagedRuntimeDependencies,
  type ManagedRuntimeLifecycleState,
  type ManagedRuntimeListener,
  type ManagedRuntimeOperationOutcome,
  type ManagedRuntimeOperationResult,
  type ManagedRuntimeOptions,
  type ManagedRuntimePaths,
  type ManagedRuntimeProcessFacts,
  type ManagedRuntimeProcessLayer,
  type ManagedRuntimeReadinessProbe,
  type ManagedRuntimeRefusalCode,
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

/*
 * H3: managed-lifecycle state x operation matrix (packet section 6.4) plus
 * the idempotency outcomes, persisted-state field-by-field oracles, lock
 * semantics, corrupt-record handling, transient-crash recovery, read-only
 * status stability, and the completeness guard over all 23 typed refusal
 * codes.
 *
 * Every cell is pinned against the committed module. Cells where the packet's
 * plan text and the committed module disagree are recorded as review findings
 * in the test name instead of being forced; no product behavior is changed.
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
/** The venv's redirector launcher placeholder; never recorded, never spawned. */
const VENV_LAUNCHER_CONTENTS =
  "synthetic venv redirector launcher placeholder\n";
const SITE_PACKAGES_CONTENTS = "fixture site-packages module\n";
const SPAWNED_AT = "2026-09-12T00:00:00.000Z";
/** A pid the synthetic persisted-transient records name as their child. */
const LIVE_CHILD_PID = 77_101;
/** A registered lock holder whose identity the fake layer resolves. */
const LIVE_LOCK_PID = 812_345;
/** A lock holder the fake layer cannot resolve: a dead holder. */
const DEAD_LOCK_PID = 999_999;

const seenRefusalCodes = new Set<string>();
const temporaryRoots: string[] = [];

function sha256Of(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function sha256OfFile(path: string): string {
  return sha256Of(readFileSync(path, "utf8"));
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
 * Fake OS seam. It enumerates its own rows and hands them to the module's real
 * root-scoped survivor predicate, so the lifecycle tests exercise the
 * production predicate rather than a fake re-implementation of it.
 */
class FakeProcessLayer implements ManagedRuntimeProcessLayer {
  platform: NodeJS.Platform = "win32";
  spawnBehavior: "ok" | "fail" | "no_pid" = "ok";
  listenerMode: "one" | "zero" | "two" | "foreign" | "wildcard" = "one";
  terminateBehavior: "exits" | "exits_on_force" | "stubborn" = "exits";
  leaveListenersAfterTerminate = false;
  spawnExecutableOverride: string | null = null;
  inspectFailuresRemaining = 0;
  listenerScript: ManagedRuntimeListener[][] | null = null;
  port = MANAGED_RUNTIME_PORT;
  spawned: Array<{ request: ManagedRuntimeSpawnRequest; pid: number }> = [];
  terminations: Array<{ pid: number; mode: "terminate" | "force" }> = [];

  private readonly processes = new Map<number, ManagedRuntimeProcessFacts>();
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
      startedAt: SPAWNED_AT,
    });
    this.listeners =
      this.listenerMode === "one" || this.listenerMode === "wildcard"
        ? [
            {
              address:
                this.listenerMode === "wildcard"
                  ? "0.0.0.0"
                  : MANAGED_RUNTIME_HOST,
              port: this.port,
              pid,
            },
          ]
        : [];
    if (this.listenerMode === "two") {
      this.listeners = [
        { address: MANAGED_RUNTIME_HOST, port: this.port, pid },
        { address: MANAGED_RUNTIME_HOST, port: this.port, pid: pid + 1 },
      ];
    }
    if (this.listenerMode === "foreign") {
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

  rootScopedSurvivors(
    query: ManagedRuntimeSurvivorQuery,
  ): ManagedRuntimeSurvivorAssessment {
    return rootScopedSurvivors(this.processCandidates(), query);
  }

  processCandidates(): ManagedRuntimeProcessCandidate[] {
    return [...this.processes.values()].map((row) => ({
      pid: row.pid,
      parentPid: 900_000,
      executablePath: row.executablePath,
      commandLine: `"${row.executablePath}" fixture`,
    }));
  }

  registerProcess(
    pid: number,
    facts: Partial<ManagedRuntimeProcessFacts> = {},
  ): void {
    this.processes.set(pid, {
      pid,
      executablePath: facts.executablePath ?? "fixture.exe",
      startedAt: facts.startedAt ?? SPAWNED_AT,
    });
  }

  addListener(pid: number): void {
    this.listeners = [
      ...this.listeners,
      { address: MANAGED_RUNTIME_HOST, port: this.port, pid },
    ];
  }

  addForeignListener(pid = 900_001): void {
    this.listeners = [
      ...this.listeners,
      { address: MANAGED_RUNTIME_HOST, port: this.port, pid },
    ];
    this.registerProcess(pid, {
      executablePath: "foreign.exe",
      startedAt: SPAWNED_AT,
    });
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

  crashChild(): void {
    for (const { pid } of this.spawned) this.processes.delete(pid);
    this.listeners = [];
  }
}

interface FakeClock {
  clock: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

function createFakeClock(): FakeClock {
  let current = Date.parse(SPAWNED_AT);
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
  const root = mkdtempSync(join(tmpdir(), "ultrasearch-lifecycle-matrix-"));
  temporaryRoots.push(root);
  const paths = managedRuntimePathsForRoot(root);
  const venvRoot = paths.venvRoot;
  const venvLauncherPath = join(venvRoot, "Scripts", "python.exe");
  const resolvedInterpreterPath = join(root, "python-base", "python.exe");
  const pyvenvCfgPath = join(venvRoot, "pyvenv.cfg");
  mkdirSync(join(paths.checkoutPath, "searx"), { recursive: true });
  mkdirSync(join(root, "artifacts"), { recursive: true });
  mkdirSync(join(venvRoot, "Scripts"), { recursive: true });
  mkdirSync(join(venvRoot, "Lib", "site-packages"), { recursive: true });
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
  writeFileSync(venvLauncherPath, VENV_LAUNCHER_CONTENTS, "utf8");
  writeFileSync(
    join(venvRoot, "Lib", "site-packages", "fixture_package.py"),
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
    provisioner,
    layer,
    readiness,
    clock,
    stateFile,
    markerFile: join(root, MANAGED_RUNTIME_MARKER_FILE),
    dependencies,
    options: (overrides = {}) => ({ paths, dependencies, ...overrides }),
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

function rewriteStateRecord(
  fixture: RuntimeFixture,
  overrides: Record<string, unknown>,
): void {
  const current = JSON.parse(readFileSync(fixture.stateFile, "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    fixture.stateFile,
    `${JSON.stringify({ ...current, ...overrides }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Synthetic persisted record in any persisted-capable lifecycle state; used
 * for the states no production writer emits (`unverified`, `stopping`) and to
 * re-cover the `starting` transient.
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
        updatedAt: SPAWNED_AT,
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/*
 * The state x operation matrix (packet section 6.4). Each row states the
 * expected committed observable: an operation outcome plus resulting lifecycle
 * state, a typed refusal, or a computed status state.
 */

type OperationName =
  | "provision"
  | "start"
  | "stop"
  | "restart"
  | "reconcile"
  | "status"
  | "repair"
  | "cleanup";

type StateVariant = "plain" | "root-removed" | "live-child";

interface OutcomeExpectation {
  kind: "outcome";
  outcome: ManagedRuntimeOperationOutcome | "deleted" | "already_absent";
  state?: ManagedRuntimeLifecycleState;
  lastState?: ManagedRuntimeLifecycleState;
}

interface RefusalExpectation {
  kind: "refusal";
  code: ManagedRuntimeRefusalCode;
}

interface StatusExpectation {
  kind: "status";
  state: ManagedRuntimeLifecycleState;
}

type CellExpectation =
  | OutcomeExpectation
  | RefusalExpectation
  | StatusExpectation;

interface MatrixRow {
  name: string;
  state: ManagedRuntimeLifecycleState;
  operation: OperationName;
  variant: StateVariant;
  expect: CellExpectation;
}

function outcome(
  value: OutcomeExpectation["outcome"],
  state?: ManagedRuntimeLifecycleState,
): OutcomeExpectation {
  return { kind: "outcome", outcome: value, state };
}

function refusal(code: ManagedRuntimeRefusalCode): RefusalExpectation {
  return { kind: "refusal", code };
}

function status(state: ManagedRuntimeLifecycleState): StatusExpectation {
  return { kind: "status", state };
}

function cell(
  state: ManagedRuntimeLifecycleState,
  operation: OperationName,
  expectation: CellExpectation,
  options: { variant?: StateVariant; finding?: string } = {},
): MatrixRow {
  const expected =
    expectation.kind === "refusal"
      ? `refusal ${expectation.code}`
      : expectation.kind === "status"
        ? `status ${expectation.state}`
        : `outcome ${expectation.outcome}${expectation.state === undefined ? "" : ` (state ${expectation.state})`}`;
  const finding =
    options.finding === undefined
      ? ""
      : ` [review finding: ${options.finding}]`;
  return {
    name: `${state} + ${operation} -> ${expected}${finding}`,
    state,
    operation,
    variant: options.variant ?? "plain",
    expect: expectation,
  };
}

const LIFECYCLE_MATRIX: MatrixRow[] = [
  // absent: no state record, no marker.
  cell("absent", "provision", outcome("provisioned", "provisioned")),
  cell("absent", "start", refusal("checkout_missing")),
  cell("absent", "stop", outcome("already_stopped", "absent")),
  cell("absent", "restart", refusal("checkout_missing")),
  cell("absent", "repair", outcome("provisioned", "provisioned")),
  cell("absent", "cleanup", outcome("already_absent"), {
    variant: "root-removed",
  }),
  cell("absent", "reconcile", status("absent")),
  cell("absent", "status", status("absent")),
  // unverified: a persisted record with no verification identity.
  cell("unverified", "provision", outcome("provisioned", "provisioned")),
  cell("unverified", "start", refusal("patch_state_unknown")),
  cell("unverified", "stop", outcome("already_stopped", "provisioned")),
  cell("unverified", "restart", refusal("patch_state_unknown")),
  cell("unverified", "repair", outcome("provisioned", "provisioned")),
  cell("unverified", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "unverified",
  }),
  cell("unverified", "reconcile", status("unverified")),
  cell("unverified", "status", status("unverified")),
  // provisioned: verified, not running.
  cell(
    "provisioned",
    "provision",
    outcome("already_provisioned", "provisioned"),
  ),
  cell("provisioned", "start", outcome("started", "running")),
  cell("provisioned", "stop", outcome("already_stopped", "provisioned")),
  cell("provisioned", "restart", outcome("restarted", "running")),
  cell("provisioned", "repair", outcome("already_provisioned", "provisioned")),
  cell("provisioned", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "provisioned",
  }),
  cell("provisioned", "reconcile", status("provisioned")),
  cell("provisioned", "status", status("provisioned")),
  // starting: the transient only `start` writes.
  cell("starting", "provision", outcome("already_provisioned", "provisioned"), {
    finding:
      "the plan cell expects a refusal (state conflict/active); the committed module re-verifies the record and normalizes the transient to provisioned",
  }),
  cell("starting", "start", outcome("started", "running")),
  cell("starting", "stop", outcome("already_stopped", "provisioned")),
  cell("starting", "restart", outcome("restarted", "running")),
  cell("starting", "repair", outcome("already_provisioned", "provisioned")),
  cell("starting", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "starting",
  }),
  cell("starting", "reconcile", status("stale")),
  cell("starting", "status", status("stale")),
  // stopping: no production writer persists it; the crash rule still applies.
  cell("stopping", "provision", outcome("already_provisioned", "provisioned"), {
    finding:
      "the plan cell expects a refusal; the committed module normalizes the persisted transient to provisioned after re-verification",
  }),
  cell("stopping", "start", outcome("started", "running")),
  cell("stopping", "stop", outcome("already_stopped", "provisioned")),
  cell("stopping", "restart", outcome("restarted", "running")),
  cell("stopping", "repair", outcome("already_provisioned", "provisioned")),
  cell("stopping", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "stopping",
  }),
  cell("stopping", "reconcile", status("stale")),
  cell("stopping", "status", status("stale")),
  // running: verified and live.
  cell("running", "provision", outcome("already_provisioned", "running")),
  cell("running", "start", outcome("already_running", "running")),
  cell("running", "stop", outcome("stopped", "provisioned")),
  cell("running", "restart", outcome("restarted", "running")),
  cell("running", "repair", outcome("already_provisioned", "running")),
  cell("running", "cleanup", refusal("cleanup_refused")),
  cell("running", "reconcile", status("running")),
  cell("running", "status", status("running")),
  // stale: a confirmed crash record.
  cell("stale", "provision", outcome("already_provisioned", "provisioned")),
  cell("stale", "start", outcome("started", "running")),
  cell("stale", "stop", outcome("already_stopped", "provisioned")),
  cell("stale", "restart", outcome("restarted", "running")),
  cell("stale", "repair", outcome("already_provisioned", "provisioned")),
  cell("stale", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "stale",
  }),
  cell("stale", "reconcile", status("stale")),
  cell("stale", "status", status("stale")),
  // failed: awaiting repair or cleanup.
  cell("failed", "provision", outcome("already_provisioned", "provisioned"), {
    finding:
      "the plan cell expects a refusal (already_failed) until repair/cleanup; the committed provision re-verifies and normalizes the record",
  }),
  cell("failed", "start", refusal("already_failed")),
  cell("failed", "stop", outcome("already_stopped", "provisioned")),
  cell("failed", "restart", outcome("restarted", "running"), {
    finding:
      "the plan cell expects a refusal; the committed stop normalizes the failed record and the restart then starts a fresh child",
  }),
  cell("failed", "repair", outcome("already_provisioned", "provisioned")),
  cell("failed", "cleanup", {
    kind: "outcome",
    outcome: "deleted",
    lastState: "failed",
  }),
  cell("failed", "reconcile", status("failed")),
  cell("failed", "status", status("failed")),
  // Variants: a persisted transient that still has a live child.
  cell("starting", "cleanup", refusal("cleanup_refused"), {
    variant: "live-child",
  }),
  cell("stopping", "cleanup", refusal("cleanup_refused"), {
    variant: "live-child",
  }),
];

async function fixtureInState(
  state: ManagedRuntimeLifecycleState,
  variant: StateVariant,
): Promise<RuntimeFixture> {
  switch (state) {
    case "absent": {
      const fixture = createRuntimeFixture();
      if (variant === "root-removed") {
        rmSync(fixture.root, { recursive: true, force: true });
      }
      return fixture;
    }
    case "unverified": {
      const fixture = createRuntimeFixture();
      writeFileSync(fixture.markerFile, "{}\n", "utf8");
      writeSyntheticStateRecord(fixture, { state: "unverified" });
      return fixture;
    }
    case "provisioned":
      return provisionedFixture();
    case "starting":
    case "stopping": {
      const fixture = await provisionedFixture();
      const overrides: Record<string, unknown> = { state };
      if (variant === "live-child") {
        overrides.childPid = LIVE_CHILD_PID;
        overrides.childStartedAt = SPAWNED_AT;
        overrides.childExecutable = fixture.resolvedInterpreterPath;
        fixture.layer.registerProcess(LIVE_CHILD_PID, {
          executablePath: fixture.resolvedInterpreterPath,
          startedAt: SPAWNED_AT,
        });
      }
      rewriteStateRecord(fixture, overrides);
      return fixture;
    }
    case "running":
      return (await startedFixture()).fixture;
    case "stale": {
      const { fixture } = await startedFixture();
      fixture.layer.crashChild();
      await reconcileManagedRuntime(fixture.options());
      return fixture;
    }
    case "failed": {
      const fixture = await provisionedFixture();
      fixture.layer.spawnBehavior = "fail";
      await expectRefusal(() => startManagedRuntime(fixture.options()));
      // The transient spawn cause clears; restart rows then model the
      // operator's retry against the same persisted failed record.
      fixture.layer.spawnBehavior = "ok";
      return fixture;
    }
  }
}

async function runOperation(
  fixture: RuntimeFixture,
  operation: OperationName,
): Promise<unknown> {
  switch (operation) {
    case "provision":
      return provisionManagedRuntime(fixture.options());
    case "start":
      return startManagedRuntime(fixture.options());
    case "stop":
      return stopManagedRuntime(fixture.options());
    case "restart":
      return restartManagedRuntime(fixture.options());
    case "reconcile":
      return reconcileManagedRuntime(fixture.options());
    case "status":
      return readManagedRuntimeStatus(fixture.options());
    case "repair":
      return repairManagedRuntime(fixture.options());
    case "cleanup":
      return cleanupManagedRuntime(fixture.options());
  }
}

// The production builder forwards these ambient names only when `process.env`
// defines them; every other allowlisted key is set unconditionally
// (`childEnvironment` in runtime-lifecycle.ts).
const AMBIENT_PASSTHROUGH_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "SystemRoot",
  "PATHEXT",
]);

/**
 * Expected child-environment key names, in the builder's insertion order.
 * Derived from the production allowlist so a module key change cannot silently
 * drift: the field-by-field record oracles below then assert equality between
 * the production output and this derivation of
 * `MANAGED_RUNTIME_CHILD_ENVIRONMENT_KEYS`.
 */
function expectedChildEnvironmentKeys(): string[] {
  return MANAGED_RUNTIME_CHILD_ENVIRONMENT_KEYS.filter(
    (name) =>
      !AMBIENT_PASSTHROUGH_KEYS.has(name) || process.env[name] !== undefined,
  );
}

describe("Control Plane managed lifecycle matrix", () => {
  beforeEach(() => {
    delete process.env.TINYFISH_API_KEY;
  });

  afterEach(() => {
    delete process.env.TINYFISH_API_KEY;
    for (const root of temporaryRoots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A fixture that resisted deletion is reported by its own test.
      }
      expect(existsSync(root)).toBe(false);
    }
  });

  it("covers every state x operation cell of the packet matrix", () => {
    expect(LIFECYCLE_MATRIX).toHaveLength(66);
    const states = new Set(LIFECYCLE_MATRIX.map((row) => row.state));
    expect([...states].sort()).toEqual([
      "absent",
      "failed",
      "provisioned",
      "running",
      "stale",
      "starting",
      "stopping",
      "unverified",
    ]);
  });

  it.each(LIFECYCLE_MATRIX)("$name", async (row) => {
    const fixture = await fixtureInState(row.state, row.variant);

    if (row.expect.kind === "refusal") {
      const error = await expectRefusal(() =>
        runOperation(fixture, row.operation),
      );
      expect(error.code).toBe(row.expect.code);
      return;
    }

    const raw = await runOperation(fixture, row.operation);
    if (row.expect.kind === "status") {
      expect((raw as ManagedRuntimeStatus).state).toBe(row.expect.state);
      return;
    }
    const result = raw as
      | ManagedRuntimeOperationResult
      | ManagedRuntimeCleanupResult;
    expect(result.outcome).toBe(row.expect.outcome);
    if ("status" in result && row.expect.state !== undefined) {
      expect(result.status.state).toBe(row.expect.state);
    }
    if ("lastState" in result && row.expect.lastState !== undefined) {
      expect(result.lastState).toBe(row.expect.lastState);
    }
  });

  it("reports the four idempotency outcomes on a re-called operation", async () => {
    const provisioned = await provisionedFixture();
    const secondProvision = await provisionManagedRuntime(
      provisioned.options(),
    );
    expect(secondProvision.outcome).toBe("already_provisioned");

    const { fixture: running } = await startedFixture();
    const secondStart = await startManagedRuntime(running.options());
    expect(secondStart.outcome).toBe("already_running");

    const stopped = await stopManagedRuntime(running.options());
    expect(stopped.outcome).toBe("stopped");
    const secondStop = await stopManagedRuntime(running.options());
    expect(secondStop.outcome).toBe("already_stopped");

    const cleaned = await cleanupManagedRuntime(provisioned.options());
    expect(cleaned.outcome).toBe("deleted");
    const secondCleanup = await cleanupManagedRuntime(provisioned.options());
    expect(secondCleanup.outcome).toBe("already_absent");
    expect(secondCleanup.pathAbsent).toBe(true);
  });

  it("persists the exact provisioned record field-by-field", async () => {
    const fixture = createRuntimeFixture();

    const result = await provisionManagedRuntime(fixture.options());

    expect(result.outcome).toBe("provisioned");
    expect(result.status).toMatchObject({
      state: "provisioned",
      generation: 0,
      pid: null,
      ownership: "none",
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
      port: MANAGED_RUNTIME_PORT,
      lastReadiness: null,
      lastStop: null,
      lastCrash: null,
      lastRefusal: null,
      stateFile: fixture.stateFile,
    });
    expect(fixture.stateRecord()).toEqual({
      schemaVersion: 1,
      state: "provisioned",
      generation: 0,
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: sha256Of(ARCHIVE_CONTENTS),
      patchSha256: sha256Of(PATCH_CONTENTS),
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
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
      updatedAt: SPAWNED_AT,
    });
  });

  it("persists the exact running record field-by-field with environment key names only", async () => {
    const { fixture, pid } = await startedFixture();
    const spawn = fixture.layer.spawned[0]?.request;
    expect(spawn).toBeDefined();

    expect(fixture.stateRecord()).toEqual({
      schemaVersion: 1,
      state: "running",
      generation: 1,
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: sha256Of(ARCHIVE_CONTENTS),
      patchSha256: sha256Of(PATCH_CONTENTS),
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
      checkoutPath: fixture.paths.checkoutPath,
      port: MANAGED_RUNTIME_PORT,
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
      childPid: pid,
      childStartedAt: SPAWNED_AT,
      childExecutable: fixture.resolvedInterpreterPath,
      environmentKeys: expectedChildEnvironmentKeys(),
      lastReadiness: { status: 200, at: SPAWNED_AT, elapsedMs: 0 },
      lastStop: null,
      lastCrash: null,
      lastRefusal: null,
      lockEvents: [],
      updatedAt: SPAWNED_AT,
    });
    // Names only: the key list is exactly the spawned child environment's key
    // names, and no environment value - including the generated secret - is
    // persisted.
    expect(fixture.stateRecord()?.environmentKeys).toEqual(
      Object.keys(spawn?.environment ?? {}),
    );
    const secret = spawn?.environment.SEARXNG_SECRET ?? "";
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(fixture.stateFile, "utf8")).not.toContain(secret);
    expect(JSON.stringify(fixture.stateRecord())).not.toContain("TINYFISH");
  });

  it("persists the exact stopped record field-by-field and keeps the generation", async () => {
    const { fixture } = await startedFixture();

    const stopped = await stopManagedRuntime(fixture.options());

    expect(stopped.outcome).toBe("stopped");
    expect(stopped.status.state).toBe("provisioned");
    expect(fixture.stateRecord()).toEqual({
      schemaVersion: 1,
      state: "provisioned",
      generation: 1,
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: sha256Of(ARCHIVE_CONTENTS),
      patchSha256: sha256Of(PATCH_CONTENTS),
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
      checkoutPath: fixture.paths.checkoutPath,
      port: MANAGED_RUNTIME_PORT,
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
      childPid: null,
      childStartedAt: null,
      childExecutable: null,
      environmentKeys: expectedChildEnvironmentKeys(),
      lastReadiness: { status: 200, at: SPAWNED_AT, elapsedMs: 0 },
      lastStop: { at: SPAWNED_AT, method: "terminate" },
      lastCrash: null,
      lastRefusal: null,
      lockEvents: [],
      updatedAt: SPAWNED_AT,
    });
  });

  it("persists the exact stale record field-by-field when a crashed child is reconciled", async () => {
    const { fixture, pid } = await startedFixture();
    fixture.layer.crashChild();

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toEqual({
      schemaVersion: 1,
      state: "stale",
      generation: 1,
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: sha256Of(ARCHIVE_CONTENTS),
      patchSha256: sha256Of(PATCH_CONTENTS),
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
      checkoutPath: fixture.paths.checkoutPath,
      port: MANAGED_RUNTIME_PORT,
      endpoint: `http://${MANAGED_RUNTIME_HOST}:${MANAGED_RUNTIME_PORT}`,
      childPid: pid,
      childStartedAt: SPAWNED_AT,
      childExecutable: fixture.resolvedInterpreterPath,
      environmentKeys: expectedChildEnvironmentKeys(),
      lastReadiness: { status: 200, at: SPAWNED_AT, elapsedMs: 0 },
      lastStop: null,
      lastCrash: { at: SPAWNED_AT, detection: "child_not_running" },
      lastRefusal: null,
      lockEvents: [],
      updatedAt: SPAWNED_AT,
    });
  });

  it("persists the exact failed record field-by-field when a spawn fails", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.spawnBehavior = "fail";

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("spawn_failed");
    expect(fixture.stateRecord()).toEqual({
      schemaVersion: 1,
      state: "failed",
      generation: 0,
      pinCommit: "a".repeat(40),
      treeId: "b".repeat(40),
      archiveSha256: sha256Of(ARCHIVE_CONTENTS),
      patchSha256: sha256Of(PATCH_CONTENTS),
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
      interpreterPath: fixture.resolvedInterpreterPath,
      interpreterSha256: sha256Of(RESOLVED_INTERPRETER_CONTENTS),
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
      lastRefusal: {
        code: "spawn_failed",
        at: SPAWNED_AT,
        detail: "fixture spawn failure",
      },
      lockEvents: [],
      updatedAt: SPAWNED_AT,
    });
  });

  it("keeps the full cleanup result shape with its proof fields on deletion", async () => {
    const fixture = await provisionedFixture();

    const cleaned = await cleanupManagedRuntime(fixture.options());

    expect(cleaned).toEqual({
      outcome: "deleted",
      managedRoot: fixture.root,
      lastState: "provisioned",
      pathAbsent: true,
      port: MANAGED_RUNTIME_PORT,
      listenersAfter: 0,
      survivorPids: [],
      clearedLockPids: [],
      verifiedAt: SPAWNED_AT,
    });
    expect(existsSync(fixture.root)).toBe(false);
  });

  it("treats a persisted starting record as stale on reconcile and records the transient detection", async () => {
    const fixture = await provisionedFixture();
    rewriteStateRecord(fixture, {
      state: "starting",
      childPid: LIVE_CHILD_PID,
    });

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { at: SPAWNED_AT, detection: "persisted_starting_transient" },
    });
  });

  it("treats a persisted stopping record as stale on reconcile and records the transient detection", async () => {
    const fixture = await provisionedFixture();
    rewriteStateRecord(fixture, {
      state: "stopping",
      childPid: LIVE_CHILD_PID,
    });

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(fixture.stateRecord()).toMatchObject({
      state: "stale",
      lastCrash: { at: SPAWNED_AT, detection: "persisted_stopping_transient" },
    });
  });

  it("records the crash only once: a persisted stale record is returned without a rewrite", async () => {
    const { fixture } = await startedFixture();
    fixture.layer.crashChild();
    await reconcileManagedRuntime(fixture.options());
    const before = readFileSync(fixture.stateFile, "utf8");

    const reconciled = await reconcileManagedRuntime(fixture.options());

    expect(reconciled.state).toBe("stale");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
  });

  it("refuses a stopped transient with a live identity-matching child when a listener owns the port (review finding: the stale transition refuses instead of terminating)", async () => {
    const fixture = await provisionedFixture();
    rewriteStateRecord(fixture, {
      state: "starting",
      childPid: LIVE_CHILD_PID,
    });
    fixture.layer.registerProcess(LIVE_CHILD_PID, {
      executablePath: fixture.resolvedInterpreterPath,
      startedAt: SPAWNED_AT,
    });
    fixture.layer.addListener(LIVE_CHILD_PID);

    const error = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("pid_identity_mismatch");
    expect(fixture.layer.terminations).toEqual([]);
  });

  it("does not terminate the recorded child when stop normalizes a persisted transient without a listener", async () => {
    const fixture = await provisionedFixture();
    rewriteStateRecord(fixture, {
      state: "starting",
      childPid: LIVE_CHILD_PID,
    });
    fixture.layer.registerProcess(LIVE_CHILD_PID, {
      executablePath: fixture.resolvedInterpreterPath,
      startedAt: SPAWNED_AT,
    });

    const stopped = await stopManagedRuntime(fixture.options());

    expect(stopped.outcome).toBe("already_stopped");
    expect(stopped.note).toBe(
      "ownership could not be verified; no process was terminated",
    );
    expect(fixture.layer.terminations).toEqual([]);
  });

  it("refuses a live lock on every mutating operation and on reconcile with state_conflict", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.registerProcess(LIVE_LOCK_PID);
    const lockPath = join(fixture.root, MANAGED_RUNTIME_LOCK_FILE);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: LIVE_LOCK_PID, at: SPAWNED_AT })}\n`,
      "utf8",
    );
    const recordBefore = readFileSync(fixture.stateFile, "utf8");

    for (const operation of [
      "provision",
      "start",
      "stop",
      "restart",
      "reconcile",
      "repair",
      "cleanup",
    ] as const) {
      const error = await expectRefusal(() => runOperation(fixture, operation));
      expect(error.code).toBe("state_conflict");
    }

    // A refusal raised before the lock is acquired writes nothing, and the
    // read-only status ignores the lock entirely.
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(recordBefore);
    expect(existsSync(lockPath)).toBe(true);
    const status = await readManagedRuntimeStatus(fixture.options());
    expect(status.state).toBe("provisioned");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(recordBefore);
  });

  it("clears a dead lock only in repair and cleanup and records the cleared holder", async () => {
    const repairFixture = await provisionedFixture();
    writeFileSync(
      join(repairFixture.root, MANAGED_RUNTIME_LOCK_FILE),
      `${JSON.stringify({ pid: DEAD_LOCK_PID, at: SPAWNED_AT })}\n`,
      "utf8",
    );
    for (const operation of ["provision", "start", "reconcile"] as const) {
      const error = await expectRefusal(() =>
        runOperation(repairFixture, operation),
      );
      expect(error.code).toBe("state_conflict");
    }

    const repaired = await repairManagedRuntime(repairFixture.options());

    expect(repaired.outcome).toBe("already_provisioned");
    expect(repairFixture.stateRecord()?.lockEvents).toEqual([
      { at: SPAWNED_AT, pid: DEAD_LOCK_PID, reason: "dead_lock_cleared" },
    ]);
    expect(
      existsSync(join(repairFixture.root, MANAGED_RUNTIME_LOCK_FILE)),
    ).toBe(false);

    const cleanupFixture = await provisionedFixture();
    writeFileSync(
      join(cleanupFixture.root, MANAGED_RUNTIME_LOCK_FILE),
      `${JSON.stringify({ pid: DEAD_LOCK_PID, at: SPAWNED_AT })}\n`,
      "utf8",
    );

    const cleaned = await cleanupManagedRuntime(cleanupFixture.options());

    expect(cleaned.outcome).toBe("deleted");
    expect(cleaned.clearedLockPids).toEqual([DEAD_LOCK_PID]);
  });

  it("refuses a corrupt state file with state_corrupt and leaves it intact as forensic evidence", async () => {
    const invalidJson = await provisionedFixture();
    writeFileSync(invalidJson.stateFile, "{not json", "utf8");

    const statusError = await expectRefusal(() =>
      readManagedRuntimeStatus(invalidJson.options()),
    );
    expect(statusError.code).toBe("state_corrupt");
    expect(readFileSync(invalidJson.stateFile, "utf8")).toBe("{not json");

    const startError = await expectRefusal(() =>
      startManagedRuntime(invalidJson.options()),
    );
    expect(startError.code).toBe("state_corrupt");
    expect(readFileSync(invalidJson.stateFile, "utf8")).toBe("{not json");
    expect(existsSync(join(invalidJson.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );
  });

  it("refuses a schema-invalid state record with state_corrupt for every operation touching it", async () => {
    const fixture = await provisionedFixture();
    rewriteStateRecord(fixture, { generation: -1 });
    const before = readFileSync(fixture.stateFile, "utf8");

    for (const operation of [
      "provision",
      "start",
      "stop",
      "reconcile",
      "status",
      "repair",
      "cleanup",
    ] as const) {
      const error = await expectRefusal(() => runOperation(fixture, operation));
      expect(error.code).toBe("state_corrupt");
    }

    expect(readFileSync(fixture.stateFile, "utf8")).toBe(before);
    expect(existsSync(fixture.root)).toBe(true);
  });

  it("keeps a read-only status byte-stable for a provisioned and a crashed running record", async () => {
    const provisioned = await provisionedFixture();
    const provisionedHash = sha256OfFile(provisioned.stateFile);
    const provisionedStatus = await readManagedRuntimeStatus(
      provisioned.options(),
    );
    expect(provisionedStatus.state).toBe("provisioned");
    expect(sha256OfFile(provisioned.stateFile)).toBe(provisionedHash);
    expect(existsSync(join(provisioned.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );

    const { fixture: running } = await startedFixture();
    const runningHash = sha256OfFile(running.stateFile);
    const filesBefore = readdirSync(join(running.root, "state")).sort();
    running.layer.crashChild();

    const crashedStatus = await readManagedRuntimeStatus(running.options());

    expect(crashedStatus.state).toBe("stale");
    expect(crashedStatus.pid).toBe(running.layer.lastPid);
    expect(sha256OfFile(running.stateFile)).toBe(runningHash);
    expect(readdirSync(join(running.root, "state")).sort()).toEqual(
      filesBefore,
    );
    expect(existsSync(join(running.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );
  });

  /*
   * Failure-injection matrix (packet section 6.5): each typed refusal is
   * produced and asserted fail-closed, keeping the completeness guard green.
   */

  it("refuses unsupported_platform and managed_root_refused without side effects", async () => {
    const unsupported = await provisionedFixture();
    unsupported.layer.platform = "linux";
    const platformError = await expectRefusal(() =>
      startManagedRuntime(unsupported.options()),
    );
    expect(platformError.code).toBe("unsupported_platform");

    const rootError = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(parse(tmpdir()).root),
      }),
    );
    expect(rootError.code).toBe("managed_root_refused");
  });

  it("refuses root_marker_missing for a directory that is not a managed root", async () => {
    const fixture = createRuntimeFixture();
    const markerError = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );
    expect(markerError.code).toBe("root_marker_missing");
    expect(existsSync(fixture.root)).toBe(true);

    // A state record without the marker refuses the same way at provision.
    const recorded = createRuntimeFixture();
    writeSyntheticStateRecord(recorded, { state: "unverified" });
    const provisionError = await expectRefusal(() =>
      provisionManagedRuntime(recorded.options()),
    );
    expect(provisionError.code).toBe("root_marker_missing");
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
  });

  it("carries a provisioning refusal verbatim and refuses patch_state_unknown for a mutated checkout", async () => {
    const fixture = createRuntimeFixture();
    const refusing = createFakeProvisioner("refuse");
    const refusalError = await expectRefusal(() =>
      provisionManagedRuntime({
        paths: fixture.paths,
        dependencies: {
          ...fixture.dependencies,
          applyWindowsPatch: refusing.apply,
        },
      }),
    );
    expect(refusalError.code).toBe("provisioning_refused");
    expect(refusalError.detail).toContain("apply_failed");

    const mutated = createRuntimeFixture();
    writeFileSync(
      join(mutated.paths.checkoutPath, "searx", "valkeydb.py"),
      "neither pristine nor patched\n",
      "utf8",
    );
    const patchStateError = await expectRefusal(() =>
      provisionManagedRuntime(mutated.options()),
    );
    expect(patchStateError.code).toBe("patch_state_unknown");
    expect(mutated.provisioner.calls).toHaveLength(0);
  });

  it("refuses a venv-redirector interpreter identity at provision and at start", async () => {
    const launcher = createRuntimeFixture();
    rmSync(launcher.pyvenvCfgPath);
    const provisionError = await expectRefusal(() =>
      provisionManagedRuntime(
        launcher.options({
          paths: {
            ...launcher.paths,
            interpreterPath: launcher.venvLauncherPath,
          },
        }),
      ),
    );
    expect(provisionError.code).toBe("interpreter_redirector_detected");
    expect(launcher.provisioner.calls).toHaveLength(0);

    const substituted = await provisionedFixture();
    writeFileSync(
      substituted.resolvedInterpreterPath,
      VENV_LAUNCHER_CONTENTS,
      "utf8",
    );
    const startError = await expectRefusal(() =>
      startManagedRuntime(substituted.options()),
    );
    expect(startError.code).toBe("interpreter_redirector_detected");
    expect(substituted.layer.spawned).toHaveLength(0);
  });

  it("refuses a foreign listener on the port at start and a changed pid identity at stop", async () => {
    const foreign = await provisionedFixture();
    foreign.layer.addForeignListener();
    const foreignError = await expectRefusal(() =>
      startManagedRuntime(foreign.options()),
    );
    expect(foreignError.code).toBe("port_in_use_foreign");
    expect(foreign.layer.spawned).toHaveLength(0);

    const { fixture, pid } = await startedFixture();
    fixture.layer.replaceChildIdentity(pid);
    const identityError = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );
    expect(identityError.code).toBe("pid_identity_mismatch");
    expect(fixture.layer.terminations).toEqual([]);
  });

  it("refuses spawn_failed for a failing spawn and for a spawn without a pid", async () => {
    const failing = await provisionedFixture();
    failing.layer.spawnBehavior = "fail";
    const failingError = await expectRefusal(() =>
      startManagedRuntime(failing.options()),
    );
    expect(failingError.code).toBe("spawn_failed");
    expect(failing.stateRecord()).toMatchObject({ state: "failed" });

    const pidless = await provisionedFixture();
    pidless.layer.spawnBehavior = "no_pid";
    const pidlessError = await expectRefusal(() =>
      startManagedRuntime(pidless.options()),
    );
    expect(pidlessError.code).toBe("spawn_failed");
    expect(pidless.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
    });
  });

  it("stops the just-spawned child when the inspector fails before the starting record is completed", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.inspectFailuresRemaining = 1;

    const error = await expectRefusal(() =>
      startManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("spawn_failed");
    expect(fixture.layer.terminations).toEqual([
      { pid: fixture.layer.lastPid, mode: "terminate" },
    ]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
    });
  });

  it("refuses readiness_timeout and readiness_rejected and stops the child it spawned", async () => {
    const timeout = await provisionedFixture();
    timeout.readiness = createReadinessScript(["reject"]);
    timeout.dependencies.readinessProbe = timeout.readiness.probe;
    const timeoutError = await expectRefusal(() =>
      startManagedRuntime(timeout.options()),
    );
    expect(timeoutError.code).toBe("readiness_timeout");
    expect(timeout.layer.terminations).toEqual([
      { pid: timeout.layer.lastPid, mode: "terminate" },
    ]);
    expect(timeout.stateRecord()).toMatchObject({
      state: "failed",
      childPid: null,
      lastRefusal: { code: "readiness_timeout" },
    });

    const rejected = await provisionedFixture();
    rejected.readiness = createReadinessScript([503]);
    rejected.dependencies.readinessProbe = rejected.readiness.probe;
    const rejectedError = await expectRefusal(() =>
      startManagedRuntime(rejected.options()),
    );
    expect(rejectedError.code).toBe("readiness_rejected");
    expect(rejected.layer.terminations).toHaveLength(1);
    expect(rejected.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "readiness_rejected" },
    });
  });

  it("refuses listener_invariant_violated for zero, duplicate, foreign-owner, and wildcard listeners", async () => {
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

  it("refuses stop_timeout when the child survives terminate and force", async () => {
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

  it("refuses stop_unverified when a listener remains after the recorded child exited", async () => {
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

  it("covers every typed refusal code in this suite", () => {
    const missing = MANAGED_RUNTIME_REFUSAL_CODES.filter(
      (code) => !seenRefusalCodes.has(code),
    );

    expect(missing).toEqual([]);
  });
});
