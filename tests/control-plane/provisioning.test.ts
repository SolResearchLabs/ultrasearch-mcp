import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPatchToCheckoutForFixture,
  applySearxngWindowsPatch,
  type ExpectedArtifactIdentity,
  type FixtureProvisioningOptions,
  ProvisioningRefusalError,
  SEARXNG_ARCHIVE_BYTES,
  SEARXNG_ARCHIVE_SHA256,
  SEARXNG_PIN_COMMIT,
  SEARXNG_TREE_ID,
  SEARXNG_WINDOWS_PATCH_BYTES,
  SEARXNG_WINDOWS_PATCH_SHA256,
} from "../../src/control-plane/provisioning.js";

const FIXTURE_FILE = "searx/valkeydb.py";
const FIXTURE_PRISTINE = [
  "import os",
  "import pwd",
  "",
  "",
  "def initialize():",
  "    return False",
  "",
].join("\n");
const FIXTURE_MARKER = 'FIXTURE_PATCH_MARKER = "guarded"';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

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

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mutateDigest(digest: string): string {
  const last = digest.endsWith("0") ? "1" : "0";
  return `${digest.slice(0, -1)}${last}`;
}

function refusalCode(run: () => unknown): string {
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
 * A local `git init` fixture repo with no remote, a synthetic patch, and a
 * synthetic archive: no network, no dependency on the real artifact, and no
 * dependency on the real SearXNG source.
 */
function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ultrasearch-provisioning-"));
  const checkout = join(root, "searxng");
  mkdirSync(join(checkout, "searx"), { recursive: true });
  const file = join(checkout, FIXTURE_FILE);

  writeFileSync(file, FIXTURE_PRISTINE);
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

  writeFileSync(
    file,
    FIXTURE_PRISTINE.replace("import pwd", `import pwd\n${FIXTURE_MARKER}`),
  );
  const patchText = fixtureGit(checkout, ["diff", "--", FIXTURE_FILE]);
  fixtureGit(checkout, ["checkout", "--", FIXTURE_FILE]);
  const patchPath = join(root, "valkeydb-windows.patch");
  writeFileSync(patchPath, `${patchText}\n`);

  const archivePath = join(root, "searxng-source.tar");
  writeFileSync(archivePath, "fixture archive bytes (never the real artifact)");

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

describe("Control Plane Windows provisioning", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  /**
   * The fixture/test-only variant is the only entry that accepts an identity;
   * this helper points it at the synthetic fixture.
   */
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

  it("carries the recorded verified digest constants from lab Stage C2", () => {
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

  it("applies the fixture patch to a checkout at the expected identity", () => {
    const result = applyPatchToCheckoutForFixture(fixtureCall());

    expect(result).toEqual({
      applied: true,
      pinCommit: fixture.identity.pinCommit,
      treeId: fixture.identity.treeId,
      archiveSha256: fixture.identity.archiveSha256,
      patchSha256: fixture.identity.patchSha256,
    });
    expect(readFileSync(fixture.file, "utf8")).toContain(FIXTURE_MARKER);
  });

  it("refuses a checkout that is not at the expected pin", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: { ...fixture.identity, pinCommit: "0".repeat(40) },
        }),
      ),
    );

    expect(code).toBe("pin_mismatch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses a checkout whose tree id does not match", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: { ...fixture.identity, treeId: "f".repeat(40) },
        }),
      ),
    );

    expect(code).toBe("tree_mismatch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses a patch whose SHA-256 does not match", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: { ...fixture.identity, patchSha256: "0".repeat(64) },
        }),
      ),
    );

    expect(code).toBe("patch_digest_mismatch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("fails closed when an expected digest is mutated", () => {
    const patchCode = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: {
            ...fixture.identity,
            patchSha256: mutateDigest(fixture.identity.patchSha256),
          },
        }),
      ),
    );
    const archiveCode = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          identity: {
            ...fixture.identity,
            archiveSha256: mutateDigest(fixture.identity.archiveSha256),
          },
        }),
      ),
    );

    expect(patchCode).toBe("patch_digest_mismatch");
    expect(archiveCode).toBe("archive_digest_mismatch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses when git apply --check fails and never applies", () => {
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
    writeFileSync(fixture.patchPath, rejectingPatch);
    const patchBytes = readFileSync(fixture.patchPath);

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
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses a checkout path that does not exist", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ checkoutPath: join(fixture.root, "missing-checkout") }),
      ),
    );

    expect(code).toBe("missing_checkout");
  });

  it("refuses when the source archive file is missing", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ archivePath: join(fixture.root, "missing-source.tar") }),
      ),
    );

    expect(code).toBe("missing_archive");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses when the patch file is missing", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ patchPath: join(fixture.root, "missing.patch") }),
      ),
    );

    expect(code).toBe("missing_patch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses when the git executable is unavailable", () => {
    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ gitExecutable: join(fixture.root, "no-such-git") }),
      ),
    );

    expect(code).toBe("git_unavailable");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses when the target directory is not a git repository", () => {
    const nonRepository = join(fixture.root, "not-a-repository");
    mkdirSync(nonRepository, { recursive: true });

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({ checkoutPath: nonRepository }),
      ),
    );

    expect(code).toBe("not_a_repository");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("refuses with apply_failed when the checkout changes after a passing --check", () => {
    // The checkout is mutated in the real window between `git apply --check`
    // and `git apply`; the check genuinely passes against the pristine file and
    // the apply genuinely fails against the changed file.
    const mutated =
      "MUTATED BETWEEN git apply --check AND git apply\n# no hunk context here\n";

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          hooks: {
            afterApplyCheck: () => {
              writeFileSync(fixture.file, mutated);
            },
          },
        }),
      ),
    );

    expect(code).toBe("apply_failed");
    const finalContents = readFileSync(fixture.file, "utf8");
    expect(finalContents).toBe(mutated);
    expect(finalContents).not.toContain(FIXTURE_MARKER);
  });

  it("re-verifies the patch digest after --check and refuses a patch swapped in between", () => {
    const swappedPatch = `${readFileSync(fixture.patchPath, "utf8")}\n# swapped after --check\n`;

    const code = refusalCode(() =>
      applyPatchToCheckoutForFixture(
        fixtureCall({
          hooks: {
            afterApplyCheck: () => {
              writeFileSync(fixture.patchPath, swappedPatch);
            },
          },
        }),
      ),
    );

    expect(code).toBe("patch_digest_mismatch");
    expect(readFileSync(fixture.patchPath, "utf8")).toBe(swappedPatch);
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("production entry verifies the recorded identity only and ignores an injected override", () => {
    // The options type of the production entry carries no identity override;
    // `src/control-plane/provisioning.ts` holds a compile-time guard that fails
    // `tsc --noEmit` if `expected` is ever added back. This test proves the
    // runtime half: even a smuggled override changes nothing, because the
    // fixture checkout is not the pinned snapshot and the recorded pin is what
    // counts.
    const smuggled = {
      checkoutPath: fixture.checkout,
      patchPath: fixture.patchPath,
      archivePath: fixture.archivePath,
      expected: fixture.identity,
    } as unknown as Parameters<typeof applySearxngWindowsPatch>[0];

    const code = refusalCode(() => applySearxngWindowsPatch(smuggled));

    expect(code).toBe("pin_mismatch");
    expect(readFileSync(fixture.file, "utf8")).toBe(FIXTURE_PRISTINE);
  });

  it("does not let ambient GIT_* variables redirect the git children", () => {
    // Negative control: with an inherited environment these ambient values
    // would make `git -C <checkout> rev-parse HEAD` resolve the wrong
    // repository (or fail); the explicit child environment must ignore them.
    const poisoned: Record<string, string> = {
      GIT_DIR: join(fixture.root, "ambient-git-dir"),
      GIT_WORK_TREE: join(fixture.root, "ambient-work-tree"),
      GIT_INDEX_FILE: join(fixture.root, "ambient-index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: join(fixture.root, "ambient-hooks"),
      GIT_OBJECT_DIRECTORY: join(fixture.root, "ambient-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(
        fixture.root,
        "ambient-alt-objects",
      ),
      GIT_CONFIG_PARAMETERS: "'core.hooksPath=ambient-hooks'",
    };
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(poisoned)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const result = applyPatchToCheckoutForFixture(fixtureCall());

      expect(result).toEqual({
        applied: true,
        pinCommit: fixture.identity.pinCommit,
        treeId: fixture.identity.treeId,
        archiveSha256: fixture.identity.archiveSha256,
        patchSha256: fixture.identity.patchSha256,
      });
      expect(readFileSync(fixture.file, "utf8")).toContain(FIXTURE_MARKER);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
