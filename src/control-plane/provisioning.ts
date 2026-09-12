import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/**
 * Recorded verified values from lab Stage C2
 * (`slices/FULL-PACKAGE-005/STAGE-C2-PLAN.md`): the pinned SearXNG commit,
 * its tree id, the pinned source archive digest and byte count, and the
 * digest of the external Windows accommodation patch. Every value below was
 * re-derived against the pinned snapshot and verified on 2026-09-12. They are
 * identities, not hints: any mismatch refuses provisioning.
 */
export const SEARXNG_PIN_COMMIT = "61d660276f1288e7d512e8d8da46cb8442728454";
export const SEARXNG_TREE_ID = "e19e011ab39e72759973256c3b6184390e6d9012";
export const SEARXNG_ARCHIVE_SHA256 =
  "0561637c70ecb39c70f0c19daaad3743b5bc9ad858f5e609ef326abd4fa7205d";
export const SEARXNG_ARCHIVE_BYTES = 21_944_320;
export const SEARXNG_WINDOWS_PATCH_SHA256 =
  "75e90a05069199788ccc97c9160fe955a00d207415074e9c6a34245764385dbc";
export const SEARXNG_WINDOWS_PATCH_BYTES = 963;

export interface ExpectedArtifactIdentity {
  pinCommit: string;
  treeId: string;
  archiveSha256: string;
  archiveBytes: number;
  patchSha256: string;
  patchBytes: number;
}

export type ProvisioningRefusalCode =
  | "missing_checkout"
  | "missing_archive"
  | "missing_patch"
  | "git_unavailable"
  | "not_a_repository"
  | "pin_mismatch"
  | "tree_mismatch"
  | "archive_digest_mismatch"
  | "patch_digest_mismatch"
  | "apply_check_failed"
  | "apply_failed";

/**
 * Fail-closed refusal. Provisioning never falls back to a weaker check, a
 * `--3way` merge, `-reject` output, a fuzzy apply, or a silent skip: every
 * mismatch throws.
 */
export class ProvisioningRefusalError extends Error {
  readonly code: ProvisioningRefusalCode;

  constructor(code: ProvisioningRefusalCode, detail: string) {
    super(`Windows provisioning refused (${code}): ${detail}`);
    this.name = "ProvisioningRefusalError";
    this.code = code;
  }
}

/**
 * Options for `applySearxngWindowsPatch`, the production provisioning entry.
 * Deliberately carries no identity override parameter: that entry verifies the
 * checkout against the recorded constants in this module and against nothing
 * else, so a caller can neither substitute a pin, tree, archive digest or
 * patch digest nor have a checkout that is not the pinned snapshot accepted.
 */
export interface SearxngWindowsProvisioningOptions {
  /** Path to a checkout of the pinned SearXNG source. */
  checkoutPath: string;
  /** Path to the external accommodation patch; never vendored here. */
  patchPath: string;
  /** Path to the pinned source archive the checkout came from. */
  archivePath: string;
  /** Git executable to run; defaults to `git` on `PATH`. */
  gitExecutable?: string;
}

/**
 * Compile-time guard for the production entry's contract. If an `expected`
 * identity override is ever added to `SearxngWindowsProvisioningOptions`, this
 * conditional resolves to `never` and the assignment below stops compiling, so
 * `tsc --noEmit` fails rather than the override shipping unnoticed. The
 * underscore marks the constant as deliberately unused at runtime.
 */
type ProductionOptionsAcceptNoIdentityOverride =
  "expected" extends keyof SearxngWindowsProvisioningOptions ? never : true;

const _productionOptionsAcceptNoIdentityOverride: ProductionOptionsAcceptNoIdentityOverride = true;

export interface SearxngWindowsProvisioningResult {
  applied: true;
  pinCommit: string;
  treeId: string;
  archiveSha256: string;
  patchSha256: string;
}

const RECORDED_IDENTITY: ExpectedArtifactIdentity = {
  pinCommit: SEARXNG_PIN_COMMIT,
  treeId: SEARXNG_TREE_ID,
  archiveSha256: SEARXNG_ARCHIVE_SHA256,
  archiveBytes: SEARXNG_ARCHIVE_BYTES,
  patchSha256: SEARXNG_WINDOWS_PATCH_SHA256,
  patchBytes: SEARXNG_WINDOWS_PATCH_BYTES,
};

/**
 * Test-only hooks for `applyPatchToCheckoutForFixture`; the production entry
 * passes none.
 */
export interface FixtureProvisioningHooks {
  /**
   * Runs after `git apply --check` passes and before the pre-apply patch digest
   * re-verification, so a test can mutate the checkout or the patch in the
   * window between check and apply.
   */
  afterApplyCheck?: () => void;
}

export interface FixtureProvisioningOptions
  extends SearxngWindowsProvisioningOptions {
  /** Explicit identity to verify against; the recorded constants are NOT used. */
  identity: ExpectedArtifactIdentity;
  /** Test-only hooks; production provisioning passes none. */
  hooks?: FixtureProvisioningHooks;
}

function digestOfFile(
  path: string,
  missingCode: ProvisioningRefusalCode,
): { sha256: string; bytes: number } {
  try {
    const contents = readFileSync(path);
    return {
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length,
    };
  } catch {
    throw new ProvisioningRefusalError(missingCode, `cannot read ${path}`);
  }
}

/** Variables copied into the git child environment; nothing else is. */
const GIT_CHILD_ENV_ALLOWLIST = ["PATH", "SystemRoot", "TEMP", "TMP"] as const;

/**
 * Refused explicitly on top of the allowlist. Each of these redirects what
 * `git -C <path>` resolves even though git is handed an explicit working
 * directory; `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*` are the environment
 * families behind `GIT_CONFIG_COUNT`.
 */
const GIT_CHILD_ENV_REFUSED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

/**
 * Explicit environment for every git child process. It is built from an
 * allowlist rather than inherited from the process environment, so ambient
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_COUNT`,
 * `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`,
 * `GIT_OBJECT_DIRECTORY` and `GIT_ALTERNATE_OBJECT_DIRECTORIES` cannot reach a
 * provisioning git child. `PATHEXT` is kept on Windows so the runner can
 * resolve executables, and `GIT_TERMINAL_PROMPT=0` makes a credential prompt
 * fail instead of blocking the call.
 */
function gitChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of GIT_CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "win32" && process.env.PATHEXT !== undefined) {
    env.PATHEXT = process.env.PATHEXT;
  }
  for (const key of GIT_CHILD_ENV_REFUSED) {
    delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function runGit(
  gitExecutable: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(gitExecutable, args, {
    encoding: "utf8",
    env: gitChildEnv(),
    windowsHide: true,
  });
  if (result.error) {
    throw new ProvisioningRefusalError(
      "git_unavailable",
      `${gitExecutable}: ${result.error.message}`,
    );
  }
  if (result.status === null) {
    throw new ProvisioningRefusalError(
      "git_unavailable",
      `${gitExecutable} exited without a status`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function assertPatchIdentity(
  digest: { sha256: string; bytes: number },
  identity: ExpectedArtifactIdentity,
  detailPrefix = "",
): void {
  if (
    digest.sha256 !== identity.patchSha256.toLowerCase() ||
    digest.bytes !== identity.patchBytes
  ) {
    throw new ProvisioningRefusalError(
      "patch_digest_mismatch",
      `${detailPrefix}expected ${identity.patchSha256} ` +
        `(${identity.patchBytes} bytes), observed ${digest.sha256} ` +
        `(${digest.bytes} bytes)`,
    );
  }
}

function runProvisioning(
  options: SearxngWindowsProvisioningOptions,
  identity: ExpectedArtifactIdentity,
  hooks: FixtureProvisioningHooks | undefined,
): SearxngWindowsProvisioningResult {
  const git = options.gitExecutable ?? "git";

  if (!existsSync(options.checkoutPath)) {
    throw new ProvisioningRefusalError(
      "missing_checkout",
      `no checkout at ${options.checkoutPath}`,
    );
  }

  const head = runGit(git, ["-C", options.checkoutPath, "rev-parse", "HEAD"]);
  if (head.status !== 0) {
    throw new ProvisioningRefusalError(
      "not_a_repository",
      head.stderr || head.stdout,
    );
  }
  if (head.stdout !== identity.pinCommit) {
    throw new ProvisioningRefusalError(
      "pin_mismatch",
      `expected ${identity.pinCommit}, observed ${head.stdout}`,
    );
  }

  const tree = runGit(git, [
    "-C",
    options.checkoutPath,
    "rev-parse",
    "HEAD^{tree}",
  ]);
  if (tree.status !== 0) {
    throw new ProvisioningRefusalError(
      "not_a_repository",
      tree.stderr || tree.stdout,
    );
  }
  if (tree.stdout !== identity.treeId) {
    throw new ProvisioningRefusalError(
      "tree_mismatch",
      `expected ${identity.treeId}, observed ${tree.stdout}`,
    );
  }

  const archive = digestOfFile(options.archivePath, "missing_archive");
  if (
    archive.sha256 !== identity.archiveSha256.toLowerCase() ||
    archive.bytes !== identity.archiveBytes
  ) {
    throw new ProvisioningRefusalError(
      "archive_digest_mismatch",
      `expected ${identity.archiveSha256} (${identity.archiveBytes} bytes), ` +
        `observed ${archive.sha256} (${archive.bytes} bytes)`,
    );
  }

  const patch = digestOfFile(options.patchPath, "missing_patch");
  assertPatchIdentity(patch, identity);

  // TOCTOU guard: the digest verified above is re-derived immediately before
  // `git apply --check`, so a patch swapped after the first read is refused
  // rather than checked.
  assertPatchIdentity(
    digestOfFile(options.patchPath, "missing_patch"),
    identity,
    "patch changed before git apply --check: ",
  );

  const check = runGit(git, [
    "-C",
    options.checkoutPath,
    "apply",
    "--check",
    "--",
    options.patchPath,
  ]);
  if (check.status !== 0) {
    throw new ProvisioningRefusalError(
      "apply_check_failed",
      check.stderr || check.stdout,
    );
  }

  hooks?.afterApplyCheck?.();

  // TOCTOU guard: and again immediately before `git apply`, so a patch swapped
  // between check and apply is refused rather than applied.
  assertPatchIdentity(
    digestOfFile(options.patchPath, "missing_patch"),
    identity,
    "patch changed after git apply --check: ",
  );

  const apply = runGit(git, [
    "-C",
    options.checkoutPath,
    "apply",
    "--",
    options.patchPath,
  ]);
  if (apply.status !== 0) {
    throw new ProvisioningRefusalError(
      "apply_failed",
      apply.stderr || apply.stdout,
    );
  }

  return {
    applied: true,
    pinCommit: head.stdout,
    treeId: tree.stdout,
    archiveSha256: archive.sha256,
    patchSha256: patch.sha256,
  };
}

/**
 * Production provisioning entry. Applies the external Windows accommodation
 * patch to a checkout of the pinned SearXNG source after verifying - against
 * the recorded constants in this module and against nothing else - the pin
 * commit, the tree id, the archive digest and byte count, the patch digest and
 * byte count, and `git apply --check`. The patch digest is re-verified
 * immediately before the check and again immediately before the apply.
 *
 * This entry accepts no identity override parameter: a caller cannot
 * substitute a pin, tree, archive or patch digest, and a checkout that is not
 * the pinned snapshot is refused with `pin_mismatch` or `tree_mismatch`. Any
 * mismatch throws `ProvisioningRefusalError`; there is no fallback path, no
 * `--3way`, no `-reject`, no fuzzy apply, and no silent skip.
 *
 * Git children run with an explicit allowlisted environment (`PATH`,
 * `SystemRoot`, `TEMP`, `TMP`, and `PATHEXT` on Windows) plus
 * `GIT_TERMINAL_PROMPT=0`, so ambient `GIT_*` variables cannot redirect what
 * `git -C` resolves.
 *
 * This function performs no network access, reads no credentials, and never
 * copies or vendors upstream sources - the patch artifact stays external to
 * this repository and is never used as a test fixture. Importing this module
 * has no side effects; nothing runs until an explicit call.
 */
export function applySearxngWindowsPatch(
  options: SearxngWindowsProvisioningOptions,
): SearxngWindowsProvisioningResult {
  return runProvisioning(options, RECORDED_IDENTITY, undefined);
}

/**
 * Fixture/test-only low-level variant. It applies a patch to a checkout using
 * an identity supplied by the caller, so the test suite can point it at
 * synthetic temp-dir fixtures without touching the real artifact. It is not
 * part of any provisioning path: nothing in this repository calls it outside
 * the test suite, and production callers must use `applySearxngWindowsPatch`,
 * which verifies the recorded identity only and accepts no override.
 *
 * The optional hooks exist so tests can exercise the window between
 * `git apply --check` and `git apply` honestly; production provisioning passes
 * none.
 */
export function applyPatchToCheckoutForFixture(
  options: FixtureProvisioningOptions,
): SearxngWindowsProvisioningResult {
  return runProvisioning(options, options.identity, options.hooks);
}
