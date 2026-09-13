import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// FULL-PACKAGE-008 track T5 (FP-008 planning packet section 7.3 row 14;
// DQ-041 R3). Statically decidable release-claim guards. Each check names the
// packet gap it guards:
//   - G3  install-path docs describe artifacts that are not published yet;
//   - G4  live release automation was tag-triggered (T1a removes the trigger);
//   - G8  MCPB platform claims vs the Windows-first managed runtime scope
//         (closed by the required scope sentence in docs/release-notes/v0.2.0.md);
//   - G11/G12 release-boundary statements and the canonical endpoint must not
//         be lost by the T2/T3 wording pass.
//
// Fake-only and offline: static repository reads only - no network, no spawns,
// no package-manager commands. tests/config/defaults-consistency.test.ts keeps
// its own endpoint and boundary assertions and is not re-implemented here; this
// suite adds only the release-specific retention checks.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepositoryFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readExampleFiles(): string[] {
  return readdirSync(join(repoRoot, "examples"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `examples/${entry.name}`)
    .sort();
}

// G3 wording anchors (DQ-041 Q8 grants exactly this correction class). A
// surface "carries explicit release-target wording" when it contains one of
// these recorded phrasings.
const RELEASE_TARGET_WORDING = [
  "Release target",
  "once the first public GitHub Release is published",
  "Until that release is published",
  "is published to npm",
  "depends on the npm package being published",
  "after publication",
  "Before a GitHub Release exists",
] as const;

// Recorded-publication allowlist: a surface listed here is exempt from the
// release-target wording requirement because the Owner published the artifact
// it points at. Populated only after the Owner publishes; empty today on
// purpose, so every npx/global-install surface must carry release-target
// wording or be scoped by a sentence that names it.
const PUBLICATION_MARKERS: ReadonlySet<string> = new Set<string>();

// A surface is a machine-readable example launcher when it points the MCP host
// command at npx (the three example configs the packet lists in section 4.3).
const NPX_LAUNCH_PATTERN = /"command"\s*:\s*"npx"|command\s*=\s*"npx"/;

// Prose install surfaces present npx or global-install commands directly.
const INSTALL_COMMAND_PATTERN = /npx\s+-y|npm install -g/;

// The T2 allowance covers README.md and docs/deployment.md only; examples/**
// was not granted, so an example config can only be scoped by a sentence inside
// a granted surface.
const SCOPING_SURFACES = ["README.md", "docs/deployment.md"] as const;

function hasReleaseTargetWording(text: string): boolean {
  return RELEASE_TARGET_WORDING.some((phrase) => text.includes(phrase));
}

// Returns the doc line that scopes the named example, or null when no granted
// surface names it on a line that also carries release-target wording.
function scopingSentenceFor(target: string): string | null {
  for (const surface of SCOPING_SURFACES) {
    const line = readRepositoryFile(surface)
      .split(/\r?\n/)
      .find(
        (candidate) =>
          candidate.includes(target) && hasReleaseTargetWording(candidate),
      );
    if (line) return `${surface}: ${line.trim()}`;
  }
  return null;
}

describe("FULL-PACKAGE-008 release claims", () => {
  it("keeps every prose install surface on explicit release-target wording (G3)", () => {
    for (const surface of ["README.md", "docs/deployment.md"]) {
      const text = readRepositoryFile(surface);
      // Non-vacuous: the surface still presents install commands today, so the
      // wording check below guards real surfaces rather than empty files.
      expect(
        INSTALL_COMMAND_PATTERN.test(text),
        `${surface} no longer presents install commands`,
      ).toBe(true);
      expect(
        hasReleaseTargetWording(text),
        `${surface} dropped its release-target wording`,
      ).toBe(true);
    }
  });

  it("scopes every machine-readable npx example to a release-target sentence or a publication marker (G3)", () => {
    const npxExamples = readExampleFiles().filter((path) =>
      NPX_LAUNCH_PATTERN.test(readRepositoryFile(path)),
    );
    expect(npxExamples).toEqual([
      "examples/claude-desktop.json",
      "examples/codex.toml",
      "examples/vscode-mcp.json",
    ]);

    const uncovered = npxExamples.filter(
      (path) =>
        !PUBLICATION_MARKERS.has(path) && scopingSentenceFor(path) === null,
    );
    // Known G3 residual: examples/codex.toml launches through npx, no granted
    // T2 surface names it, and the T2 allowance does not include examples/**.
    // Recorded exactly so coverage cannot silently regress further; it clears
    // (and this expectation must be updated) once the file is scoped or a
    // publication marker lands. See the FINDING test below.
    expect(uncovered).toEqual(["examples/codex.toml"]);
  });

  // FINDING (G3): documents rather than fails. examples/codex.toml remains an
  // unscoped npx surface because the grant stops at README.md and
  // docs/deployment.md. When this test fails, the gap closed: delete this test
  // and the residual entry in the test above, then move the file into the hard
  // coverage expectation.
  it("FINDING: examples/codex.toml remains an unscoped npx surface pending the G3 wording pass", () => {
    expect(
      NPX_LAUNCH_PATTERN.test(readRepositoryFile("examples/codex.toml")),
    ).toBe(true);
    expect(scopingSentenceFor("examples/codex.toml")).toBeNull();
    expect(PUBLICATION_MARKERS.has("examples/codex.toml")).toBe(false);
  });

  it("retains the canonical local-search endpoint on the release surfaces (G11)", () => {
    // The defaults-consistency suite owns the pinned endpoint assertions; this
    // is the release-facing retention check the T5 row requires. Each file is
    // required by tests/config/defaults-consistency.test.ts:
    // README.md (:73), docs/local-runtime.md (:75), docs/release-policy.md
    // (:76), examples/env.example (:57-59), examples/claude-desktop.json
    // (:60-62), examples/codex.toml (:63-65).
    const canonical = "http://127.0.0.1:8099";
    for (const surface of [
      "README.md",
      "docs/local-runtime.md",
      "docs/release-policy.md",
      "examples/env.example",
      "examples/claude-desktop.json",
      "examples/codex.toml",
    ]) {
      expect(
        readRepositoryFile(surface),
        `${surface} must keep ${canonical}`,
      ).toContain(canonical);
    }
  });

  it("keeps the README release-boundary statements (no watcher, no auto-restart, no OS service) (G12)", () => {
    // Packet section 2.4 "No resident supervisor" (README.md:127-128). These
    // sentences separate implemented behavior from future work, so a doc
    // wording pass must not drop them. The README wraps mid-sentence, so the
    // phrases are matched against whitespace-normalized text.
    const readme = readRepositoryFile("README.md").replace(/\s+/g, " ");
    for (const statement of [
      "no resident watcher",
      "no auto-restart",
      "no OS service registration",
    ]) {
      expect(readme, `README.md must keep "${statement}"`).toContain(statement);
    }
  });

  it("keeps the implemented-behavior-only release rule in docs/release-policy.md (G14)", () => {
    // Packet section 1 sequencing law: docs/release-policy.md:33-35 and
    // MASTER_PLAN.md:45 - the release story describes only implemented
    // behavior; planned capabilities stay marked as future work.
    const policy = readRepositoryFile("docs/release-policy.md");
    expect(policy).toContain(
      "The release story may describe only implemented behavior.",
    );
    expect(policy).toContain("remain clearly identified as future work");
  });

  it("keeps the release workflow manual-only with the FP-008 guard comment (G4, T1a)", () => {
    const workflow = readRepositoryFile(".github/workflows/release.yml");

    // T1a guard comment (DQ-041 Q4(b)): the workflow records that pushing a
    // "v*" tag or dispatching it is an Owner-only release action.
    expect(workflow).toContain('Guard: pushing a "v*" tag');
    expect(workflow).toContain("not authorized for FP-008");

    // Trigger block: workflow_dispatch only; no push and no tag trigger may
    // return (the T1a machine check).
    const lines = workflow.split(/\r?\n/);
    const triggerStart = lines.findIndex((line) => /^on:\s*$/.test(line));
    expect(
      triggerStart,
      "release.yml must keep an explicit on: block",
    ).toBeGreaterThanOrEqual(0);
    const triggerLines: string[] = [];
    for (let index = triggerStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      triggerLines.push(line);
    }
    const triggerBlock = triggerLines.join("\n");
    expect(triggerBlock).toContain("workflow_dispatch:");
    expect(triggerBlock).not.toMatch(/\bpush:/);
    expect(triggerBlock).not.toContain("tags:");
    // Q4(b) retains the manual inputs (input defaults are deliberately not
    // pinned here; the ruling froze them for this edit, not forever).
    for (const input of [
      "release_tag:",
      "create_draft_release:",
      "push_ghcr:",
    ]) {
      expect(
        triggerBlock,
        `release.yml must keep the ${input} input`,
      ).toContain(input);
    }
  });

  it("records the MCPB platform claims as-is and keeps the managed-runtime scope distinct (Q7, G8)", () => {
    const manifest = JSON.parse(readRepositoryFile("mcpb/manifest.json")) as {
      compatibility: { platforms: string[] };
    };
    // Q7 rules that the manifest is left unchanged; the claims are recorded
    // here so a silent widening or narrowing fails the suite.
    expect(manifest.compatibility.platforms).toEqual([
      "darwin",
      "win32",
      "linux",
    ]);
    // The docs that scope the *managed runtime* to Windows must stay explicit,
    // so the MCPB claims and the runtime scope cannot merge into one promise.
    expect(readRepositoryFile("docs/local-runtime.md")).toContain(
      "The managed lifecycle is Windows-first",
    );
    expect(readRepositoryFile("docs/control-plane.md")).toContain(
      "The lifecycle is Windows-first",
    );
    expect(readRepositoryFile("docs/security-model.md")).toContain(
      "on a non-Windows host",
    );
  });

  // Promoted FINDING (Q7, G8): the scope sentence landed in the T1 release
  // notes (docs/release-notes/v0.2.0.md), so the former self-clearing FINDING
  // is now a hard check. The MCPB manifest keeps its recorded
  // darwin/win32/linux claims for the MCP server itself, while the managed
  // local runtime is Windows-first.
  it("requires the MCPB-vs-managed-runtime scope sentence in the 0.2.0 release notes (Q7, G8)", () => {
    const notes = readRepositoryFile("docs/release-notes/v0.2.0.md").replace(
      /\s+/g,
      " ",
    );
    const scopeSentence = notes
      .split(/(?<=\.)\s+/)
      .find((sentence) => /mcpb/i.test(sentence) && /windows/i.test(sentence));
    expect(
      scopeSentence,
      "docs/release-notes/v0.2.0.md must scope the MCPB platforms against the Windows-first managed runtime",
    ).toBeDefined();
    // The refusal code and the claimed platforms are part of the scope
    // statement, so the sentence cannot be reduced to a vague promise.
    expect(notes).toContain("unsupported_platform");
    for (const platform of ["darwin", "win32", "linux"]) {
      expect(notes).toContain(platform);
    }

    // Q7 rules that the manifest is left unchanged; the claims are re-asserted
    // here so any silent widening or narrowing fails the suite.
    const manifest = JSON.parse(readRepositoryFile("mcpb/manifest.json")) as {
      compatibility: { platforms: string[] };
    };
    expect(manifest.compatibility.platforms).toEqual([
      "darwin",
      "win32",
      "linux",
    ]);
  });
});
