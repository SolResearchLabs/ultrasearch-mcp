import { spawnSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupManagedRuntime,
  MANAGED_RUNTIME_HOST,
  MANAGED_RUNTIME_LOCK_FILE,
  MANAGED_RUNTIME_MARKER_FILE,
  MANAGED_RUNTIME_PORT,
  type ManagedRuntimeCleanupResult,
  type ManagedRuntimeDependencies,
  type ManagedRuntimeListener,
  type ManagedRuntimeOptions,
  type ManagedRuntimePaths,
  type ManagedRuntimeProcessCandidate,
  type ManagedRuntimeProcessFacts,
  type ManagedRuntimeProcessLayer,
  ManagedRuntimeRefusalError,
  type ManagedRuntimeSpawnRequest,
  type ManagedRuntimeSurvivorAssessment,
  type ManagedRuntimeSurvivorQuery,
  managedRuntimePathsForRoot,
  provisionManagedRuntime,
  rootScopedSurvivors,
  startManagedRuntime,
  stopManagedRuntime,
} from "../../src/control-plane/runtime-lifecycle.js";

/*
 * H5: root-scoped survivor predicate and cleanup proof obligations.
 *
 * The predicate matrix (`DQ-035` R1) pins every candidate class: the recorded
 * child, direct and indirect descendants, command lines referencing the
 * managed root on a path-component boundary with case/separator
 * normalization, foreign same-image processes (never survivors), and the
 * fail-closed shapes (unreadable command line, unresolvable pid/parent/root).
 * The integration half pins `stop_unverified` / `cleanup_incomplete` for a
 * root-referencing orphan and the cleanup obligations: marker required, active
 * child refusal, non-isolated root refusal, the proof fields, byte-identical
 * refusals, and the `already_absent` re-call. Everything runs against the
 * injected fake process layer; no real process, listener, or port is touched.
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
const RESOLVED_INTERPRETER_CONTENTS =
  "synthetic resolved base CPython placeholder\n";
const SPAWNED_AT = "2026-09-12T00:00:00.000Z";
const RECORDED_CHILD_PID = 51_001;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

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

/** Relative entry path (directories marked `/`) -> content digest. */
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

async function expectRefusal(
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

/*
 * Predicate matrix: explicit candidate rows fed directly to the exported
 * root-scoped predicate. `reasonContains` distinguishes a conclusive scan
 * (absent) from the fail-closed ones (a substring of `unverifiableReason`).
 */

interface PredicateRow {
  name: string;
  build: (root: string) => ManagedRuntimeProcessCandidate[];
  recordedChildPid: number | null;
  /** Query root override; defaults to the per-test temp root. */
  root?: string;
  expect: {
    survivorsPresent: boolean;
    survivorPids: number[];
    reasonContains?: string;
  };
}

function row(
  pid: number,
  overrides: Partial<ManagedRuntimeProcessCandidate> = {},
): ManagedRuntimeProcessCandidate {
  return {
    pid,
    parentPid: 900_000,
    executablePath: null,
    commandLine: '"foreign.exe" --unrelated',
    ...overrides,
  };
}

const PREDICATE_ROWS: PredicateRow[] = [
  {
    name: "a foreign same-image process with no root reference is never a survivor",
    build: (root) => [
      // The image path equals the recorded interpreter, and the command line
      // is an unrelated tool host with no reference to the managed root.
      row(62_001, {
        executablePath: join(root, "python.exe"),
        commandLine:
          '"C:\\tools\\codex-router\\.venv\\Scripts\\litellm.exe" --config C:\\tools\\codex-router\\litellm.yaml',
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: false, survivorPids: [] },
  },
  {
    name: "image-path equality with the managed root itself is never a survivor",
    build: (root) => [
      row(62_002, {
        executablePath: root,
        commandLine: '"foreign.exe" --unrelated',
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: false, survivorPids: [] },
  },
  {
    name: "a foreign process whose command line merely extends the root is not a survivor",
    build: () => [
      row(62_003, {
        executablePath: "C:\\tools\\python.exe",
        commandLine: '"C:\\tools\\python.exe" --root-sibling',
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: false, survivorPids: [] },
  },
  {
    name: "the recorded child pid is a survivor",
    build: () => [row(RECORDED_CHILD_PID)],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [RECORDED_CHILD_PID] },
  },
  {
    name: "the recorded child needs no resolvable parent chain",
    build: () => [row(RECORDED_CHILD_PID, { parentPid: null })],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [RECORDED_CHILD_PID] },
  },
  {
    name: "a direct descendant of the recorded child is a survivor",
    build: () => [
      row(62_010, {
        parentPid: RECORDED_CHILD_PID,
        commandLine: '"C:\\uv\\python.exe" -m searx.webapp',
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [62_010] },
  },
  {
    name: "a descendant through an intermediate enumerated row is a survivor",
    build: () => [
      row(62_010, {
        parentPid: RECORDED_CHILD_PID,
        commandLine: '"C:\\uv\\python.exe" -m searx.webapp',
      }),
      row(62_011, {
        parentPid: 62_010,
        commandLine: '"C:\\uv\\python.exe" -m searx.webapp --worker',
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [62_010, 62_011] },
  },
  {
    name: "a command line referencing the managed root on a boundary is a survivor",
    build: (root) => [row(63_001, { commandLine: `${root}\\tmp\\heartbeat` })],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [63_001] },
  },
  {
    name: "a quoted root reference is a survivor",
    build: (root) => [row(63_002, { commandLine: `--settings="${root}"` })],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [63_002] },
  },
  {
    name: "case and separator normalization: an uppercase and a forward-slash root match",
    build: (root) => [
      row(63_003, { commandLine: `${root.toUpperCase()}\\tmp\\heartbeat` }),
      row(63_004, {
        commandLine: `${root.split("\\").join("/")}/tmp/heartbeat`,
      }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: true, survivorPids: [63_003, 63_004] },
  },
  {
    name: "a longer sibling path component does not match the root",
    build: (root) => [
      row(63_005, { commandLine: `${root}-sibling\\file` }),
      row(63_006, { commandLine: `${root}x\\file` }),
      row(63_007, { commandLine: `${root}b\\file` }),
    ],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: { survivorsPresent: false, survivorPids: [] },
  },
  {
    name: "an unreadable command line fails closed",
    build: () => [row(64_001, { commandLine: null })],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: {
      survivorsPresent: true,
      survivorPids: [64_001],
      reasonContains: "command line",
    },
  },
  {
    name: "an unresolvable pid fails closed without claiming a survivor pid",
    build: () => [row(0)],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: {
      survivorsPresent: true,
      survivorPids: [],
      reasonContains: "no resolvable pid",
    },
  },
  {
    name: "an unresolvable parent chain fails closed when a recorded child anchors ancestry",
    build: () => [row(64_002, { parentPid: null })],
    recordedChildPid: RECORDED_CHILD_PID,
    expect: {
      survivorsPresent: true,
      survivorPids: [64_002],
      reasonContains: "parent pid",
    },
  },
  {
    name: "an unresolvable parent chain is conclusive when no recorded child anchors ancestry",
    build: () => [row(64_003, { parentPid: null })],
    recordedChildPid: null,
    expect: { survivorsPresent: false, survivorPids: [] },
  },
  {
    name: "an empty managed root fails closed",
    build: () => [row(64_004)],
    recordedChildPid: null,
    root: "",
    expect: {
      survivorsPresent: true,
      survivorPids: [],
      reasonContains: "not resolvable",
    },
  },
  {
    name: "a relative managed root fails closed",
    build: () => [row(64_005)],
    recordedChildPid: null,
    root: "relative\\root",
    expect: {
      survivorsPresent: true,
      survivorPids: [],
      reasonContains: "not resolvable",
    },
  },
  {
    name: "an unresolvable recorded child pid fails closed",
    build: () => [row(64_006)],
    recordedChildPid: 1.5,
    expect: {
      survivorsPresent: true,
      survivorPids: [],
      reasonContains: "recorded child pid",
    },
  },
];

/*
 * Integration fixture: staged managed root, fake process layer, fake clock,
 * and a fake provisioning seam. Only the survivor views vary per test.
 */

class FakeProcessLayer implements ManagedRuntimeProcessLayer {
  platform: NodeJS.Platform = "win32";
  spawned: Array<{ request: ManagedRuntimeSpawnRequest; pid: number }> = [];
  terminations: Array<{ pid: number; mode: "terminate" | "force" }> = [];
  private readonly processes = new Map<number, ManagedRuntimeProcessFacts>();
  private readonly candidates = new Map<
    number,
    ManagedRuntimeProcessCandidate
  >();
  private listeners: ManagedRuntimeListener[] = [];
  private nextPid = 51_000;

  get lastPid(): number {
    return this.nextPid - 1;
  }

  spawn(request: ManagedRuntimeSpawnRequest): number {
    const pid = this.nextPid;
    this.nextPid += 1;
    this.spawned.push({ request, pid });
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
    return this.processes.get(pid) ?? null;
  }

  listenersOnPort(port: number): ManagedRuntimeListener[] {
    return this.listeners.filter((listener) => listener.port === port);
  }

  terminate(pid: number, mode: "terminate" | "force"): void {
    this.terminations.push({ pid, mode });
    this.processes.delete(pid);
    this.listeners = this.listeners.filter((listener) => listener.pid !== pid);
  }

  rootScopedSurvivors(
    query: ManagedRuntimeSurvivorQuery,
  ): ManagedRuntimeSurvivorAssessment {
    return rootScopedSurvivors([...this.candidates.values()], query);
  }

  addCandidate(entry: ManagedRuntimeProcessCandidate): void {
    this.candidates.set(entry.pid, entry);
  }

  registerProcess(pid: number): void {
    this.processes.set(pid, {
      pid,
      executablePath: "fixture.exe",
      startedAt: SPAWNED_AT,
    });
  }

  addListener(pid: number): void {
    this.listeners = [
      ...this.listeners,
      { address: MANAGED_RUNTIME_HOST, port: MANAGED_RUNTIME_PORT, pid },
    ];
  }

  clearListeners(): void {
    this.listeners = [];
  }
}

interface RuntimeFixture {
  root: string;
  paths: ManagedRuntimePaths;
  resolvedInterpreterPath: string;
  layer: FakeProcessLayer;
  dependencies: ManagedRuntimeDependencies;
  options: () => ManagedRuntimeOptions;
  stateRecord: () => Record<string, unknown> | null;
}

function createRuntimeFixture(): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), "ultrasearch-survivor-matrix-"));
  temporaryRoots.push(root);
  const paths = managedRuntimePathsForRoot(root);
  const venvRoot = paths.venvRoot;
  const resolvedInterpreterPath = join(root, "python-base", "python.exe");
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
  writeFileSync(resolvedInterpreterPath, RESOLVED_INTERPRETER_CONTENTS, "utf8");
  writeFileSync(
    join(venvRoot, "pyvenv.cfg"),
    `home = ${dirname(resolvedInterpreterPath)}\nimplementation = CPython\n`,
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
    resolvedInterpreterPath,
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

async function provisionedFixture(): Promise<RuntimeFixture> {
  const fixture = createRuntimeFixture();
  const provisioned = await provisionManagedRuntime(fixture.options());
  expect(provisioned.outcome).toBe("provisioned");
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

/** A root-referencing orphan: its parent chain never reaches the child. */
function rootReferencingOrphan(
  fixture: RuntimeFixture,
  pid = 91_002,
): ManagedRuntimeProcessCandidate {
  return {
    pid,
    parentPid: 910_000,
    executablePath: fixture.resolvedInterpreterPath,
    commandLine: `"${fixture.resolvedInterpreterPath}" -m searx.webapp --settings ${join(fixture.root, "searxng", "searx", "settings.yml")}`,
  };
}

/** A foreign same-image process: same image, no root reference at all. */
function foreignSameImage(
  fixture: RuntimeFixture,
  pid = 91_001,
): ManagedRuntimeProcessCandidate {
  return {
    pid,
    parentPid: 910_000,
    executablePath: fixture.resolvedInterpreterPath,
    commandLine:
      '"C:\\tools\\codex-router\\.venv\\Scripts\\litellm.exe" --config C:\\tools\\codex-router\\litellm.yaml --host 127.0.0.1 --port 4200',
  };
}

describe("Control Plane survivor and cleanup matrix", () => {
  let predicateRoot: string;

  beforeEach(() => {
    predicateRoot = mkdtempSync(join(tmpdir(), "ultrasearch-h5-predicate-"));
    temporaryRoots.push(predicateRoot);
  });

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A fixture that resisted deletion is reported by its own test.
      }
      expect(existsSync(root)).toBe(false);
    }
  });

  it.each(PREDICATE_ROWS)("$name", (predicateRow) => {
    const root = predicateRow.root ?? predicateRoot;
    const candidates = predicateRow.build(root);

    const assessment = rootScopedSurvivors(candidates, {
      managedRoot: root,
      recordedChildPid: predicateRow.recordedChildPid,
    });

    expect(assessment.survivorsPresent).toBe(
      predicateRow.expect.survivorsPresent,
    );
    expect(assessment.survivorPids).toEqual(predicateRow.expect.survivorPids);
    if (predicateRow.expect.reasonContains === undefined) {
      expect(assessment.unverifiableReason).toBeNull();
    } else {
      expect(assessment.unverifiableReason).toContain(
        predicateRow.expect.reasonContains,
      );
    }
  });

  it("keeps the conclusive zero-survivor shape as the only shape readable as zero", () => {
    const foreign = row(65_001, {
      executablePath: join(predicateRoot, "python.exe"),
      commandLine:
        '"C:\\tools\\codex-router\\.venv\\Scripts\\litellm.exe" --config C:\\tools\\codex-router\\litellm.yaml',
    });

    const conclusive = rootScopedSurvivors([foreign], {
      managedRoot: predicateRoot,
      recordedChildPid: RECORDED_CHILD_PID,
    });
    const inconclusive = rootScopedSurvivors(
      [row(65_002, { commandLine: null })],
      { managedRoot: predicateRoot, recordedChildPid: RECORDED_CHILD_PID },
    );

    expect(conclusive).toEqual({
      survivorsPresent: false,
      survivorPids: [],
      unverifiableReason: null,
    });
    expect(inconclusive.survivorsPresent).toBe(true);
    expect(inconclusive.unverifiableReason).not.toBeNull();
  });

  it("refuses stop_unverified when a root-referencing orphan survives the verified stop", async () => {
    const { fixture, pid } = await startedFixture();
    const orphan = rootReferencingOrphan(fixture);
    fixture.layer.addCandidate(orphan);

    const error = await expectRefusal(() =>
      stopManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("stop_unverified");
    expect(error.detail).toContain("root-owned survivor process(es) remain");
    expect(fixture.layer.terminations).toEqual([{ pid, mode: "terminate" }]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "stop_unverified" },
    });
    expect(
      fixture.layer.rootScopedSurvivors({
        managedRoot: fixture.root,
        recordedChildPid: pid,
      }).survivorPids,
    ).toEqual([orphan.pid]);
  });

  it("stops normally when the only same-image process is a foreign one with no root reference", async () => {
    const { fixture, pid } = await startedFixture();
    fixture.layer.addCandidate(foreignSameImage(fixture));
    expect(
      fixture.layer.rootScopedSurvivors({
        managedRoot: fixture.root,
        recordedChildPid: pid,
      }),
    ).toEqual({
      survivorsPresent: false,
      survivorPids: [],
      unverifiableReason: null,
    });

    const stopped = await stopManagedRuntime(fixture.options());

    expect(stopped.outcome).toBe("stopped");
    expect(fixture.layer.terminations).toEqual([{ pid, mode: "terminate" }]);
    expect(fixture.stateRecord()).toMatchObject({
      state: "provisioned",
      childPid: null,
      lastStop: { at: SPAWNED_AT, method: "terminate" },
    });
  });

  it("refuses cleanup_incomplete when a root-referencing orphan remains, on a record-bearing and on a marker-only root", async () => {
    const recordBearing = await provisionedFixture();
    const recordOrphan = rootReferencingOrphan(recordBearing);
    recordBearing.layer.addCandidate(recordOrphan);

    const recordError = await expectRefusal(() =>
      cleanupManagedRuntime(recordBearing.options()),
    );

    expect(recordError.code).toBe("cleanup_incomplete");
    expect(recordError.detail).toContain("1 survivor process(es)");
    expect(existsSync(recordBearing.root)).toBe(false);
    expect(
      rootScopedSurvivors([recordOrphan], {
        managedRoot: recordBearing.root,
        recordedChildPid: null,
      }).survivorPids,
    ).toEqual([recordOrphan.pid]);

    // The cleanup fallback with no state record keeps the same root-scoped
    // rule, keyed on the target root path alone.
    const markerOnly = createRuntimeFixture();
    writeFileSync(join(markerOnly.root, MANAGED_RUNTIME_MARKER_FILE), "{}\n");
    const markerOrphan = rootReferencingOrphan(markerOnly, 91_003);
    markerOnly.layer.addCandidate(markerOrphan);

    const markerError = await expectRefusal(() =>
      cleanupManagedRuntime(markerOnly.options()),
    );

    expect(markerError.code).toBe("cleanup_incomplete");
    expect(existsSync(markerOnly.root)).toBe(false);
  });

  it("proves pathAbsent, listenersAfter, survivorPids, and already_absent on re-call", async () => {
    const fixture = await provisionedFixture();
    fixture.layer.addCandidate(foreignSameImage(fixture));

    const cleaned: ManagedRuntimeCleanupResult = await cleanupManagedRuntime(
      fixture.options(),
    );

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

    const again = await cleanupManagedRuntime(fixture.options());

    expect(again.outcome).toBe("already_absent");
    expect(again).toMatchObject({
      pathAbsent: true,
      listenersAfter: 0,
      survivorPids: [],
      clearedLockPids: [],
    });
  });

  it("requires the managed marker and leaves the directory byte-identical when it is missing", async () => {
    const staged = createRuntimeFixture();
    const stagedBefore = snapshotTree(staged.root);

    const stagedError = await expectRefusal(() =>
      cleanupManagedRuntime(staged.options()),
    );

    expect(stagedError.code).toBe("root_marker_missing");
    expect(snapshotTree(staged.root)).toEqual(stagedBefore);

    // A record-bearing root whose marker was removed refuses the same way,
    // before the root lock or any state write.
    const recorded = await provisionedFixture();
    rmSync(join(recorded.root, MANAGED_RUNTIME_MARKER_FILE));
    const recordedBefore = snapshotTree(recorded.root);

    const recordedError = await expectRefusal(() =>
      cleanupManagedRuntime(recorded.options()),
    );

    expect(recordedError.code).toBe("root_marker_missing");
    expect(snapshotTree(recorded.root)).toEqual(recordedBefore);
    expect(recorded.stateRecord()).toMatchObject({ state: "provisioned" });
  });

  it("refuses a live lock with state_conflict and leaves the directory byte-identical", async () => {
    const fixture = await provisionedFixture();
    const lockPath = join(fixture.root, MANAGED_RUNTIME_LOCK_FILE);
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 812_345, at: SPAWNED_AT })}\n`,
      "utf8",
    );
    // The lock holder resolves in the process layer, so it is a live lock that
    // cleanup may not clear.
    fixture.layer.registerProcess(812_345);
    const before = snapshotTree(fixture.root);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("state_conflict");
    expect(snapshotTree(fixture.root)).toEqual(before);
    expect(fixture.stateRecord()).toMatchObject({ state: "provisioned" });
  });

  it("refuses a non-isolated managed root before touching anything", async () => {
    const driveRoot = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(parse(tmpdir()).root),
      }),
    );
    expect(driveRoot.code).toBe("managed_root_refused");

    const homeRoot = await expectRefusal(() =>
      cleanupManagedRuntime({ paths: managedRuntimePathsForRoot(homedir()) }),
    );
    expect(homeRoot.code).toBe("managed_root_refused");

    const repository = mkdtempSync(join(tmpdir(), "ultrasearch-h5-repo-"));
    temporaryRoots.push(repository);
    fixtureGit(repository, ["init"]);
    const gitWorkingTree = await expectRefusal(() =>
      cleanupManagedRuntime({
        paths: managedRuntimePathsForRoot(repository),
      }),
    );
    expect(gitWorkingTree.code).toBe("managed_root_refused");
  });

  it("refuses cleanup while a listener owns the port, leaving every pre-existing file unchanged", async () => {
    const fixture = createRuntimeFixture();
    writeFileSync(join(fixture.root, MANAGED_RUNTIME_MARKER_FILE), "{}\n");
    // A marker-only root: no state record, so the refusal persists nothing.
    fixture.layer.addListener(900_002);
    const filesBefore = snapshotTree(fixture.root);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("cleanup_refused");
    expect(error.detail).toContain("listeners still own");
    expect(existsSync(fixture.root)).toBe(true);
    const filesAfter = snapshotTree(fixture.root);
    for (const [key, digest] of Object.entries(filesBefore)) {
      expect(filesAfter[key]).toBe(digest);
    }
    // The single-writer lock is created and removed by the refused section; no
    // pre-existing file changes, and the only new entry is the empty state
    // directory the lock lived in.
    expect(
      Object.keys(filesAfter).filter((key) => !(key in filesBefore)),
    ).toEqual(["state/"]);
    expect(existsSync(join(fixture.root, MANAGED_RUNTIME_LOCK_FILE))).toBe(
      false,
    );
  });

  it("refuses cleanup while the recorded child is active even with no listener", async () => {
    const { fixture } = await startedFixture();
    fixture.layer.clearListeners();
    expect(fixture.layer.listenersOnPort(MANAGED_RUNTIME_PORT)).toEqual([]);

    const error = await expectRefusal(() =>
      cleanupManagedRuntime(fixture.options()),
    );

    expect(error.code).toBe("cleanup_refused");
    expect(error.detail).toContain("still running");
    expect(existsSync(fixture.root)).toBe(true);
    expect(fixture.stateRecord()).toMatchObject({
      state: "failed",
      lastRefusal: { code: "cleanup_refused" },
    });
  });
});
