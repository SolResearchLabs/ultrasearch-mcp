import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPatchToCheckoutForFixture,
  applySearxngWindowsPatch,
  type ExpectedArtifactIdentity,
  type FixtureProvisioningOptions,
  type ProvisioningRefusalCode,
  ProvisioningRefusalError,
  SEARXNG_ARCHIVE_BYTES,
  SEARXNG_ARCHIVE_SHA256,
  SEARXNG_PIN_COMMIT,
  SEARXNG_TREE_ID,
  SEARXNG_WINDOWS_PATCH_BYTES,
  SEARXNG_WINDOWS_PATCH_SHA256,
} from "../../src/control-plane/provisioning.js";
import {
  MANAGED_RUNTIME_MARKER_FILE,
  type ManagedRuntimeDependencies,
  type ManagedRuntimeOptions,
  ManagedRuntimeRefusalError,
  managedRuntimePathsForRoot,
  provisionManagedRuntime,
} from "../../src/control-plane/runtime-lifecycle.js";

/*
 * H4: provisioning and patch identity guards.
 *
 * The identity chain refuses on any mutation of pin commit, tree id, archive
 * digest, archive byte count, patch digest, or patch byte count; `git apply
 * --check` is invoked before any apply (asserted through a spy on the
 * `spawnSync` seam); `apply_check_failed` and `apply_failed` are produced
 * honestly against a local git fixture; missing artifacts fail closed; the
 * checkout file is byte-stable after every refusal; and no fallback, `--3way`,
 * `-reject`, or fuzzy apply path exists in any invocation. The lifecycle layer
 * is pinned for "neither recorded digest" -> `patch_state_unknown` and for the
 * real-helper delegation chain.
 *
 * All fixtures are local `git init` repos in temp dirs. The real Windows
 * patch artifact is never present, fetched, or applied.
 */

const recorder = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[] }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnSyncSpy = (
    command: string,
    args?: readonly string[],
    options?: object,
  ): unknown => {
    recorder.calls.push({ command, args: [...(args ?? [])] });
    return (actual.spawnSync as (...rest: unknown[]) => unknown)(
      command,
      args,
      options,
    );
  };
  return { ...actual, spawnSync: spawnSyncSpy };
});

const FIXTURE_FILE = "searx/valkeydb.py";
const PRISTINE_CONTENTS =
  "import os\n\n\ndef initialize():\n    return False\n";
const PATCHED_CONTENTS = `${PRISTINE_CONTENTS}PATCHED = True\n`;
const FIXTURE_MARKER = "PATCHED = True";
const ARCHIVE_CONTENTS = "synthetic pinned archive (never the real artifact)\n";
const RESOLVED_INTERPRETER_CONTENTS =
  "synthetic resolved base CPython placeholder\n";
const VENV_LAUNCHER_CONTENTS =
  "synthetic venv redirector launcher placeholder\n";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** Arguments that would weaken `git apply` if they ever appeared. */
const FORBIDDEN_APPLY_FLAGS = /3way|reject|fuzz/i;

const temporaryRoots: string[] = [];

function sha256Of(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256OfFile(path: string): string {
  return sha256Of(readFileSync(path));
}

function mutateDigest(digest: string): string {
  const last = digest.endsWith("0") ? "1" : "0";
  return `${digest.slice(0, -1)}${last}`;
}

function fixtureGit(cwd: string, args: string[]): string {
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
  return result.stdout.trim();
}

function refusalCode(run: () => unknown): ProvisioningRefusalCode {
  try {
    run();
  } catch (error) {
    if (error instanceof ProvisioningRefusalError) return error.code;
    throw error;
  }
  throw new Error("expected the provisioning call to refuse");
}

interface Fixture {
  root: string;
  checkout: string;
  file: string;
  patchPath: string;
  archivePath: string;
  identity: ExpectedArtifactIdentity;
}

/**
 * A local `git init` fixture repo with no remote, a synthetic patch generated
 * by `git diff`, and a synthetic archive: no network, no real artifact, no
 * dependency on the pinned SearXNG source.
 */
function createFixture(): Fixture {
  const root = mkdtempSync(
    join(tmpdir(), "ultrasearch-provisioning-identity-"),
  );
  temporaryRoots.push(root);
  const checkout = join(root, "searxng");
  mkdirSync(join(checkout, "searx"), { recursive: true });
  const file = join(checkout, FIXTURE_FILE);

  writeFileSync(file, PRISTINE_CONTENTS, "utf8");
  fixtureGit(checkout, ["init"]);
  fixtureGit(checkout, ["config", "core.autocrlf", "false"]);
  fixtureGit(checkout, ["add", "-A"]);
  fixtureGit(checkout, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);

  const pinCommit = fixtureGit(checkout, ["rev-parse", "HEAD"]);
  const treeId = fixtureGit(checkout, ["rev-parse", "HEAD^{tree}"]);

  writeFileSync(file, PATCHED_CONTENTS, "utf8");
  const patchText = fixtureGit(checkout, ["diff", "--", FIXTURE_FILE]);
  fixtureGit(checkout, ["checkout", "--", FIXTURE_FILE]);
  const patchPath = join(root, "valkeydb-windows.patch");
  writeFileSync(patchPath, `${patchText}\n`, "utf8");

  const archivePath = join(root, "searxng-source.tar");
  writeFileSync(archivePath, ARCHIVE_CONTENTS, "utf8");

  const patchBytes = readFileSync(patchPath);
  const archiveBytes = readFileSync(archivePath);
  const identity: ExpectedArtifactIdentity = {
    pinCommit,
    treeId,
    archiveSha256: sha256Of(archiveBytes),
    archiveBytes: archiveBytes.length,
    patchSha256: sha256Of(patchBytes),
    patchBytes: patchBytes.length,
  };

  return { root, checkout, file, patchPath, archivePath, identity };
}

/** All recorded git invocations that ran `apply` in any form. */
function applyInvocations(): string[][] {
  return recorder.calls
    .map((call) => call.args)
    .filter((args) => args.includes("apply"));
}

function checkInvocations(): string[][] {
  return applyInvocations().filter((args) => args.includes("--check"));
}

function bareApplyInvocations(): string[][] {
  return applyInvocations().filter((args) => !args.includes("--check"));
}

/** Every recorded argv must be free of weakening apply flags. */
function expectNoWeakerApplyFlags(): void {
  for (const call of recorder.calls) {
    for (const arg of call.args) {
      expect(arg).not.toMatch(FORBIDDEN_APPLY_FLAGS);
    }
  }
}

interface MutationCase {
  name: string;
  mutate: (identity: ExpectedArtifactIdentity) => ExpectedArtifactIdentity;
  code: ProvisioningRefusalCode;
}

const MUTATION_MATRIX: MutationCase[] = [
  {
    name: "pin commit mutation",
    mutate: (identity) => ({ ...identity, pinCommit: "0".repeat(40) }),
    code: "pin_mismatch",
  },
  {
    name: "tree id mutation",
    mutate: (identity) => ({ ...identity, treeId: "f".repeat(40) }),
    code: "tree_mismatch",
  },
  {
    name: "archive digest mutation",
    mutate: (identity) => ({
      ...identity,
      archiveSha256: mutateDigest(identity.archiveSha256),
    }),
    code: "archive_digest_mismatch",
  },
  {
    name: "archive byte-count mutation",
    mutate: (identity) => ({
      ...identity,
      archiveBytes: identity.archiveBytes + 1,
    }),
    code: "archive_digest_mismatch",
  },
  {
    name: "patch digest mutation",
    mutate: (identity) => ({
      ...identity,
      patchSha256: mutateDigest(identity.patchSha256),
    }),
    code: "patch_digest_mismatch",
  },
  {
    name: "patch byte-count mutation",
    mutate: (identity) => ({
      ...identity,
      patchBytes: identity.patchBytes + 1,
    }),
    code: "patch_digest_mismatch",
  },
];

describe("Control Plane provisioning identity matrix", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
    recorder.calls.length = 0;
  });

  afterEach(() => {
    // Every temp root created by this suite is disposed here, and the
    // lifecycle roots used by the delegation tests are registered in the same
    // list, so no test artifact survives the file.
    const roots = temporaryRoots.splice(0);
    for (const root of roots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A root that resisted deletion is reported by its own test.
      }
      expect(existsSync(root)).toBe(false);
    }
  });

  function fixtureCall(
    overrides: Partial<FixtureProvisioningOptions> = {},
  ): FixtureProvisioningOptions {
    return {
      checkoutPath: fixture.checkout,
      patchPath: fixture.patchPath,
      archivePath: fixture.archivePath,
      identity: fixture.identity,
      ...overrides,
    };
  }

  it("carries the recorded verified identity constants from lab Stage C2", () => {
    expect(SEARXNG_PIN_COMMIT).toBe("61d660276f1288e7d512e8d8da46cb8442728454");
    expect(SEARXNG_TREE_ID).toBe("e19e011ab39e72759973256c3b6184390e6d9012");
    expect(SEARXNG_ARCHIVE_SHA256).toBe(
      "0561637c70ecb39c70f0c19daaad3743b5bc9ad858f5e609ef326abd4fa7205d",
    );
    expect(SEARXNG_ARCHIVE_BYTES).toBe(21_944_320);
    expect(SEARXNG_WINDOWS_PATCH_SHA256).toBe(
      "75e90a05069199788ccc97c9160fe955a00d207415074e9c6a34245764385dbc",
    );
    expect(SEARXNG_WINDOWS_PATCH_BYTES).toBe(963);
  });

  it("applies the fixture patch only after git apply --check and with the exact argv shapes", () => {
    const result = applyPatchToCheckoutForFixture(fixtureCall());

    expect(result).toEqual({
      applied: true,
      pinCommit: fixture.identity.pinCommit,
      treeId: fixture.identity.treeId,
      archiveSha256: fixture.identity.archiveSha256,
      patchSha256: fixture.identity.patchSha256,
    });
    expect(readFileSync(fixture.file, "utf8")).toBe(PATCHED_CONTENTS);
    expect(readFileSync(fixture.file, "utf8")).toContain(FIXTURE_MARKER);

    // The seam spy proves the check ran, ran first, and was not accompanied by
    // any other apply form.
    expect(applyInvocations()).toEqual([
      ["-C", fixture.checkout, "apply", "--check", "--", fixture.patchPath],
      ["-C", fixture.checkout, "apply", "--", fixture.patchPath],
    ]);
    expect(checkInvocations()).toHaveLength(1);
    expect(bareApplyInvocations()).toHaveLength(1);
    expectNoWeakerApplyFlags();
  });

  it.each(
    MUTATION_MATRIX,
  )("refuses a $name with $code before any apply and keeps the checkout byte-identical", ({
    mutate,
    code,
  }) => {
    const before = sha256OfFile(fixture.file);

    const observed = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ identity: mutate(fixture.identity) }),
      ),
    );

    expect(observed).toBe(code);
    expect(sha256OfFile(fixture.file)).toBe(before);
    expect(applyInvocations()).toEqual([]);
    expectNoWeakerApplyFlags();
  });

  it("refuses apply_check_failed when the patch does not apply cleanly and never applies", () => {
    const rejectingPatch = [
      "diff --git a/searx/valkeydb.py b/searx/valkeydb.py",
      "--- a/searx/valkeydb.py",
      "+++ b/searx/valkeydb.py",
      "@@ -1,2 +1,2 @@",
      "-import definitely-not-the-fixture",
      "+import fixture-replacement",
      " import os",
      "",
    ].join("\n");
    writeFileSync(fixture.patchPath, rejectingPatch, "utf8");
    const patchBytes = readFileSync(fixture.patchPath);
    const before = sha256OfFile(fixture.file);

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: {
            ...fixture.identity,
            patchSha256: sha256Of(patchBytes),
            patchBytes: patchBytes.length,
          },
        }),
      ),
    );

    expect(code).toBe("apply_check_failed");
    expect(checkInvocations()).toHaveLength(1);
    expect(bareApplyInvocations()).toEqual([]);
    expect(sha256OfFile(fixture.file)).toBe(before);
    expectNoWeakerApplyFlags();
  });

  it("refuses apply_failed when the checkout changes between --check and apply", () => {
    const mutated = "MUTATED BETWEEN git apply --check AND git apply\n";
    const before = sha256OfFile(fixture.file);

    // Precondition: without the hook the same call succeeds, so the refusal is
    // caused by the real mid-window mutation and not by the fixture.
    const clean = applyPatchToCheckoutForFixture(fixtureCall());
    expect(clean.applied).toBe(true);
    expect(sha256OfFile(fixture.file)).not.toBe(before);
    fixtureGit(fixture.checkout, ["checkout", "--", FIXTURE_FILE]);
    recorder.calls.length = 0;

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          hooks: {
            afterApplyCheck: () => {
              writeFileSync(fixture.file, mutated, "utf8");
            },
          },
        }),
      ),
    );

    expect(code).toBe("apply_failed");
    expect(checkInvocations()).toHaveLength(1);
    expect(bareApplyInvocations()).toHaveLength(1);
    expect(readFileSync(fixture.file, "utf8")).toBe(mutated);
    expect(readFileSync(fixture.file, "utf8")).not.toContain(FIXTURE_MARKER);
    expectNoWeakerApplyFlags();
  });

  it("re-verifies the patch digest after --check and refuses a patch swapped in between", () => {
    const swappedPatch = `${readFileSync(fixture.patchPath, "utf8")}\n# swapped after --check\n`;
    const before = sha256OfFile(fixture.file);

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          hooks: {
            afterApplyCheck: () => {
              writeFileSync(fixture.patchPath, swappedPatch, "utf8");
            },
          },
        }),
      ),
    );

    expect(code).toBe("patch_digest_mismatch");
    expect(readFileSync(fixture.patchPath, "utf8")).toBe(swappedPatch);
    expect(sha256OfFile(fixture.file)).toBe(before);
    // The digest guard fires before the apply, so the swapped patch is never
    // applied.
    expect(bareApplyInvocations()).toEqual([]);
    expectNoWeakerApplyFlags();
  });

  it("refuses missing artifacts and an unavailable git before any apply", () => {
    const before = sha256OfFile(fixture.file);
    const missingCheckout = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ checkoutPath: join(fixture.root, "missing-checkout") }),
      ),
    );
    expect(missingCheckout).toBe("missing_checkout");

    const missingArchive = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ archivePath: join(fixture.root, "missing-source.tar") }),
      ),
    );
    expect(missingArchive).toBe("missing_archive");

    const missingPatch = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ patchPath: join(fixture.root, "missing.patch") }),
      ),
    );
    expect(missingPatch).toBe("missing_patch");

    const gitUnavailable = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ gitExecutable: join(fixture.root, "no-such-git") }),
      ),
    );
    expect(gitUnavailable).toBe("git_unavailable");

    const nonRepository = join(fixture.root, "not-a-repository");
    mkdirSync(nonRepository, { recursive: true });
    const notARepository = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ checkoutPath: nonRepository }),
      ),
    );
    expect(notARepository).toBe("not_a_repository");

    expect(sha256OfFile(fixture.file)).toBe(before);
    expect(applyInvocations()).toEqual([]);
    expectNoWeakerApplyFlags();
  });

  it("production entry verifies the recorded identity only: the synthetic checkout is refused at the pin", () => {
    const before = sha256OfFile(fixture.file);

    const code = refusalCode(() =>
      applySearxngWindowsPatch({
        checkoutPath: fixture.checkout,
        patchPath: fixture.patchPath,
        archivePath: fixture.archivePath,
      }),
    );

    expect(code).toBe("pin_mismatch");
    expect(sha256OfFile(fixture.file)).toBe(before);
    expect(applyInvocations()).toEqual([]);
    expectNoWeakerApplyFlags();
  });

  it("refuses patch_state_unknown at the lifecycle layer when the checkout matches neither recorded digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "ultrasearch-identity-lifecycle-"));
    temporaryRoots.push(root);
    const paths = managedRuntimePathsForRoot(root);
    mkdirSync(join(paths.checkoutPath, "searx"), { recursive: true });
    writeFileSync(
      join(paths.checkoutPath, "searx", "valkeydb.py"),
      "a digest that is neither the recorded pristine nor the recorded patched content\n",
      "utf8",
    );
    const before = sha256OfFile(
      join(paths.checkoutPath, "searx", "valkeydb.py"),
    );
    // The production identity is the recorded Stage C2/C3 constants; no
    // synthetic expected-digest seam is injected here.
    const dependencies: ManagedRuntimeDependencies = {
      processLayer: {
        platform: "win32",
        spawn: () => {
          throw new Error("never spawned");
        },
        inspect: () => null,
        listenersOnPort: () => [],
        terminate: () => {},
        rootScopedSurvivors: () => ({
          survivorsPresent: false,
          survivorPids: [],
          unverifiableReason: null,
        }),
      },
    };
    const options: ManagedRuntimeOptions = { paths, dependencies };

    let error: ManagedRuntimeRefusalError | null = null;
    try {
      await provisionManagedRuntime(options);
    } catch (caught) {
      if (caught instanceof ManagedRuntimeRefusalError) error = caught;
      else throw caught;
    }

    expect(error?.code).toBe("patch_state_unknown");
    expect(sha256OfFile(join(paths.checkoutPath, "searx", "valkeydb.py"))).toBe(
      before,
    );
    expect(existsSync(join(root, MANAGED_RUNTIME_MARKER_FILE))).toBe(false);
    expect(existsSync(join(root, "state", "managed-runtime.json"))).toBe(false);
    expect(applyInvocations()).toEqual([]);
  });

  it("delegates to the production entry and carries the helper refusal verbatim at the lifecycle layer", async () => {
    const root = mkdtempSync(join(tmpdir(), "ultrasearch-delegation-"));
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
    writeFileSync(paths.archivePath, ARCHIVE_CONTENTS, "utf8");
    writeFileSync(paths.patchPath, "synthetic patch text\n", "utf8");
    writeFileSync(
      resolvedInterpreterPath,
      RESOLVED_INTERPRETER_CONTENTS,
      "utf8",
    );
    writeFileSync(
      join(venvRoot, "pyvenv.cfg"),
      `home = ${dirname(resolvedInterpreterPath)}\nimplementation = CPython\n`,
      "utf8",
    );
    // A real local git repository: the production entry reaches its pin check.
    fixtureGit(paths.checkoutPath, ["init"]);
    fixtureGit(paths.checkoutPath, ["config", "core.autocrlf", "false"]);
    fixtureGit(paths.checkoutPath, ["add", "-A"]);
    fixtureGit(paths.checkoutPath, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ]);
    recorder.calls.length = 0;
    const before = sha256OfFile(
      join(paths.checkoutPath, "searx", "valkeydb.py"),
    );
    // No `applyWindowsPatch` injection: the production entry from
    // src/control-plane/provisioning.ts runs with the recorded identity. The
    // lifecycle-side digest identity stays on the documented test-only seam so
    // the call reaches the helper's real pin check instead of failing the
    // lifecycle's own staged-digest gate first.
    const dependencies: ManagedRuntimeDependencies = {
      processLayer: {
        platform: "win32",
        spawn: () => {
          throw new Error("never spawned");
        },
        inspect: () => null,
        listenersOnPort: () => [],
        terminate: () => {},
        rootScopedSurvivors: () => ({
          survivorsPresent: false,
          survivorPids: [],
          unverifiableReason: null,
        }),
      },
      expectedDigests: {
        pristineValkeydbSha256: sha256Of(PRISTINE_CONTENTS),
        patchedValkeydbSha256: sha256Of(PATCHED_CONTENTS),
      },
    };

    let error: ManagedRuntimeRefusalError | null = null;
    try {
      await provisionManagedRuntime({ paths, dependencies });
    } catch (caught) {
      if (caught instanceof ManagedRuntimeRefusalError) error = caught;
      else throw caught;
    }

    expect(error?.code).toBe("provisioning_refused");
    expect(error?.detail).toContain("pin_mismatch");
    expect(sha256OfFile(join(paths.checkoutPath, "searx", "valkeydb.py"))).toBe(
      before,
    );
    expect(applyInvocations()).toEqual([]);
    expectNoWeakerApplyFlags();
  });

  it("deliberately exercises the expectedDigests seam end-to-end: check before apply, patched digest recorded, no re-apply on re-provision", async () => {
    const root = mkdtempSync(join(tmpdir(), "ultrasearch-seam-chain-"));
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
    writeFileSync(
      join(venvRoot, "Scripts", "python.exe"),
      VENV_LAUNCHER_CONTENTS,
      "utf8",
    );
    writeFileSync(
      resolvedInterpreterPath,
      RESOLVED_INTERPRETER_CONTENTS,
      "utf8",
    );
    writeFileSync(
      join(venvRoot, "pyvenv.cfg"),
      `home = ${dirname(resolvedInterpreterPath)}\nimplementation = CPython\n`,
      "utf8",
    );

    // Commit the pristine file, generate the patch with real `git diff`, then
    // restore the pristine file: the same fixture shape H4 uses above, now
    // wired to the lifecycle through the documented test-only seams.
    fixtureGit(paths.checkoutPath, ["init"]);
    fixtureGit(paths.checkoutPath, ["config", "core.autocrlf", "false"]);
    fixtureGit(paths.checkoutPath, ["add", "-A"]);
    fixtureGit(paths.checkoutPath, [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ]);
    const pinCommit = fixtureGit(paths.checkoutPath, ["rev-parse", "HEAD"]);
    const treeId = fixtureGit(paths.checkoutPath, ["rev-parse", "HEAD^{tree}"]);
    writeFileSync(
      join(paths.checkoutPath, "searx", "valkeydb.py"),
      PATCHED_CONTENTS,
      "utf8",
    );
    const patchText = fixtureGit(paths.checkoutPath, [
      "diff",
      "--",
      "searx/valkeydb.py",
    ]);
    fixtureGit(paths.checkoutPath, ["checkout", "--", "searx/valkeydb.py"]);
    writeFileSync(paths.patchPath, `${patchText}\n`, "utf8");

    const patchBytes = readFileSync(paths.patchPath);
    const archiveBytes = readFileSync(paths.archivePath);
    const identity: ExpectedArtifactIdentity = {
      pinCommit,
      treeId,
      archiveSha256: sha256Of(archiveBytes),
      archiveBytes: archiveBytes.length,
      patchSha256: sha256Of(patchBytes),
      patchBytes: patchBytes.length,
    };
    const dependencies: ManagedRuntimeDependencies = {
      applyWindowsPatch: (options) =>
        applyPatchToCheckoutForFixture({ ...options, identity }),
      processLayer: {
        platform: "win32",
        spawn: () => {
          throw new Error("never spawned");
        },
        inspect: () => null,
        listenersOnPort: () => [],
        terminate: () => {},
        rootScopedSurvivors: () => ({
          survivorsPresent: false,
          survivorPids: [],
          unverifiableReason: null,
        }),
      },
      clock: () => new Date("2026-09-12T00:00:00.000Z"),
      sleep: async () => {},
      expectedDigests: {
        pristineValkeydbSha256: sha256Of(PRISTINE_CONTENTS),
        patchedValkeydbSha256: sha256Of(PATCHED_CONTENTS),
      },
    };
    recorder.calls.length = 0;

    const provisioned = await provisionManagedRuntime({ paths, dependencies });

    expect(provisioned.outcome).toBe("provisioned");
    expect(applyInvocations()).toEqual([
      ["-C", paths.checkoutPath, "apply", "--check", "--", paths.patchPath],
      ["-C", paths.checkoutPath, "apply", "--", paths.patchPath],
    ]);
    expectNoWeakerApplyFlags();
    // The checkout now carries exactly the recorded patched content, and the
    // record carries the identity chain the helper verified.
    expect(
      readFileSync(join(paths.checkoutPath, "searx", "valkeydb.py"), "utf8"),
    ).toBe(PATCHED_CONTENTS);
    const stateFile = join(root, "state", "managed-runtime.json");
    const record = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      state: "provisioned",
      pinCommit,
      treeId,
      archiveSha256: identity.archiveSha256,
      patchSha256: identity.patchSha256,
      patchedFileSha256: sha256Of(PATCHED_CONTENTS),
    });
    expect(existsSync(join(root, MANAGED_RUNTIME_MARKER_FILE))).toBe(true);

    // A re-provision is idempotent and never re-runs the patch.
    const stateBefore = readFileSync(stateFile, "utf8");
    recorder.calls.length = 0;
    const again = await provisionManagedRuntime({ paths, dependencies });

    expect(again.outcome).toBe("already_provisioned");
    expect(applyInvocations()).toEqual([]);
    expect(readFileSync(stateFile, "utf8")).toBe(stateBefore);
  });
});
