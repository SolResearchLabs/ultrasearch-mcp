import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySearxngWindowsPatch,
  ProvisioningRefusalError,
} from "./provisioning.js";

/**
 * Control Plane managed local runtime lifecycle.
 *
 * This module owns the verified local lifecycle over the Stage C3-proven path:
 * it verifies and patches a caller-staged managed root through the production
 * `applySearxngWindowsPatch` entry, starts the resolved recorded interpreter
 * detached on `127.0.0.1:18099` with a strict allowlisted child environment,
 * verifies readiness and the single-listener/one-owner invariant before
 * reporting `running`, stops only the recorded process after re-verifying its
 * identity, and deletes the managed root with proof.
 *
 * Interpreter resolution (`DQ-034` R1b): the recorded interpreter is the
 * RESOLVED CPython binary, never the venv redirector launcher. At provision
 * time the module resolves it deterministically without uv automation - an
 * explicit caller-provided `interpreterPath` override, or the venv's
 * `pyvenv.cfg` (`executable` / `home` keys) under the venv root - verifies the
 * file exists, refuses with `interpreter_missing` when resolution is missing or
 * ambiguous, refuses with `interpreter_redirector_detected` when the candidate
 * is the venv's own launcher, and records the path with its SHA-256. `start`
 * re-hashes the recorded interpreter before spawning (`interpreter_missing`
 * when the file is gone, `interpreter_redirector_detected` when the recorded
 * digest no longer matches) and verifies the spawned process image after the
 * spawn, so a redirector or a forking wrapper can never be reported as
 * `running`. The child receives the venv's site-packages on `PYTHONPATH`,
 * derived from the venv root - never from the interpreter path.
 *
 * Venv immutability (`DQ-034` R1b, mechanism named per `DQ-036` R1): the module
 * never copies, replaces, writes, or deletes any file inside `<root>\.venv`
 * during provision, start, stop, or repair, and the managed child cannot write
 * bytecode caches there either: every child spawn routes through one request
 * builder that passes `-B` to CPython and binds `PYTHONDONTWRITEBYTECODE=1`
 * unconditionally in the allowlisted child environment (never sourced from
 * ambient `process.env`), so the child creates no `__pycache__/*.pyc` inside
 * `<root>\.venv` even on first import. Cleanup deletes the managed root as a
 * whole, which is the only operation that removes the venv tree; even then no
 * attribute is rewritten inside it.
 *
 * Fail-closed rules:
 * - Refusals throw `ManagedRuntimeRefusalError`; they are never downgraded to
 *   warnings, and no fallback, fuzzy apply, or blind kill exists.
 * - The module never fetches the pin, never creates an interpreter, and never
 *   installs packages: it verifies and patches a caller-staged root only.
 * - The module writes nothing outside the managed root and never into a
 *   repository.
 * - Generated secrets are passed to the child only and are never persisted,
 *   printed, or copied into state.
 * - Survivor scans are root-scoped (`DQ-035` R1): an enumerated process counts
 *   as a survivor of the managed runtime only when its pid is the recorded
 *   child or a descendant of it, or when its command line references the
 *   resolved managed root on a path-component boundary. Image-path equality
 *   alone never makes a process a survivor, and the scan fails closed
 *   (survivors present) when the root, the recorded child pid, a command line,
 *   or a parent chain cannot be resolved.
 * - Windows-first: process and listener identity verification is implemented
 *   for Windows; other platforms refuse with `unsupported_platform`.
 *
 * There is no resident watcher, no auto-restart, and no OS service
 * registration. Supervision is the on-demand `reconcile`/`status` derivation.
 */

export const MANAGED_RUNTIME_HOST = "127.0.0.1" as const;
export const MANAGED_RUNTIME_PORT = 18099 as const;
export const MANAGED_RUNTIME_READINESS_PATH = "/" as const;
export const MANAGED_RUNTIME_READINESS_TIMEOUT_MS = 60_000;
export const MANAGED_RUNTIME_READINESS_POLL_INTERVAL_MS = 250;
export const MANAGED_RUNTIME_READINESS_PROBE_TIMEOUT_MS = 1_000;
export const MANAGED_RUNTIME_STOP_TIMEOUT_MS = 15_000;
export const MANAGED_RUNTIME_STOP_POLL_INTERVAL_MS = 250;
export const MANAGED_RUNTIME_MARKER_FILE = ".ultrasearch-managed-runtime";
export const MANAGED_RUNTIME_STATE_FILE = "state/managed-runtime.json";
export const MANAGED_RUNTIME_LOCK_FILE = "state/lock.json";

/** Relative path of the patched file inside the managed checkout. */
export const SEARXNG_VALKEYDB_RELATIVE_PATH = "searx/valkeydb.py";

/** Recorded Stage C2/C3 digest of the pristine pinned `searx/valkeydb.py`. */
export const SEARXNG_PRISTINE_VALKEYDB_SHA256 =
  "9c8330ecbd983d11f0972a741a8f80bff555dcbb08f00ac08022621c0870ca37";

/** Recorded Stage C2/C3 digest of the patched `searx/valkeydb.py`. */
export const SEARXNG_PATCHED_VALKEYDB_SHA256 =
  "288f9e284299033e6074fe3de577db4ae92dfc006973fd2771beca2078980658";

/**
 * Names that may appear in the child environment. The environment is built
 * from this allowlist rather than inherited, so ambient provider credentials
 * cannot leak into the sidecar. `SEARXNG_SECRET` is generated per start and
 * only its name is ever persisted. `PYTHONDONTWRITEBYTECODE` is present here
 * and its value is bound to `"1"` by the child-environment builder
 * unconditionally - never taken from ambient `process.env` - so the child
 * cannot write bytecode into `.venv` (`DQ-036` R1).
 */
export const MANAGED_RUNTIME_CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "SystemRoot",
  "PATHEXT",
  "TEMP",
  "TMP",
  "PYTHONPATH",
  "PYTHONDONTWRITEBYTECODE",
  "SEARXNG_SETTINGS_PATH",
  "SEARXNG_DISABLE_ETC_SETTINGS",
  "SEARXNG_SECRET",
] as const;

export type ManagedRuntimeLifecycleState =
  | "absent"
  | "unverified"
  | "provisioned"
  | "starting"
  | "running"
  | "stopping"
  | "stale"
  | "failed";

export const MANAGED_RUNTIME_REFUSAL_CODES = [
  "unsupported_platform",
  "managed_root_refused",
  "root_marker_missing",
  "checkout_missing",
  "archive_missing",
  "patch_missing",
  "provisioning_refused",
  "patch_state_unknown",
  "interpreter_missing",
  "interpreter_redirector_detected",
  "state_corrupt",
  "state_conflict",
  "port_in_use_foreign",
  "already_failed",
  "spawn_failed",
  "readiness_timeout",
  "readiness_rejected",
  "listener_invariant_violated",
  "pid_identity_mismatch",
  "stop_timeout",
  "stop_unverified",
  "cleanup_refused",
  "cleanup_incomplete",
] as const;

export type ManagedRuntimeRefusalCode =
  (typeof MANAGED_RUNTIME_REFUSAL_CODES)[number];

/**
 * Fail-closed refusal for the managed lifecycle. Every refusal carries a typed
 * code and a detail string; nothing is retried with a weaker check.
 */
export class ManagedRuntimeRefusalError extends Error {
  readonly code: ManagedRuntimeRefusalCode;
  readonly detail: string;

  constructor(code: ManagedRuntimeRefusalCode, detail: string) {
    super(`Managed runtime refused (${code}): ${detail}`);
    this.name = "ManagedRuntimeRefusalError";
    this.code = code;
    this.detail = detail;
  }
}

export interface ManagedRuntimePaths {
  managedRoot: string;
  checkoutPath: string;
  archivePath: string;
  patchPath: string;
  /**
   * Explicit resolved-CPython interpreter override. `null` (the default from
   * `managedRuntimePathsForRoot`) means the interpreter is resolved from
   * `<venvRoot>/pyvenv.cfg`; a provided value must be the resolved base
   * interpreter, never the venv's own redirector launcher.
   */
  interpreterPath: string | null;
  /**
   * Venv root (`<root>\.venv` by default). Site-packages are derived from this
   * root, never from the interpreter path, and nothing inside it is written,
   * replaced, or deleted by the lifecycle (`DQ-034` R1b); the managed child is
   * spawned with `-B` and a child environment that binds
   * `PYTHONDONTWRITEBYTECODE=1` unconditionally, so it writes no bytecode
   * caches inside this tree (`DQ-036` R1).
   */
  venvRoot: string;
}

export interface ManagedRuntimeVerification {
  pinCommit: string;
  treeId: string;
  archiveSha256: string;
  patchSha256: string;
  patchedFileSha256: string;
  interpreterPath: string;
}

export interface ManagedRuntimeStatus {
  state: ManagedRuntimeLifecycleState;
  endpoint: string;
  port: number;
  pid: number | null;
  generation: number;
  ownership: "ultrasearch_managed" | "none";
  verification: ManagedRuntimeVerification | null;
  lastReadiness: { status: number; at: string; elapsedMs: number } | null;
  lastStop: { at: string; method: "terminate" | "force" } | null;
  lastCrash: { at: string; detection: string } | null;
  lastRefusal: { code: string; at: string; detail: string } | null;
  observedAt: string;
  stateFile: string;
}

export type ManagedRuntimeOperationOutcome =
  | "provisioned"
  | "already_provisioned"
  | "started"
  | "already_running"
  | "stopped"
  | "already_stopped"
  | "restarted";

export interface ManagedRuntimeOperationResult {
  outcome: ManagedRuntimeOperationOutcome;
  note?: string;
  status: ManagedRuntimeStatus;
}

export interface ManagedRuntimeCleanupResult {
  outcome: "deleted" | "already_absent";
  managedRoot: string;
  lastState: ManagedRuntimeLifecycleState;
  pathAbsent: boolean;
  port: number;
  listenersAfter: number;
  survivorPids: number[];
  /** Dead lock holders cleared by this cleanup, recorded before deletion. */
  clearedLockPids: number[];
  verifiedAt: string;
}

export interface ManagedRuntimeProcessFacts {
  pid: number;
  executablePath: string | null;
  startedAt: string | null;
}

/**
 * One enumerated process row the root-scoped survivor predicate examines
 * (`DQ-035` R1). `executablePath` is carried for diagnostics only: image-path
 * equality never makes a process a survivor.
 */
export interface ManagedRuntimeProcessCandidate {
  pid: number;
  /** Parent pid from the OS snapshot; `null` or unresolvable is fail-closed. */
  parentPid: number | null;
  executablePath: string | null;
  commandLine: string | null;
}

/** The managed root and recorded child pid a survivor scan is scoped to. */
export interface ManagedRuntimeSurvivorQuery {
  /** Resolved managed root; the command-line rule matches this exact path. */
  managedRoot: string;
  /**
   * The recorded child pid, or `null` when no state record names one (the
   * cleanup fallback keyed on the managed root alone). A non-null value that
   * is not a resolvable process id is fail-closed.
   */
  recordedChildPid: number | null;
}

/**
 * Root-scoped survivor assessment. `survivorsPresent` is the refusal input:
 * it is true when the scan found root-owned pids AND when the scan could not
 * be completed (`unverifiableReason`), so an unresolvable input is never read
 * as zero survivors. A conclusive scan reports `survivorsPresent: false`,
 * `survivorPids: []`, and a null reason - that is the only shape that may
 * ever be read as zero survivors.
 */
export interface ManagedRuntimeSurvivorAssessment {
  survivorsPresent: boolean;
  survivorPids: number[];
  unverifiableReason: string | null;
}

export interface ManagedRuntimeListener {
  address: string;
  port: number;
  pid: number;
}

export interface ManagedRuntimeSpawnRequest {
  executablePath: string;
  args: readonly string[];
  cwd: string;
  environment: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * The only OS-touching seam. The default implementation is Windows-first and
 * uses PowerShell process/listener inspection; tests inject fakes.
 */
export interface ManagedRuntimeProcessLayer {
  readonly platform: NodeJS.Platform;
  spawn(request: ManagedRuntimeSpawnRequest): number;
  inspect(pid: number): ManagedRuntimeProcessFacts | null;
  listenersOnPort(port: number): ManagedRuntimeListener[];
  terminate(pid: number, mode: "terminate" | "force"): void;
  /**
   * Root-scoped survivor scan (`DQ-035` R1). The only survivor sources are the
   * managed root: recorded-child pid/descendants, or a command line that
   * contains the resolved managed root path on a path-component boundary. A
   * foreign process that merely runs the same interpreter image is never a
   * survivor, and unresolved root/pid/command-line/parent-chain inputs report
   * survivors present (fail-closed) instead of zero.
   */
  rootScopedSurvivors(
    query: ManagedRuntimeSurvivorQuery,
  ): ManagedRuntimeSurvivorAssessment;
}

export interface ManagedRuntimeReadinessResult {
  status: number;
}

export type ManagedRuntimeReadinessProbe = (
  endpoint: string,
) => Promise<ManagedRuntimeReadinessResult>;

export interface ManagedRuntimeDependencies {
  /** Defaults to the production `applySearxngWindowsPatch` entry. */
  applyWindowsPatch?: typeof applySearxngWindowsPatch;
  processLayer?: ManagedRuntimeProcessLayer;
  readinessProbe?: ManagedRuntimeReadinessProbe;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Test-only expected digests. Production callers never set this: the
   * recorded Stage C2/C3 constants are used when it is absent, so a synthetic
   * fixture can never satisfy the production entry.
   */
  expectedDigests?: {
    pristineValkeydbSha256: string;
    patchedValkeydbSha256: string;
  };
}

export interface ManagedRuntimeOptions {
  paths: ManagedRuntimePaths;
  /** Defaults to `MANAGED_RUNTIME_PORT`; tests may override per call. */
  port?: number;
  /** Caller-staged SearXNG settings; defaults inside the checkout. */
  settingsPath?: string;
  dependencies?: ManagedRuntimeDependencies;
}

export function managedRuntimePathsForRoot(
  managedRoot: string,
): ManagedRuntimePaths {
  const root = resolve(managedRoot);
  return {
    managedRoot: root,
    checkoutPath: join(root, "searxng"),
    archivePath: join(root, "searxng-source.tar"),
    patchPath: join(root, "artifacts", "valkeydb-windows.patch"),
    // The module resolves the base CPython itself; the venv's
    // `Scripts\python.exe` redirector launcher is never recorded or spawned.
    interpreterPath: null,
    venvRoot: join(root, ".venv"),
  };
}

/** Product default root: `%LOCALAPPDATA%\UltraSearch\runtime`. */
export function defaultManagedRuntimeRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const base =
    localAppData !== undefined && localAppData.length > 0
      ? localAppData
      : join(homedir(), "AppData", "Local");
  return join(base, "UltraSearch", "runtime");
}

let testManagedRuntimePort: number | undefined;

/**
 * Test-only module-level port override. It is never a configuration key, an
 * environment key, or a CLI flag; production callers leave it unset and the
 * managed runtime always uses `MANAGED_RUNTIME_PORT`.
 */
export function setManagedRuntimePortForTests(port: number | undefined): void {
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port <= 0 || port > 65_535)
  ) {
    throw new RangeError(`invalid managed runtime test port: ${port}`);
  }
  testManagedRuntimePort = port;
}

interface ResolvedManagedRuntime {
  paths: ManagedRuntimePaths;
  port: number;
  endpoint: string;
  settingsPath: string;
  venvRoot: string;
  venvLauncherPath: string;
  sitePackagesPath: string;
  tmpPath: string;
  logsPath: string;
  stateFile: string;
  lockFile: string;
  markerFile: string;
  valkeydbPath: string;
  identity: { pristineValkeydbSha256: string; patchedValkeydbSha256: string };
  processLayer: ManagedRuntimeProcessLayer;
  readinessProbe: ManagedRuntimeReadinessProbe;
  applyWindowsPatch: typeof applySearxngWindowsPatch;
  clock: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * A resolved base-CPython interpreter with its recorded SHA-256. It is the
 * only interpreter identity the lifecycle records, spawns, and verifies.
 */
interface ResolvedInterpreter {
  interpreterPath: string;
  interpreterSha256: string;
}

function refuse(
  code: ManagedRuntimeRefusalCode,
  detail: string,
): ManagedRuntimeRefusalError {
  return new ManagedRuntimeRefusalError(code, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === code
  );
}

function resolveManagedRuntime(
  options: ManagedRuntimeOptions,
): ResolvedManagedRuntime {
  const root = resolve(options.paths.managedRoot);
  const port = options.port ?? testManagedRuntimePort ?? MANAGED_RUNTIME_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new RangeError(`invalid managed runtime port: ${port}`);
  }
  const checkoutPath = resolve(options.paths.checkoutPath);
  const interpreterOverridePath =
    options.paths.interpreterPath === null
      ? null
      : resolve(options.paths.interpreterPath);
  const venvRoot = resolve(options.paths.venvRoot);
  const identity = options.dependencies?.expectedDigests ?? {
    pristineValkeydbSha256: SEARXNG_PRISTINE_VALKEYDB_SHA256,
    patchedValkeydbSha256: SEARXNG_PATCHED_VALKEYDB_SHA256,
  };
  const dependencies = options.dependencies ?? {};

  return {
    paths: {
      managedRoot: root,
      checkoutPath,
      archivePath: resolve(options.paths.archivePath),
      patchPath: resolve(options.paths.patchPath),
      interpreterPath: interpreterOverridePath,
      venvRoot,
    },
    port,
    endpoint: `http://${MANAGED_RUNTIME_HOST}:${port}`,
    settingsPath:
      options.settingsPath ?? join(checkoutPath, "searx", "settings.yml"),
    venvRoot,
    venvLauncherPath: join(venvRoot, "Scripts", "python.exe"),
    // Site-packages always derive from the venv root, never from the
    // interpreter path (`DQ-034` R1b, Stage B/C3 precedent).
    sitePackagesPath: join(venvRoot, "Lib", "site-packages"),
    tmpPath: join(root, "tmp"),
    logsPath: join(root, "logs"),
    stateFile: join(root, MANAGED_RUNTIME_STATE_FILE),
    lockFile: join(root, MANAGED_RUNTIME_LOCK_FILE),
    markerFile: join(root, MANAGED_RUNTIME_MARKER_FILE),
    valkeydbPath: join(checkoutPath, SEARXNG_VALKEYDB_RELATIVE_PATH),
    identity,
    processLayer: dependencies.processLayer ?? defaultProcessLayer,
    readinessProbe: dependencies.readinessProbe ?? defaultReadinessProbe,
    applyWindowsPatch:
      dependencies.applyWindowsPatch ?? applySearxngWindowsPatch,
    clock: dependencies.clock ?? (() => new Date()),
    sleep:
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((settle) => setTimeout(settle, milliseconds))),
  };
}

/*
 * Managed root isolation: the root must be a stable, private location. It is
 * refused when it is a drive root, the home directory itself, a reparse point
 * (itself or any existing ancestor component), inside the UltraSearch
 * installation, or itself a git working tree. Descendants of the home root
 * such as `%LOCALAPPDATA%` and `%TEMP%` roots are permitted, which is what the
 * disposable gate-run root and the product default root both resolve to.
 *
 * Disclosed residual: the product cannot name an arbitrary repository (for
 * example the lab repository) by path. An arbitrary repository path is refused
 * instead by install-root containment, the root-is-git-worktree check, and the
 * gate-run staging discipline (the gate stages a disposable root under
 * `%TEMP%`).
 */

let installationRootCache: string | null | undefined;

function managedRuntimeInstallationRoot(): string | null {
  if (installationRootCache !== undefined) return installationRootCache;
  installationRootCache = null;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, "package.json"))) {
      installationRootCache = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return installationRootCache;
}

function comparablePath(value: string): string {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function containsPath(parent: string, child: string): boolean {
  const parentPath = comparablePath(parent);
  const childPath = comparablePath(child);
  return (
    childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`)
  );
}

/**
 * Components of `path` from the filesystem root down to the path itself. The
 * drive/UNC root is not a component: it is checked separately by the caller.
 */
function pathComponentsFromRoot(path: string): string[] {
  const resolved = resolve(path);
  const { root } = parse(resolved);
  const components: string[] = [];
  let current = root;
  for (const segment of resolved.slice(root.length).split(sep)) {
    if (segment.length === 0) continue;
    current = join(current, segment);
    components.push(current);
  }
  return components;
}

/**
 * First existing component of `path` that is a reparse point (a junction or
 * symlink), walking from the filesystem root down to the path itself, or
 * `null` when every existing component is a plain directory. A missing
 * component ends the walk: nothing below it can exist, and a missing root is
 * inspected again by the operation that needs it.
 */
function firstReparsePointComponent(path: string): string | null {
  for (const component of pathComponentsFromRoot(path)) {
    try {
      if (lstatSync(component).isSymbolicLink()) return component;
    } catch {
      return null;
    }
  }
  return null;
}

function assertManagedRootAllowed(managedRoot: string): void {
  const root = resolve(managedRoot);
  // Path equality is case-insensitive on Windows (NTFS); a case-variant home
  // or drive root must be refused exactly like the canonical spelling.
  if (comparablePath(root) === comparablePath(parse(root).root)) {
    throw refuse(
      "managed_root_refused",
      `the managed root must not be a drive root: ${root}`,
    );
  }
  if (comparablePath(root) === comparablePath(homedir())) {
    throw refuse(
      "managed_root_refused",
      `the managed root must not be the home directory itself: ${root}`,
    );
  }
  const installationRoot = managedRuntimeInstallationRoot();
  if (installationRoot !== null && containsPath(installationRoot, root)) {
    throw refuse(
      "managed_root_refused",
      `the managed root must not be inside the UltraSearch installation: ${root}`,
    );
  }
  // The root must not be a repository working tree. Only the root itself is
  // inspected: an ancestor-wide `.git` search would also refuse disposable
  // `%TEMP%` roots on hosts where the temp directory is itself a repository.
  if (existsSync(join(root, ".git"))) {
    throw refuse(
      "managed_root_refused",
      `the managed root must not be a git working tree: ${root}`,
    );
  }
  // A reparse point redirects the location the isolation rules approved, so it
  // is refused for the root itself and for every existing ancestor component.
  const reparsePoint = firstReparsePointComponent(root);
  if (reparsePoint !== null) {
    throw refuse(
      "managed_root_refused",
      `the managed root must not be a reparse point or live below one: ${reparsePoint}`,
    );
  }
}

/*
 * Persisted state. The state file is written atomically (temp file + rename)
 * by mutating operations only. It never contains a secret, an environment
 * value, or a credentials.
 */

interface ManagedRuntimeStateRecord {
  schemaVersion: 1;
  state: Exclude<ManagedRuntimeLifecycleState, "absent">;
  generation: number;
  pinCommit: string | null;
  treeId: string | null;
  archiveSha256: string | null;
  patchSha256: string | null;
  patchedFileSha256: string | null;
  interpreterPath: string | null;
  /**
   * SHA-256 of the resolved base interpreter at `interpreterPath`. A record
   * written before the `DQ-034` R1b repair carries no digest; it is read as
   * `null` and is upgraded by provision/repair, never trusted by `start`.
   */
  interpreterSha256: string | null;
  checkoutPath: string | null;
  port: number;
  endpoint: string;
  childPid: number | null;
  childStartedAt: string | null;
  childExecutable: string | null;
  environmentKeys: string[];
  lastReadiness: { status: number; at: string; elapsedMs: number } | null;
  lastStop: { at: string; method: "terminate" | "force" } | null;
  lastCrash: { at: string; detection: string } | null;
  lastRefusal: { code: string; at: string; detail: string } | null;
  lockEvents: { at: string; pid: number; reason: string }[];
  updatedAt: string;
}

/*
 * States that may appear in a persisted record. `starting` is written by
 * `start` before the readiness wait; `stopping` and `unverified` are
 * persisted-capable but read-only today, because no operation writes them (a
 * refusing mutating operation persists `failed` + `lastRefusal` instead). The
 * crash rule still applies to every one of them: a persisted `starting` or
 * `stopping` becomes `stale` on the next `reconcile`, and `unverified` stays
 * `unverified` until `provision`/`repair` re-verifies it.
 */
const PERSISTED_LIFECYCLE_STATES: readonly ManagedRuntimeLifecycleState[] = [
  "unverified",
  "provisioned",
  "starting",
  "running",
  "stopping",
  "stale",
  "failed",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function schemaViolation(detail: string): never {
  throw refuse(
    "state_corrupt",
    `the managed runtime state file does not match the recorded schema: ${detail}`,
  );
}

function assertStateRecord(value: unknown): ManagedRuntimeStateRecord {
  if (!isObject(value)) schemaViolation("not an object");
  if (value.schemaVersion !== 1) schemaViolation("schemaVersion is not 1");
  if (
    typeof value.state !== "string" ||
    !PERSISTED_LIFECYCLE_STATES.includes(
      value.state as ManagedRuntimeLifecycleState,
    )
  ) {
    schemaViolation("state is not a persisted lifecycle state");
  }
  if (
    typeof value.generation !== "number" ||
    !Number.isInteger(value.generation) ||
    value.generation < 0
  ) {
    schemaViolation("generation is not a non-negative integer");
  }
  // A state record written before the resolved-interpreter digest field
  // existed is read as `null` (never as a trusted identity); `start` then
  // refuses with `interpreter_missing` until provision or repair records the
  // resolved interpreter, and every other shape is rejected below.
  if (value.interpreterSha256 === undefined) value.interpreterSha256 = null;
  for (const field of [
    "pinCommit",
    "treeId",
    "archiveSha256",
    "patchSha256",
    "patchedFileSha256",
    "interpreterPath",
    "interpreterSha256",
    "checkoutPath",
    "childStartedAt",
    "childExecutable",
  ] as const) {
    if (!isNullableString(value[field]))
      schemaViolation(`${field} is not a string or null`);
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port)) {
    schemaViolation("port is not an integer");
  }
  if (typeof value.endpoint !== "string")
    schemaViolation("endpoint is not a string");
  if (
    !isNullableNumber(value.childPid) ||
    (typeof value.childPid === "number" && !Number.isInteger(value.childPid))
  ) {
    schemaViolation("childPid is not an integer or null");
  }
  if (
    !Array.isArray(value.environmentKeys) ||
    !value.environmentKeys.every((entry) => typeof entry === "string")
  ) {
    schemaViolation("environmentKeys is not a string array");
  }
  if (value.lastReadiness !== null) {
    if (
      !isObject(value.lastReadiness) ||
      typeof value.lastReadiness.status !== "number" ||
      typeof value.lastReadiness.at !== "string" ||
      typeof value.lastReadiness.elapsedMs !== "number"
    ) {
      schemaViolation("lastReadiness is malformed");
    }
  }
  if (value.lastStop !== null) {
    const method = isObject(value.lastStop) ? value.lastStop.method : undefined;
    if (
      !isObject(value.lastStop) ||
      typeof value.lastStop.at !== "string" ||
      (method !== "terminate" && method !== "force")
    ) {
      schemaViolation("lastStop is malformed");
    }
  }
  if (value.lastCrash !== null) {
    if (
      !isObject(value.lastCrash) ||
      typeof value.lastCrash.at !== "string" ||
      typeof value.lastCrash.detection !== "string"
    ) {
      schemaViolation("lastCrash is malformed");
    }
  }
  if (value.lastRefusal !== null) {
    if (
      !isObject(value.lastRefusal) ||
      typeof value.lastRefusal.code !== "string" ||
      typeof value.lastRefusal.at !== "string" ||
      typeof value.lastRefusal.detail !== "string"
    ) {
      schemaViolation("lastRefusal is malformed");
    }
  }
  if (
    !Array.isArray(value.lockEvents) ||
    !value.lockEvents.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.at === "string" &&
        typeof entry.pid === "number" &&
        typeof entry.reason === "string",
    )
  ) {
    schemaViolation("lockEvents is malformed");
  }
  if (typeof value.updatedAt !== "string")
    schemaViolation("updatedAt is not a string");

  return value as unknown as ManagedRuntimeStateRecord;
}

function readStateRecord(
  runtime: ResolvedManagedRuntime,
): ManagedRuntimeStateRecord | null {
  if (!existsSync(runtime.stateFile)) return null;
  let text: string;
  try {
    text = readFileSync(runtime.stateFile, "utf8");
  } catch (error) {
    throw refuse(
      "state_corrupt",
      `cannot read the managed runtime state file: ${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse(
      "state_corrupt",
      "the managed runtime state file is not valid JSON",
    );
  }
  return assertStateRecord(parsed);
}

function writeStateRecord(
  runtime: ResolvedManagedRuntime,
  record: ManagedRuntimeStateRecord,
): void {
  mkdirSync(dirname(runtime.stateFile), { recursive: true });
  const temporary = `${runtime.stateFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temporary, runtime.stateFile);
}

function recordWithLockEvents(
  record: ManagedRuntimeStateRecord,
  lockEvents: readonly { at: string; pid: number; reason: string }[],
  updatedAt: string,
): ManagedRuntimeStateRecord {
  if (lockEvents.length === 0) return { ...record, updatedAt };
  return {
    ...record,
    lockEvents: [...record.lockEvents, ...lockEvents].slice(-20),
    updatedAt,
  };
}

interface VerifiedManagedRuntimeRecord extends ManagedRuntimeStateRecord {
  pinCommit: string;
  treeId: string;
  archiveSha256: string;
  patchSha256: string;
  patchedFileSha256: string;
  interpreterPath: string;
}

function hasVerificationRecord(
  record: ManagedRuntimeStateRecord | null,
): record is VerifiedManagedRuntimeRecord {
  return (
    record !== null &&
    record.pinCommit !== null &&
    record.treeId !== null &&
    record.archiveSha256 !== null &&
    record.patchSha256 !== null &&
    record.patchedFileSha256 !== null &&
    record.interpreterPath !== null
  );
}

/*
 * Single-writer lock. A lock held by a dead pid is cleared only by `repair` or
 * `cleanup`, which record the event; every other operation refuses with
 * `state_conflict`.
 */

function acquireRootLock(
  runtime: ResolvedManagedRuntime,
  allowDeadLockClear: boolean,
): { at: string; pid: number; reason: string }[] {
  const lockPath = runtime.lockFile;
  mkdirSync(dirname(lockPath), { recursive: true });
  const holder = { pid: process.pid, at: runtime.clock().toISOString() };
  const contents = `${JSON.stringify(holder)}\n`;
  try {
    writeFileSync(lockPath, contents, { encoding: "utf8", flag: "wx" });
    return [];
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) {
      throw refuse(
        "state_conflict",
        `cannot take the managed runtime lock at ${lockPath}: ${errorMessage(error)}`,
      );
    }
  }

  const deadHolder = readDeadLockHolder(runtime, lockPath);
  if (deadHolder === null || !allowDeadLockClear) {
    throw refuse(
      "state_conflict",
      `the managed runtime root is locked by the state file at ${lockPath}; another mutating operation holds it`,
    );
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    throw refuse(
      "state_conflict",
      `cannot clear the dead managed runtime lock at ${lockPath}: ${errorMessage(error)}`,
    );
  }
  writeFileSync(lockPath, contents, { encoding: "utf8", flag: "wx" });
  return [
    {
      at: runtime.clock().toISOString(),
      pid: deadHolder.pid,
      reason: "dead_lock_cleared",
    },
  ];
}

function readDeadLockHolder(
  runtime: ResolvedManagedRuntime,
  lockPath: string,
): { pid: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed) || typeof parsed.pid !== "number") return null;
  if (parsed.pid === process.pid) return null;
  return runtime.processLayer.inspect(parsed.pid) === null
    ? { pid: parsed.pid }
    : null;
}

function releaseRootLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // A missing lock is already released; a stuck lock is visible to the next
    // operation as `state_conflict` and is cleared by repair or cleanup.
  }
}

async function withRootLock<T>(
  runtime: ResolvedManagedRuntime,
  allowDeadLockClear: boolean,
  run: (
    lockEvents: readonly { at: string; pid: number; reason: string }[],
  ) => Promise<T>,
): Promise<T> {
  const lockEvents = acquireRootLock(runtime, allowDeadLockClear);
  try {
    return await run(lockEvents);
  } finally {
    releaseRootLock(runtime.lockFile);
  }
}

/*
 * Digests, child environment, and readiness.
 */

function digestOfFile(
  path: string,
  missingCode: ManagedRuntimeRefusalCode,
  detail: string,
): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    throw refuse(missingCode, detail);
  }
}

function childEnvironment(
  runtime: ResolvedManagedRuntime,
  secret: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "SystemRoot", "PATHEXT"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.TEMP = runtime.tmpPath;
  environment.TMP = runtime.tmpPath;
  environment.PYTHONPATH = runtime.sitePackagesPath;
  // Bound to the constant "1" unconditionally, never sourced from ambient
  // `process.env`: the child must not write bytecode into `.venv` (`DQ-036`
  // R1); an unset ambient variable must not yield an unprotected child.
  environment.PYTHONDONTWRITEBYTECODE = "1";
  environment.SEARXNG_SETTINGS_PATH = runtime.settingsPath;
  environment.SEARXNG_DISABLE_ETC_SETTINGS = "1";
  environment.SEARXNG_SECRET = secret;
  return environment;
}

function assertSupportedPlatform(runtime: ResolvedManagedRuntime): void {
  if (runtime.processLayer.platform !== "win32") {
    throw refuse(
      "unsupported_platform",
      `process and listener identity verification is Windows-first; the current platform is ${runtime.processLayer.platform}`,
    );
  }
}

async function awaitReadiness(
  runtime: ResolvedManagedRuntime,
): Promise<{ status: number; at: string; elapsedMs: number }> {
  const startedAt = runtime.clock().getTime();
  const deadline = startedAt + MANAGED_RUNTIME_READINESS_TIMEOUT_MS;
  const url = `${runtime.endpoint}${MANAGED_RUNTIME_READINESS_PATH}`;
  let lastError = "no readiness probe completed";

  for (;;) {
    try {
      const probe = await runtime.readinessProbe(url);
      if (probe.status >= 500) {
        throw refuse(
          "readiness_rejected",
          `the managed runtime readiness probe observed HTTP ${probe.status} at ${url}`,
        );
      }
      const at = runtime.clock();
      return {
        status: probe.status,
        at: at.toISOString(),
        elapsedMs: at.getTime() - startedAt,
      };
    } catch (error) {
      if (error instanceof ManagedRuntimeRefusalError) throw error;
      lastError = errorMessage(error);
    }
    if (
      runtime.clock().getTime() + MANAGED_RUNTIME_READINESS_POLL_INTERVAL_MS >
      deadline
    ) {
      break;
    }
    await runtime.sleep(MANAGED_RUNTIME_READINESS_POLL_INTERVAL_MS);
  }

  throw refuse(
    "readiness_timeout",
    `no readiness response below 500 from ${url} within ${MANAGED_RUNTIME_READINESS_TIMEOUT_MS} ms; last error: ${lastError}`,
  );
}

async function waitForExit(
  runtime: ResolvedManagedRuntime,
  pid: number,
): Promise<boolean> {
  const deadline = runtime.clock().getTime() + MANAGED_RUNTIME_STOP_TIMEOUT_MS;
  for (;;) {
    if (runtime.processLayer.inspect(pid) === null) return true;
    if (
      runtime.clock().getTime() + MANAGED_RUNTIME_STOP_POLL_INTERVAL_MS >
      deadline
    ) {
      return runtime.processLayer.inspect(pid) === null;
    }
    await runtime.sleep(MANAGED_RUNTIME_STOP_POLL_INTERVAL_MS);
  }
}

async function terminateVerifiedChild(
  runtime: ResolvedManagedRuntime,
  pid: number,
): Promise<{ terminated: boolean; method: "terminate" | "force" }> {
  runtime.processLayer.terminate(pid, "terminate");
  if (await waitForExit(runtime, pid)) {
    return { terminated: true, method: "terminate" };
  }
  runtime.processLayer.terminate(pid, "force");
  if (await waitForExit(runtime, pid)) {
    return { terminated: true, method: "force" };
  }
  return { terminated: false, method: "force" };
}

function matchesRecordedIdentity(
  record: ManagedRuntimeStateRecord,
  facts: ManagedRuntimeProcessFacts | null,
): boolean {
  return (
    facts !== null &&
    record.childPid !== null &&
    facts.pid === record.childPid &&
    facts.executablePath === record.childExecutable &&
    facts.startedAt === record.childStartedAt
  );
}

/**
 * Best-effort verified stop of the child recorded in `record`. A pid whose
 * identity cannot be confirmed is never terminated.
 */
async function stopRecordedChildQuietly(
  runtime: ResolvedManagedRuntime,
  record: ManagedRuntimeStateRecord,
): Promise<{
  attempted: boolean;
  terminated: boolean;
  method: "terminate" | "force" | null;
}> {
  if (record.childPid === null) {
    return { attempted: false, terminated: false, method: null };
  }
  const facts = runtime.processLayer.inspect(record.childPid);
  if (facts === null) {
    return { attempted: false, terminated: false, method: null };
  }
  if (!matchesRecordedIdentity(record, facts)) {
    return { attempted: false, terminated: false, method: null };
  }
  const exit = await terminateVerifiedChild(runtime, record.childPid);
  return { attempted: true, terminated: exit.terminated, method: exit.method };
}

/**
 * Bounded terminate/force stop for a child this operation just spawned. The
 * pid was created and persisted by this call moments earlier under the root
 * lock, so the sequence does not depend on the injected inspector: an
 * inspector that fails right after the spawn would otherwise orphan the child.
 * The inspector is still consulted to confirm the exit whenever it responds.
 */
async function stopSpawnedChildWithEscalation(
  runtime: ResolvedManagedRuntime,
  record: ManagedRuntimeStateRecord,
): Promise<{
  attempted: boolean;
  terminated: boolean;
  method: "terminate" | "force" | null;
}> {
  const pid = record.childPid;
  if (pid === null) {
    return { attempted: false, terminated: false, method: null };
  }
  const attempt = async (mode: "terminate" | "force"): Promise<boolean> => {
    try {
      runtime.processLayer.terminate(pid, mode);
    } catch {
      // A terminate call that fails is reported by the exit check below.
    }
    try {
      return await waitForExit(runtime, pid);
    } catch {
      // The inspector is failing; the caller persists the refusal instead.
      return false;
    }
  };
  if (await attempt("terminate")) {
    return { attempted: true, terminated: true, method: "terminate" };
  }
  if (await attempt("force")) {
    return { attempted: true, terminated: true, method: "force" };
  }
  return { attempted: true, terminated: false, method: "force" };
}

/*
 * State derivation and status projection.
 */

interface DerivedState {
  state: ManagedRuntimeLifecycleState;
  detection: string | null;
}

/**
 * The managed runtime binds loopback only, and this product requires the
 * recorded IPv4 loopback address. `::1` is not normalized anywhere in this
 * module, so any other reported address - `0.0.0.0`, `::`, `::1`, or a routable
 * address - violates the single-listener/one-owner invariant.
 */
function listenerAddressIsLoopback(address: string | undefined): boolean {
  return address === MANAGED_RUNTIME_HOST;
}

function observedListeners(
  listeners: readonly ManagedRuntimeListener[],
): string {
  if (listeners.length === 0) return "";
  return ` (${listeners
    .map(
      (listener) =>
        `${listener.address}:${listener.port} owned by pid ${listener.pid}`,
    )
    .join(", ")})`;
}

function deriveState(
  record: ManagedRuntimeStateRecord,
  runtime: ResolvedManagedRuntime,
  mode: "safe" | "strict",
): DerivedState {
  if (record.state === "starting" || record.state === "stopping") {
    return {
      state: "stale",
      detection:
        record.state === "starting"
          ? "persisted_starting_transient"
          : "persisted_stopping_transient",
    };
  }
  if (record.state !== "running")
    return { state: record.state, detection: null };
  if (runtime.processLayer.platform !== "win32") {
    return { state: "running", detection: null };
  }

  try {
    if (record.childPid === null) {
      return { state: "stale", detection: "child_record_missing" };
    }
    const facts = runtime.processLayer.inspect(record.childPid);
    if (facts === null) {
      return { state: "stale", detection: "child_not_running" };
    }
    if (
      facts.executablePath !== record.childExecutable ||
      facts.startedAt !== record.childStartedAt
    ) {
      return { state: "stale", detection: "pid_identity_mismatch" };
    }
    const listeners = runtime.processLayer.listenersOnPort(runtime.port);
    if (
      listeners.length !== 1 ||
      listeners[0]?.pid !== record.childPid ||
      !listenerAddressIsLoopback(listeners[0]?.address)
    ) {
      return { state: "stale", detection: "listener_invariant_violated" };
    }
    return { state: "running", detection: null };
  } catch (error) {
    if (mode === "strict") throw error;
    return { state: record.state, detection: null };
  }
}

function verificationOf(
  record: ManagedRuntimeStateRecord,
): ManagedRuntimeVerification | null {
  if (!hasVerificationRecord(record)) return null;
  return {
    pinCommit: record.pinCommit,
    treeId: record.treeId,
    archiveSha256: record.archiveSha256,
    patchSha256: record.patchSha256,
    patchedFileSha256: record.patchedFileSha256,
    interpreterPath: record.interpreterPath,
  };
}

function buildStatus(
  record: ManagedRuntimeStateRecord | null,
  runtime: ResolvedManagedRuntime,
  observedAt: string,
): ManagedRuntimeStatus {
  if (record === null) {
    return {
      state: "absent",
      endpoint: runtime.endpoint,
      port: runtime.port,
      pid: null,
      generation: 0,
      ownership: "none",
      verification: null,
      lastReadiness: null,
      lastStop: null,
      lastCrash: null,
      lastRefusal: null,
      observedAt,
      stateFile: runtime.stateFile,
    };
  }

  return {
    state: deriveState(record, runtime, "safe").state,
    endpoint: runtime.endpoint,
    port: runtime.port,
    pid: record.childPid,
    generation: record.generation,
    ownership: record.childPid === null ? "none" : "ultrasearch_managed",
    verification: verificationOf(record),
    lastReadiness: record.lastReadiness,
    lastStop: record.lastStop,
    lastCrash: record.lastCrash,
    lastRefusal: record.lastRefusal,
    observedAt,
    stateFile: runtime.stateFile,
  };
}

function operationResult(
  outcome: ManagedRuntimeOperationOutcome,
  status: ManagedRuntimeStatus,
  note?: string,
): ManagedRuntimeOperationResult {
  return note === undefined ? { outcome, status } : { outcome, note, status };
}

function persistFailure(
  runtime: ResolvedManagedRuntime,
  record: ManagedRuntimeStateRecord,
  error: ManagedRuntimeRefusalError,
): void {
  writeStateRecord(runtime, {
    ...record,
    state: "failed",
    lastRefusal: {
      code: error.code,
      at: runtime.clock().toISOString(),
      detail: error.detail,
    },
    updatedAt: runtime.clock().toISOString(),
  });
}

/**
 * Persists the refusal of a mutating operation as `failed` + `lastRefusal`
 * (the approved transition table). It is only called while this run holds the
 * root lock, so it respects the single-writer semantics. Nothing is written
 * when no state record is readable: a refusal never creates state artifacts,
 * and a corrupt record is left intact as forensic evidence.
 */
function persistRefusalUnderLock(
  runtime: ResolvedManagedRuntime,
  error: ManagedRuntimeRefusalError,
  lockEvents: readonly { at: string; pid: number; reason: string }[],
): void {
  let record: ManagedRuntimeStateRecord | null;
  try {
    record = readStateRecord(runtime);
  } catch {
    return;
  }
  if (record === null) return;
  const at = runtime.clock().toISOString();
  try {
    persistFailure(
      runtime,
      recordWithLockEvents(record, lockEvents, at),
      error,
    );
  } catch {
    // The typed refusal is still raised; persistence is defense in depth.
  }
}

/**
 * Root-locked mutating section. A typed refusal raised inside the section
 * persists `failed` + `lastRefusal` before it is re-raised; refusals raised
 * before the lock is acquired (isolation, unsupported platform, a live lock)
 * write nothing.
 */
async function withLockedMutation<T>(
  runtime: ResolvedManagedRuntime,
  allowDeadLockClear: boolean,
  run: (
    lockEvents: readonly { at: string; pid: number; reason: string }[],
  ) => Promise<T>,
): Promise<T> {
  return withRootLock(runtime, allowDeadLockClear, async (lockEvents) => {
    try {
      return await run(lockEvents);
    } catch (error) {
      if (error instanceof ManagedRuntimeRefusalError) {
        persistRefusalUnderLock(runtime, error, lockEvents);
      }
      throw error;
    }
  });
}

/*
 * Resolved-interpreter handling (`DQ-034` R1b). The recorded interpreter is the
 * resolved base CPython binary with its SHA-256; the venv's redirector launcher
 * (`<venvRoot>\Scripts\python.exe`) is neither recorded nor spawned. Nothing
 * inside the venv root is ever written, replaced, or deleted by the module, and
 * the managed child is spawned with `-B` plus a child environment binding
 * `PYTHONDONTWRITEBYTECODE=1`, so even its first import writes no `__pycache__`
 * bytecode into the venv (`DQ-036` R1).
 */

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Refuses any interpreter candidate that lives inside the venv root: the only
 * interpreter image there is the venv's own redirector launcher, which spawns
 * the resolved CPython as a child and therefore cannot satisfy the B-2
 * single-process invariant.
 */
function assertNotVenvLauncher(
  runtime: ResolvedManagedRuntime,
  candidate: string,
): void {
  if (containsPath(runtime.venvRoot, candidate)) {
    throw refuse(
      "interpreter_redirector_detected",
      `the resolved interpreter ${candidate} is inside the venv root (${runtime.venvRoot}); record the resolved base CPython binary instead of the venv redirector launcher at ${runtime.venvLauncherPath}`,
    );
  }
}

function hashInterpreter(path: string): string {
  return digestOfFile(
    path,
    "interpreter_missing",
    `no resolved managed runtime interpreter at ${path}; stage the interpreter tree before provisioning`,
  );
}

function parsePyvenvCfg(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) entries.set(key, value);
  }
  return entries;
}

function pyvenvCandidate(
  runtime: ResolvedManagedRuntime,
  value: string,
): string {
  return isAbsolute(value) ? resolve(value) : resolve(runtime.venvRoot, value);
}

/**
 * Deterministic resolution of the staged base interpreter without invoking any
 * uv automation (`DQ-033` Q5): an explicit caller-provided `interpreterPath`
 * override wins; otherwise the venv's `pyvenv.cfg` is read (`executable`, then
 * `home`) under the venv root. Missing, unreadable, or ambiguous input refuses
 * with `interpreter_missing`; a candidate inside the venv root refuses with
 * `interpreter_redirector_detected`. The resolved file is hashed, never
 * guessed.
 */
function resolveStagedInterpreter(
  runtime: ResolvedManagedRuntime,
): ResolvedInterpreter {
  const override = runtime.paths.interpreterPath;
  if (override !== null) {
    if (!isFile(override)) {
      throw refuse(
        "interpreter_missing",
        `the caller-provided interpreter override ${override} is not an existing file; stage the resolved base CPython binary`,
      );
    }
    assertNotVenvLauncher(runtime, override);
    return {
      interpreterPath: override,
      interpreterSha256: hashInterpreter(override),
    };
  }

  const configPath = join(runtime.venvRoot, "pyvenv.cfg");
  if (!existsSync(configPath)) {
    throw refuse(
      "interpreter_missing",
      `no venv configuration at ${configPath} to resolve the base interpreter, and no caller-provided interpreterPath override; stage the interpreter tree or pass the resolved binary`,
    );
  }
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    throw refuse(
      "interpreter_missing",
      `cannot read the venv configuration ${configPath}: ${errorMessage(error)}`,
    );
  }
  const entries = parsePyvenvCfg(text);
  const executable = entries.get("executable");
  const home = entries.get("home");
  const candidates: Array<{ key: string; path: string }> = [];
  if (executable !== undefined) {
    candidates.push({
      key: "executable",
      path: pyvenvCandidate(runtime, executable),
    });
  }
  if (home !== undefined) {
    candidates.push({
      key: "home",
      path: join(pyvenvCandidate(runtime, home), "python.exe"),
    });
  }
  const distinct = new Map<string, { key: string; path: string }>();
  for (const candidate of candidates) {
    if (isFile(candidate.path)) {
      distinct.set(comparablePath(candidate.path), candidate);
    }
  }
  if (distinct.size === 0) {
    throw refuse(
      "interpreter_missing",
      `the venv configuration ${configPath} does not resolve an existing base interpreter (executable=${executable ?? "absent"}, home=${home ?? "absent"})`,
    );
  }
  const candidatesInOrder = [...distinct.values()];
  if (candidatesInOrder.length > 1) {
    const described = candidatesInOrder
      .map((candidate) => `${candidate.key}=${candidate.path}`)
      .join(", ");
    throw refuse(
      "interpreter_missing",
      `the venv configuration ${configPath} is ambiguous: ${described}; pass the resolved interpreterPath explicitly instead of guessing`,
    );
  }
  const resolved = candidatesInOrder[0];
  if (resolved === undefined) {
    throw refuse(
      "interpreter_missing",
      `the venv configuration ${configPath} does not resolve an existing base interpreter`,
    );
  }
  assertNotVenvLauncher(runtime, resolved.path);
  return {
    interpreterPath: resolved.path,
    interpreterSha256: hashInterpreter(resolved.path),
  };
}

/**
 * Re-verifies the resolved interpreter recorded in a state record: the file
 * must still exist outside the venv root and its SHA-256 must still equal the
 * recorded digest. Returns `null` when the record carries no
 * resolved-interpreter digest (a record from before this repair): provision and
 * repair then resolve and record the identity, while `start` refuses with
 * `interpreter_missing` instead of trusting an unverifiable record.
 */
function verifyRecordedInterpreter(
  record: ManagedRuntimeStateRecord,
  runtime: ResolvedManagedRuntime,
): ResolvedInterpreter | null {
  if (record.interpreterPath === null || record.interpreterSha256 === null) {
    return null;
  }
  assertNotVenvLauncher(runtime, record.interpreterPath);
  if (!isFile(record.interpreterPath)) {
    throw refuse(
      "interpreter_missing",
      `no recorded resolved interpreter at ${record.interpreterPath}; stage the interpreter tree and run \`runtime repair\``,
    );
  }
  const digest = hashInterpreter(record.interpreterPath);
  if (digest !== record.interpreterSha256) {
    throw refuse(
      "interpreter_redirector_detected",
      `the recorded interpreter ${record.interpreterPath} reports SHA-256 ${digest}; the record recorded ${record.interpreterSha256}. A venv redirector launcher, a forking wrapper, or a substituted binary is refused`,
    );
  }
  return {
    interpreterPath: record.interpreterPath,
    interpreterSha256: digest,
  };
}

function requireRecordedInterpreter(
  record: ManagedRuntimeStateRecord,
  runtime: ResolvedManagedRuntime,
): ResolvedInterpreter {
  const verified = verifyRecordedInterpreter(record, runtime);
  if (verified === null) {
    throw refuse(
      "interpreter_missing",
      `the managed runtime record does not carry a resolved-interpreter digest for ${record.interpreterPath ?? "an interpreter"}; run \`runtime repair\` to resolve and record the base CPython interpreter`,
    );
  }
  return verified;
}

/*
 * Provisioning.
 */

async function provisionInternal(
  options: ManagedRuntimeOptions,
  mode: "provision" | "repair",
): Promise<ManagedRuntimeOperationResult> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  assertSupportedPlatform(runtime);

  return withLockedMutation(runtime, mode === "repair", async (lockEvents) => {
    const at = runtime.clock().toISOString();
    const record = readStateRecord(runtime);

    if (record !== null && !existsSync(runtime.markerFile)) {
      throw refuse(
        "root_marker_missing",
        `the managed root at ${runtime.paths.managedRoot} has a state record but no managed marker file`,
      );
    }
    if (record === null) {
      mkdirSync(runtime.paths.managedRoot, { recursive: true });
    }

    const fileDigest = digestOfFile(
      runtime.valkeydbPath,
      "checkout_missing",
      `no managed checkout file at ${runtime.valkeydbPath}`,
    );

    if (fileDigest === runtime.identity.patchedValkeydbSha256) {
      if (!hasVerificationRecord(record)) {
        throw refuse(
          "patch_state_unknown",
          `the managed checkout is patched (${fileDigest}) but no valid verification record exists; re-stage the pristine checkout`,
        );
      }
      if (record.patchedFileSha256 !== runtime.identity.patchedValkeydbSha256) {
        throw refuse(
          "patch_state_unknown",
          `the verification record expects patched digest ${record.patchedFileSha256} but the checkout reports ${fileDigest}`,
        );
      }
      // A record with a resolved-interpreter digest is re-verified as
      // recorded; a pre-`DQ-034` record (no digest, possibly naming the venv
      // redirector launcher) is resolved and upgraded here.
      const verifiedInterpreter = verifyRecordedInterpreter(record, runtime);
      const interpreter =
        verifiedInterpreter ?? resolveStagedInterpreter(runtime);
      const interpreterChanged =
        record.interpreterPath !== interpreter.interpreterPath ||
        record.interpreterSha256 !== interpreter.interpreterSha256;
      if (record.state !== "provisioned" && record.state !== "running") {
        const normalized = recordWithLockEvents(
          {
            ...record,
            state: "provisioned",
            interpreterPath: interpreter.interpreterPath,
            interpreterSha256: interpreter.interpreterSha256,
          },
          lockEvents,
          at,
        );
        writeStateRecord(runtime, normalized);
        return operationResult(
          "already_provisioned",
          buildStatus(normalized, runtime, at),
          "re-verified an existing managed runtime record",
        );
      }
      if (lockEvents.length > 0 || interpreterChanged) {
        const noted = recordWithLockEvents(
          {
            ...record,
            interpreterPath: interpreter.interpreterPath,
            interpreterSha256: interpreter.interpreterSha256,
          },
          lockEvents,
          at,
        );
        writeStateRecord(runtime, noted);
        return operationResult(
          "already_provisioned",
          buildStatus(noted, runtime, at),
          lockEvents.length > 0
            ? "recorded a cleared stale managed runtime lock"
            : "resolved and recorded the interpreter identity",
        );
      }
      return operationResult(
        "already_provisioned",
        buildStatus(record, runtime, at),
      );
    }

    if (fileDigest !== runtime.identity.pristineValkeydbSha256) {
      throw refuse(
        "patch_state_unknown",
        `the managed checkout file ${runtime.valkeydbPath} reports ${fileDigest}; it matches neither the recorded pristine digest nor the recorded patched digest`,
      );
    }

    if (!existsSync(runtime.paths.archivePath)) {
      throw refuse(
        "archive_missing",
        `no pinned source archive at ${runtime.paths.archivePath}`,
      );
    }
    if (!existsSync(runtime.paths.patchPath)) {
      throw refuse(
        "patch_missing",
        `no Windows accommodation patch at ${runtime.paths.patchPath}`,
      );
    }

    // Resolve and hash the staged base interpreter before any checkout
    // mutation: an unresolvable or launcher-named interpreter refuses without
    // side effects, and the record gets the resolved path and digest, never
    // the venv redirector launcher.
    const interpreter = resolveStagedInterpreter(runtime);

    let applied: ReturnType<typeof applySearxngWindowsPatch>;
    try {
      applied = runtime.applyWindowsPatch({
        checkoutPath: runtime.paths.checkoutPath,
        patchPath: runtime.paths.patchPath,
        archivePath: runtime.paths.archivePath,
      });
    } catch (error) {
      if (error instanceof ProvisioningRefusalError) {
        throw refuse("provisioning_refused", error.message);
      }
      throw error;
    }

    const patchedDigest = digestOfFile(
      runtime.valkeydbPath,
      "checkout_missing",
      `no managed checkout file at ${runtime.valkeydbPath}`,
    );
    if (patchedDigest !== runtime.identity.patchedValkeydbSha256) {
      throw refuse(
        "patch_state_unknown",
        `after applying the pinned patch the managed checkout reports ${patchedDigest}; expected the recorded patched digest`,
      );
    }

    writeFileSync(
      runtime.markerFile,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "ultrasearch-managed-runtime",
        pinCommit: applied.pinCommit,
        createdAt: at,
      })}\n`,
      "utf8",
    );

    const next: ManagedRuntimeStateRecord = {
      schemaVersion: 1,
      state: "provisioned",
      generation: record?.generation ?? 0,
      pinCommit: applied.pinCommit,
      treeId: applied.treeId,
      archiveSha256: applied.archiveSha256,
      patchSha256: applied.patchSha256,
      patchedFileSha256: patchedDigest,
      interpreterPath: interpreter.interpreterPath,
      interpreterSha256: interpreter.interpreterSha256,
      checkoutPath: runtime.paths.checkoutPath,
      port: runtime.port,
      endpoint: runtime.endpoint,
      childPid: null,
      childStartedAt: null,
      childExecutable: null,
      environmentKeys: [],
      lastReadiness: record?.lastReadiness ?? null,
      lastStop: record?.lastStop ?? null,
      lastCrash: record?.lastCrash ?? null,
      lastRefusal: record?.lastRefusal ?? null,
      lockEvents: [...(record?.lockEvents ?? []), ...lockEvents].slice(-20),
      updatedAt: at,
    };
    writeStateRecord(runtime, next);
    return operationResult("provisioned", buildStatus(next, runtime, at));
  });
}

export async function provisionManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeOperationResult> {
  return provisionInternal(options, "provision");
}

export async function repairManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeOperationResult> {
  return provisionInternal(options, "repair");
}

/*
 * Start, stop, restart.
 */

export async function startManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeOperationResult> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  assertSupportedPlatform(runtime);

  return withLockedMutation(runtime, false, async (lockEvents) => {
    const record = readStateRecord(runtime);
    if (record === null) {
      throw refuse(
        "checkout_missing",
        `no managed runtime state record at ${runtime.stateFile}; run \`runtime provision\` first`,
      );
    }
    if (record.state === "failed") {
      throw refuse(
        "already_failed",
        "the last managed runtime operation failed; run `runtime repair` or `runtime cleanup` first",
      );
    }

    const at = runtime.clock().toISOString();
    const derived = deriveState(record, runtime, "strict");
    if (derived.state === "running") {
      return operationResult(
        "already_running",
        buildStatus(record, runtime, at),
      );
    }
    if (derived.state === "unverified") {
      throw refuse(
        "patch_state_unknown",
        "the managed runtime is unverified; run `runtime provision` or `runtime repair` first",
      );
    }

    const fileDigest = digestOfFile(
      runtime.valkeydbPath,
      "checkout_missing",
      `no managed checkout file at ${runtime.valkeydbPath}`,
    );
    if (
      fileDigest !== runtime.identity.patchedValkeydbSha256 ||
      record.patchedFileSha256 !== runtime.identity.patchedValkeydbSha256
    ) {
      throw refuse(
        "patch_state_unknown",
        `the managed checkout reports ${fileDigest} and the record expects ${record.patchedFileSha256 ?? "none"}; expected the recorded patched digest`,
      );
    }

    // Pre-spawn identity: the recorded interpreter file must exist outside the
    // venv root and its SHA-256 must equal the recorded resolved-interpreter
    // digest. A venv redirector launcher - or any substituted binary - refuses
    // with `interpreter_redirector_detected`, never `running` (`DQ-034` R1b).
    const interpreter = requireRecordedInterpreter(record, runtime);

    const listeners = runtime.processLayer.listenersOnPort(runtime.port);
    if (listeners.length > 0) {
      throw refuse(
        "port_in_use_foreign",
        `a listener already owns ${MANAGED_RUNTIME_HOST}:${runtime.port} (pid ${listeners[0]?.pid ?? "unknown"}); the managed runtime does not adopt or terminate a foreign process`,
      );
    }

    mkdirSync(runtime.tmpPath, { recursive: true });
    mkdirSync(runtime.logsPath, { recursive: true });
    const environment = childEnvironment(
      runtime,
      randomBytes(32).toString("hex"),
    );
    const request: ManagedRuntimeSpawnRequest = {
      executablePath: interpreter.interpreterPath,
      // `-B` (belt to the PYTHONDONTWRITEBYTECODE=1 braces): the child must
      // not write bytecode into `.venv`, including `__pycache__/*.pyc` on
      // first import (`DQ-036` R1).
      args: ["-B", "-m", "searx.webapp"],
      cwd: record.checkoutPath ?? runtime.paths.checkoutPath,
      environment,
      stdoutPath: join(runtime.logsPath, "stdout.log"),
      stderrPath: join(runtime.logsPath, "stderr.log"),
    };

    const recordAtStart = recordWithLockEvents(record, lockEvents, at);
    let pid: number;
    try {
      pid = runtime.processLayer.spawn(request);
    } catch (error) {
      const refusal = refuse("spawn_failed", errorMessage(error));
      persistFailure(runtime, recordAtStart, refusal);
      throw refusal;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      const refusal = refuse(
        "spawn_failed",
        `the managed runtime spawn returned ${String(pid)}`,
      );
      persistFailure(runtime, recordAtStart, refusal);
      throw refusal;
    }

    // The spawned pid is persisted before any inspection: a failing inspector
    // can then never orphan an unrecorded child. `start` is the only writer of
    // the `starting` transient; `childStartedAt` and `childExecutable` are
    // completed from the inspector facts a moment later.
    let starting: ManagedRuntimeStateRecord = recordWithLockEvents(
      {
        ...record,
        state: "starting",
        port: runtime.port,
        endpoint: runtime.endpoint,
        childPid: pid,
        childStartedAt: null,
        childExecutable: request.executablePath,
        environmentKeys: Object.keys(environment),
      },
      lockEvents,
      at,
    );
    writeStateRecord(runtime, starting);

    let facts: ManagedRuntimeProcessFacts | null;
    try {
      facts = runtime.processLayer.inspect(pid);
    } catch (error) {
      const refusal = refuse(
        "spawn_failed",
        `the spawned managed runtime child ${pid} could not be inspected: ${errorMessage(error)}`,
      );
      const stop = await stopSpawnedChildWithEscalation(runtime, starting);
      persistFailure(runtime, stopRecordedRecord(starting, stop, at), refusal);
      throw refusal;
    }
    if (facts === null) {
      const refusal = refuse(
        "spawn_failed",
        `the spawned managed runtime child ${pid} could not be inspected`,
      );
      persistFailure(runtime, starting, refusal);
      throw refusal;
    }
    // Post-spawn identity (`DQ-034` R1b): the spawned process image must be the
    // recorded resolved interpreter before readiness is awaited, so a forking
    // wrapper or a redirector image yields a named refusal instead of `running`.
    if (
      facts.executablePath === null ||
      comparablePath(facts.executablePath) !==
        comparablePath(interpreter.interpreterPath)
    ) {
      const refusal = refuse(
        "interpreter_redirector_detected",
        `the spawned managed runtime child ${pid} reports executable ${facts.executablePath ?? "unknown"}; expected the recorded resolved interpreter ${interpreter.interpreterPath}`,
      );
      const stop = await stopSpawnedChildWithEscalation(runtime, starting);
      persistFailure(runtime, stopRecordedRecord(starting, stop, at), refusal);
      throw refusal;
    }
    starting = {
      ...starting,
      childStartedAt: facts.startedAt,
      childExecutable: facts.executablePath,
    };
    writeStateRecord(runtime, starting);

    let readiness: { status: number; at: string; elapsedMs: number };
    try {
      readiness = await awaitReadiness(runtime);
    } catch (error) {
      if (!(error instanceof ManagedRuntimeRefusalError)) throw error;
      const stop = await stopRecordedChildQuietly(runtime, starting);
      persistFailure(runtime, stopRecordedRecord(starting, stop, at), error);
      throw error;
    }

    const childFacts = runtime.processLayer.inspect(pid);
    const listenerFacts = runtime.processLayer.listenersOnPort(runtime.port);
    const invariantHolds =
      matchesRecordedIdentity(starting, childFacts) &&
      listenerFacts.length === 1 &&
      listenerFacts[0]?.pid === pid &&
      listenerAddressIsLoopback(listenerFacts[0]?.address);
    if (!invariantHolds) {
      const error = refuse(
        "listener_invariant_violated",
        `expected exactly one listener on ${MANAGED_RUNTIME_HOST}:${runtime.port} bound to ${MANAGED_RUNTIME_HOST} and owned by pid ${pid}; observed ${listenerFacts.length} listener(s)${observedListeners(listenerFacts)}`,
      );
      const stop = await stopRecordedChildQuietly(runtime, starting);
      persistFailure(runtime, stopRecordedRecord(starting, stop, at), error);
      throw error;
    }

    const running = recordWithLockEvents(
      {
        ...starting,
        state: "running",
        generation: record.generation + 1,
        lastReadiness: readiness,
        lastRefusal: record.lastRefusal,
      },
      [],
      at,
    );
    writeStateRecord(runtime, running);
    return operationResult("started", buildStatus(running, runtime, at));
  });
}

function stopRecordedRecord(
  record: ManagedRuntimeStateRecord,
  stop: {
    attempted: boolean;
    terminated: boolean;
    method: "terminate" | "force" | null;
  },
  at: string,
): ManagedRuntimeStateRecord {
  if (!stop.terminated) return record;
  return {
    ...record,
    childPid: null,
    childStartedAt: null,
    childExecutable: null,
    lastStop: { at, method: stop.method ?? "terminate" },
    updatedAt: at,
  };
}

export async function stopManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeOperationResult> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  assertSupportedPlatform(runtime);

  return withLockedMutation(runtime, false, async (lockEvents) => {
    const record = readStateRecord(runtime);
    const at = runtime.clock().toISOString();
    if (record === null) {
      return operationResult(
        "already_stopped",
        buildStatus(null, runtime, at),
        "no managed runtime state record",
      );
    }

    const derived = deriveState(record, runtime, "strict");
    if (derived.state === "provisioned") {
      return operationResult(
        "already_stopped",
        buildStatus(record, runtime, at),
        "the managed runtime is not running",
      );
    }

    if (record.childPid === null) {
      const normalized = recordWithLockEvents(
        { ...record, state: "provisioned" },
        lockEvents,
        at,
      );
      writeStateRecord(runtime, normalized);
      return operationResult(
        "already_stopped",
        buildStatus(normalized, runtime, at),
        "no recorded child process",
      );
    }

    const listeners = runtime.processLayer.listenersOnPort(runtime.port);
    const foreign = listeners.filter(
      (listener) => listener.pid !== record.childPid,
    );
    if (foreign.length > 0) {
      throw refuse(
        "port_in_use_foreign",
        `a listener on ${MANAGED_RUNTIME_HOST}:${runtime.port} is not owned by the recorded child ${record.childPid}; no process was terminated`,
      );
    }

    if (derived.state === "stale") {
      if (listeners.length > 0) {
        throw refuse(
          "pid_identity_mismatch",
          `a listener on ${MANAGED_RUNTIME_HOST}:${runtime.port} is attributed to pid ${record.childPid}, but the recorded process identity does not match; no process was terminated`,
        );
      }
      const normalized = recordWithLockEvents(
        normalizeStoppedRecord(record, runtime, at),
        lockEvents,
        at,
      );
      writeStateRecord(runtime, normalized);
      return operationResult(
        "already_stopped",
        buildStatus(normalized, runtime, at),
        "ownership could not be verified; no process was terminated",
      );
    }

    const facts = runtime.processLayer.inspect(record.childPid);
    if (facts === null) {
      if (listeners.length > 0) {
        throw refuse(
          "stop_unverified",
          `the recorded child ${record.childPid} is not running but listeners remain on ${MANAGED_RUNTIME_HOST}:${runtime.port}`,
        );
      }
      const normalized = recordWithLockEvents(
        normalizeStoppedRecord(record, runtime, at),
        lockEvents,
        at,
      );
      writeStateRecord(runtime, normalized);
      return operationResult(
        "already_stopped",
        buildStatus(normalized, runtime, at),
        "the recorded child was already gone",
      );
    }

    if (!matchesRecordedIdentity(record, facts)) {
      throw refuse(
        "pid_identity_mismatch",
        `pid ${record.childPid} no longer matches the recorded executable and start time; no process was terminated`,
      );
    }

    const exit = await terminateVerifiedChild(runtime, record.childPid);
    if (!exit.terminated) {
      const error = refuse(
        "stop_timeout",
        `the recorded child ${record.childPid} did not exit within ${MANAGED_RUNTIME_STOP_TIMEOUT_MS} ms, including a force escalation`,
      );
      persistFailure(
        runtime,
        recordWithLockEvents(record, lockEvents, at),
        error,
      );
      throw error;
    }

    const listenersAfter = runtime.processLayer.listenersOnPort(runtime.port);
    // The survivor scan is root-scoped (`DQ-035` R1): only processes tied to
    // the recorded child (pid or descendant) or referencing the managed root
    // on their command line count. A same-image foreign process does not, and
    // an unresolvable scan input counts as survivors present.
    const survivors = runtime.processLayer.rootScopedSurvivors({
      managedRoot: runtime.paths.managedRoot,
      recordedChildPid: record.childPid,
    });
    if (listenersAfter.length > 0 || survivors.survivorsPresent) {
      const error = refuse(
        "stop_unverified",
        `the recorded child ${record.childPid} exited but ${listenersAfter.length} listener(s) and ${survivors.survivorPids.length} root-owned survivor process(es) remain${survivors.unverifiableReason === null ? "" : `; the root-scoped survivor scan is inconclusive: ${survivors.unverifiableReason}`}`,
      );
      persistFailure(
        runtime,
        recordWithLockEvents(record, lockEvents, at),
        error,
      );
      throw error;
    }

    const stopped = recordWithLockEvents(
      {
        ...normalizeStoppedRecord(record, runtime, at),
        lastStop: { at, method: exit.method },
      },
      lockEvents,
      at,
    );
    writeStateRecord(runtime, stopped);
    return operationResult("stopped", buildStatus(stopped, runtime, at));
  });
}

function normalizeStoppedRecord(
  record: ManagedRuntimeStateRecord,
  runtime: ResolvedManagedRuntime,
  at: string,
): ManagedRuntimeStateRecord {
  return {
    ...record,
    state: "provisioned",
    port: runtime.port,
    endpoint: runtime.endpoint,
    childPid: null,
    childStartedAt: null,
    childExecutable: null,
    updatedAt: at,
  };
}

export async function restartManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeOperationResult> {
  const stopped = await stopManagedRuntime(options);
  const started = await startManagedRuntime(options);
  return operationResult(
    "restarted",
    started.status,
    stopped.outcome === "stopped"
      ? undefined
      : "the managed runtime was already stopped before restart",
  );
}

/*
 * Read-only and on-demand supervision.
 */

/**
 * On-demand supervision. It persists a detected `stale` transition, but a
 * refusal raised before that transition reads like a status read and persists
 * nothing; the root lock keeps the transition single-writer.
 */
export async function reconcileManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeStatus> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  assertSupportedPlatform(runtime);

  return withRootLock(runtime, false, async (lockEvents) => {
    const record = readStateRecord(runtime);
    const at = runtime.clock().toISOString();
    if (record === null) return buildStatus(null, runtime, at);

    const derived = deriveState(record, runtime, "strict");
    if (derived.detection === null) {
      return buildStatus(record, runtime, at);
    }
    const stale = recordWithLockEvents(
      {
        ...record,
        state: "stale",
        lastCrash: { at, detection: derived.detection },
      },
      lockEvents,
      at,
    );
    writeStateRecord(runtime, stale);
    return buildStatus(stale, runtime, at);
  });
}

/**
 * Read-only status. It never writes, never creates files, never repairs a
 * lock, and never mutates a runtime; `stale` is computed and not persisted.
 * Platform refusal is uniform with the mutating operations: process and
 * listener facts are Windows-first, so a non-Windows host refuses instead of
 * reporting an unverifiable projection. The additive doctor/status projection
 * maps that refusal (and every other unavailable projection) to `null`.
 */
export async function readManagedRuntimeStatus(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeStatus> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  assertSupportedPlatform(runtime);
  const record = readStateRecord(runtime);
  return buildStatus(record, runtime, runtime.clock().toISOString());
}

/*
 * Cleanup.
 */

/**
 * Clears read-only attributes so the recursive deletion can proceed, except
 * inside the venv root: `DQ-034` R1b forbids the lifecycle from writing,
 * replacing, or deleting anything inside `<root>\.venv` - including attribute
 * writes. The Node recursive deletion resets a read-only attribute itself when
 * the deletion needs it, so skipping the venv subtree does not weaken the
 * cleanup proof; a deletion that still fails is reported as
 * `cleanup_incomplete`.
 */
function clearReadOnlyAttributes(path: string, venvRoot: string): void {
  if (comparablePath(path) === comparablePath(venvRoot)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (comparablePath(child) === comparablePath(venvRoot)) continue;
    if (entry.isDirectory()) {
      clearReadOnlyAttributes(child, venvRoot);
    }
    try {
      chmodSync(child, entry.isDirectory() ? 0o777 : 0o666);
    } catch {
      // A locked or missing entry is reported by the deletion proof instead.
    }
  }
  try {
    chmodSync(path, 0o777);
  } catch {
    // A locked or missing directory is reported by the deletion proof.
  }
}

export async function cleanupManagedRuntime(
  options: ManagedRuntimeOptions,
): Promise<ManagedRuntimeCleanupResult> {
  const runtime = resolveManagedRuntime(options);
  assertManagedRootAllowed(runtime.paths.managedRoot);
  const verifiedAt = runtime.clock().toISOString();

  if (!existsSync(runtime.paths.managedRoot)) {
    return {
      outcome: "already_absent",
      managedRoot: runtime.paths.managedRoot,
      lastState: "absent",
      pathAbsent: true,
      port: runtime.port,
      listenersAfter: 0,
      survivorPids: [],
      clearedLockPids: [],
      verifiedAt,
    };
  }
  assertSupportedPlatform(runtime);
  // The isolation guard has already run, and the marker is verified here,
  // before the root lock or any state artifact is created: a refused cleanup
  // must leave an unmanaged directory byte-identical.
  if (!existsSync(runtime.markerFile)) {
    throw refuse(
      "root_marker_missing",
      `the directory at ${runtime.paths.managedRoot} is not a managed runtime root: no marker file`,
    );
  }

  return withLockedMutation(runtime, true, async (lockEvents) => {
    const record = readStateRecord(runtime);
    const at = runtime.clock().toISOString();
    if (record !== null && !existsSync(runtime.markerFile)) {
      throw refuse(
        "root_marker_missing",
        `the managed root at ${runtime.paths.managedRoot} has a state record but no managed marker file`,
      );
    }

    const listeners = runtime.processLayer.listenersOnPort(runtime.port);
    if (listeners.length > 0) {
      throw refuse(
        "cleanup_refused",
        `listeners still own ${MANAGED_RUNTIME_HOST}:${runtime.port}; stop the managed runtime before cleanup`,
      );
    }
    if (record !== null && record.childPid !== null) {
      const facts = runtime.processLayer.inspect(record.childPid);
      if (facts !== null) {
        throw refuse(
          "cleanup_refused",
          `the recorded managed runtime child ${record.childPid} is still running; stop it before cleanup`,
        );
      }
    }

    clearReadOnlyAttributes(runtime.paths.managedRoot, runtime.venvRoot);
    try {
      rmSync(runtime.paths.managedRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      // The deletion proof below reports the failure as `cleanup_incomplete`.
    }

    const pathAbsent = !existsSync(runtime.paths.managedRoot);
    const listenersAfter = runtime.processLayer.listenersOnPort(runtime.port);
    // The survivor scan is root-scoped (`DQ-035` R1). When a state record
    // names a child, the scan also follows that recorded pid and its
    // descendants; with no state record it falls back to the equivalent
    // root-reference rule keyed on the target managed root path, with the same
    // fail-closed behavior when the path, a command line, or a parent chain is
    // unresolvable.
    const survivors = runtime.processLayer.rootScopedSurvivors({
      managedRoot: runtime.paths.managedRoot,
      recordedChildPid: record?.childPid ?? null,
    });
    if (
      !pathAbsent ||
      listenersAfter.length > 0 ||
      survivors.survivorsPresent
    ) {
      throw refuse(
        "cleanup_incomplete",
        `the managed root deletion is not proven: pathAbsent=${String(pathAbsent)}, ${listenersAfter.length} listener(s), ${survivors.survivorPids.length} survivor process(es)${survivors.unverifiableReason === null ? "" : `; the root-scoped survivor scan is inconclusive: ${survivors.unverifiableReason}`}`,
      );
    }

    return {
      outcome: "deleted",
      managedRoot: runtime.paths.managedRoot,
      lastState: record?.state ?? "absent",
      pathAbsent,
      port: runtime.port,
      listenersAfter: listenersAfter.length,
      survivorPids: survivors.survivorPids,
      clearedLockPids: lockEvents.map((event) => event.pid),
      verifiedAt: at,
    };
  });
}

/*
 * Default Windows-first process layer and readiness probe. They are the only
 * OS-touching code in this module and are never used by the public test suite.
 */

function quotePowerShellLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

function runPowerShell(script: string, detail: string): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) {
    throw new Error(`${detail}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${detail}: powershell exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function defaultSpawn(request: ManagedRuntimeSpawnRequest): number {
  const stdout = openSync(request.stdoutPath, "a");
  const stderr = openSync(request.stderrPath, "a");
  try {
    const child = spawn(request.executablePath, [...request.args], {
      cwd: request.cwd,
      env: request.environment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdout, stderr],
    });
    if (child.pid === undefined) {
      throw new Error("the managed runtime child was spawned without a pid");
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function defaultInspect(pid: number): ManagedRuntimeProcessFacts | null {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter ${quotePowerShellLiteral(`ProcessId = ${pid}`)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { 'null' } else {",
    "  @{ pid = [int]$p.ProcessId; executablePath = [string]$p.ExecutablePath; startedAt = [string]$p.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress",
    "}",
  ].join("\n");
  const output = runPowerShell(script, `inspect pid ${pid}`);
  if (output.length === 0 || output === "null") return null;
  const parsed = JSON.parse(output) as {
    pid?: unknown;
    executablePath?: unknown;
    startedAt?: unknown;
  };
  if (typeof parsed.pid !== "number") return null;
  return {
    pid: parsed.pid,
    executablePath:
      typeof parsed.executablePath === "string" &&
      parsed.executablePath.length > 0
        ? parsed.executablePath
        : null,
    startedAt:
      typeof parsed.startedAt === "string" && parsed.startedAt.length > 0
        ? parsed.startedAt
        : null,
  };
}

function defaultListenersOnPort(port: number): ManagedRuntimeListener[] {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    "if ($null -eq $c) { '[]' } else {",
    "  $items = @(@($c) | ForEach-Object { @{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })",
    "  ConvertTo-Json -InputObject $items -Compress",
    "}",
  ].join("\n");
  const output = runPowerShell(script, `listeners on port ${port}`);
  if (output.length === 0) return [];
  const parsed: unknown = JSON.parse(output);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (!isObject(item)) return [];
    const { address, port: localPort, pid } = item;
    if (
      typeof address !== "string" ||
      typeof localPort !== "number" ||
      typeof pid !== "number"
    ) {
      return [];
    }
    return [{ address, port: localPort, pid }];
  });
}

function defaultTerminate(pid: number, mode: "terminate" | "force"): void {
  const force = mode === "force" ? " -Force" : "";
  runPowerShell(
    `Stop-Process -Id ${pid}${force} -ErrorAction SilentlyContinue`,
    `${mode} pid ${pid}`,
  );
}

/*
 * Root-scoped survivor predicate (`DQ-035` R1). It is pure and exported so
 * the typed suite can exercise it directly with modeled process rows.
 */

/**
 * Path-component characters for the command-line boundary check: a root match
 * must not continue a longer path component, so `...\stage-c4-abc\` and
 * `...\stage-c4-abc\...` match while `...\stage-c4-abcdef\` does not. Other
 * characters (quotes, whitespace, separators, end of string) end the
 * component and satisfy the boundary.
 */
function isPathNameCharacter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z") ||
    (character >= "0" && character <= "9") ||
    character === "." ||
    character === "_" ||
    character === "-"
  );
}

/** Case-insensitive, separator-normalized text for root-reference matching. */
function normalizePathTextForMatch(value: string): string {
  return value.split("\\").join("/").toLowerCase();
}

/**
 * Normalizes the managed root for command-line matching, or `null` when the
 * path is missing, relative, or otherwise un-normalizable. `null` is always
 * fail-closed: the caller reports survivors present, never zero.
 */
function normalizeManagedRootForMatch(managedRoot: string): string | null {
  if (typeof managedRoot !== "string") return null;
  const trimmed = managedRoot.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return null;
  if (!isAbsolute(trimmed)) return null;
  let normalized: string;
  try {
    normalized = normalizePathTextForMatch(resolve(trimmed));
  } catch {
    return null;
  }
  const volumeRoot =
    normalized.length === 3 && normalized[1] === ":" && normalized[2] === "/";
  while (!volumeRoot && normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.length === 0 ? null : normalized;
}

/**
 * True when `commandLine` contains `normalizedRoot` on a path-component
 * boundary, case-insensitively and with separators normalized. A drive/UNC
 * root is a true prefix of every path on its volume.
 */
function commandLineReferencesRoot(
  commandLine: string,
  normalizedRoot: string,
): boolean {
  const haystack = normalizePathTextForMatch(commandLine);
  const rootIsVolumeRoot = normalizedRoot.endsWith("/");
  let index = haystack.indexOf(normalizedRoot);
  while (index !== -1) {
    const afterIndex = index + normalizedRoot.length;
    const boundaryBefore =
      index === 0 || !isPathNameCharacter(haystack.charAt(index - 1));
    const boundaryAfter =
      rootIsVolumeRoot ||
      afterIndex >= haystack.length ||
      !isPathNameCharacter(haystack.charAt(afterIndex));
    if (boundaryBefore && boundaryAfter) return true;
    index = haystack.indexOf(normalizedRoot, index + 1);
  }
  return false;
}

/**
 * Deterministic static descendant test: the recorded child is an ancestor of
 * `pid` when the parent chain built from the enumerated rows reaches it. A
 * chain that leaves the enumerated set is conclusive within the static model
 * ("not an ancestor"); a pid cycle (possible under pid reuse) ends the walk
 * deterministically. Rows whose own parent pid cannot be resolved are handled
 * by `rootScopedSurvivors` as fail-closed survivors instead.
 */
function enumeratedAncestryReaches(
  pid: number,
  ancestorPid: number,
  parents: ReadonlyMap<number, number>,
): boolean {
  const seen = new Set<number>([pid]);
  let current = parents.get(pid);
  while (current !== undefined) {
    if (current === ancestorPid) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

/**
 * `DQ-035` R1 root-scoped survivor predicate. An enumerated process is a
 * survivor of the managed runtime when either
 * (a) its pid is the recorded child pid or a descendant of it (walked
 *     statically through the enumerated parent chain), or
 * (b) its command line contains the resolved managed root path on a
 *     path-component boundary (case-insensitive, separator-normalized).
 * `executablePath` is never matched, so image-path equality alone can never
 * produce a survivor. Fail-closed: an unresolvable managed root, recorded
 * child pid, command line, or candidate parent pid reports survivors present
 * (`unverifiableReason`), never zero.
 */
export function rootScopedSurvivors(
  candidates: readonly ManagedRuntimeProcessCandidate[],
  query: ManagedRuntimeSurvivorQuery,
): ManagedRuntimeSurvivorAssessment {
  const normalizedRoot = normalizeManagedRootForMatch(query.managedRoot);
  if (normalizedRoot === null) {
    return {
      survivorsPresent: true,
      survivorPids: [],
      unverifiableReason: `the managed root path is not resolvable or normalizable: ${String(query.managedRoot)}`,
    };
  }
  const recordedChildPid = query.recordedChildPid;
  if (
    recordedChildPid !== null &&
    (!Number.isSafeInteger(recordedChildPid) || recordedChildPid <= 0)
  ) {
    return {
      survivorsPresent: true,
      survivorPids: [],
      unverifiableReason: `the recorded child pid is not a resolvable process id: ${String(recordedChildPid)}`,
    };
  }

  const parents = new Map<number, number>();
  const survivorPids = new Set<number>();
  const problems: string[] = [];
  for (const candidate of candidates) {
    if (!Number.isSafeInteger(candidate.pid) || candidate.pid <= 0) {
      problems.push(
        `an enumerated process row has no resolvable pid: ${String(candidate.pid)}`,
      );
      continue;
    }
    const isRecordedChild =
      recordedChildPid !== null && candidate.pid === recordedChildPid;
    if (isRecordedChild) survivorPids.add(candidate.pid);
    if (
      candidate.parentPid !== null &&
      Number.isSafeInteger(candidate.parentPid) &&
      candidate.parentPid > 0
    ) {
      parents.set(candidate.pid, candidate.parentPid);
    } else if (recordedChildPid !== null && !isRecordedChild) {
      // The recorded child itself needs no parent chain: its own pid already
      // ties it to the root. Any other row whose parent pid cannot be
      // resolved cannot be ruled out as a descendant, so it is fail-closed
      // into a survivor.
      problems.push(
        `the parent pid of ${candidate.pid} is not resolvable: ${String(candidate.parentPid)}`,
      );
      survivorPids.add(candidate.pid);
    }
    if (candidate.commandLine === null) {
      problems.push(`the command line of ${candidate.pid} is not readable`);
      survivorPids.add(candidate.pid);
    } else if (
      commandLineReferencesRoot(candidate.commandLine, normalizedRoot)
    ) {
      survivorPids.add(candidate.pid);
    }
  }
  if (recordedChildPid !== null) {
    for (const pid of parents.keys()) {
      if (enumeratedAncestryReaches(pid, recordedChildPid, parents)) {
        survivorPids.add(pid);
      }
    }
  }
  const survivorList = [...survivorPids].sort((left, right) => left - right);
  return {
    survivorsPresent: survivorList.length > 0 || problems.length > 0,
    survivorPids: survivorList,
    unverifiableReason: problems.length === 0 ? null : problems.join("; "),
  };
}

/**
 * Enumerates python-image process rows for the survivor scan. The image-name
 * query is the enumeration only: the rows carry no survivor status by
 * themselves, and `defaultRootScopedSurvivors` root-scopes every row with
 * `rootScopedSurvivors` inside the same function, so no row becomes a
 * survivor without the root-scoped predicate deciding it.
 */
function enumeratePythonProcessCandidates(): ManagedRuntimeProcessCandidate[] {
  const script = [
    `$items = @(@(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue) | ForEach-Object { @{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; executablePath = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine } })`,
    "ConvertTo-Json -InputObject $items -Compress",
  ].join("\n");
  const output = runPowerShell(script, "python process enumeration");
  if (output.length === 0) return [];
  const parsed: unknown = JSON.parse(output);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (!isObject(item)) return [];
    const { pid, parentPid, executablePath, commandLine } = item;
    if (typeof pid !== "number" || !Number.isInteger(pid)) return [];
    return [
      {
        pid,
        parentPid:
          typeof parentPid === "number" && Number.isInteger(parentPid)
            ? parentPid
            : null,
        executablePath:
          typeof executablePath === "string" && executablePath.length > 0
            ? executablePath
            : null,
        commandLine:
          typeof commandLine === "string" && commandLine.length > 0
            ? commandLine
            : null,
      },
    ];
  });
}

/**
 * The production survivor scan: one enumeration of python-image rows and the
 * root-scoped predicate applied to every row in the same function. An
 * enumeration failure is fail-closed (unverifiable), never zero survivors.
 */
function defaultRootScopedSurvivors(
  query: ManagedRuntimeSurvivorQuery,
): ManagedRuntimeSurvivorAssessment {
  let candidates: ManagedRuntimeProcessCandidate[];
  try {
    candidates = enumeratePythonProcessCandidates();
  } catch (error) {
    return {
      survivorsPresent: true,
      survivorPids: [],
      unverifiableReason: `the process enumeration failed: ${errorMessage(error)}`,
    };
  }
  return rootScopedSurvivors(candidates, query);
}

const defaultProcessLayer: ManagedRuntimeProcessLayer = {
  get platform(): NodeJS.Platform {
    return process.platform;
  },
  spawn: defaultSpawn,
  inspect: defaultInspect,
  listenersOnPort: defaultListenersOnPort,
  terminate: defaultTerminate,
  rootScopedSurvivors: defaultRootScopedSurvivors,
};

async function defaultReadinessProbe(
  endpoint: string,
): Promise<ManagedRuntimeReadinessResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MANAGED_RUNTIME_READINESS_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      `${endpoint}${MANAGED_RUNTIME_READINESS_PATH}`,
      {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      },
    );
    const status = response.status;
    try {
      await response.body?.cancel();
    } catch {
      // The readiness probe never reads a body beyond canceling it.
    }
    return { status };
  } finally {
    clearTimeout(timeout);
  }
}
