import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// FULL-PACKAGE-008 track T5 (FP-008 planning packet section 7.3 row 13;
// DQ-041 R3). Release-metadata identity guard: one version/name identity across
// package.json, server.json, mcpb/manifest.json, and the CHANGELOG top section;
// every credential-bearing metadata field marked secret; and the runtime
// version mechanism in src/version.ts that keeps the server banner, the OTel
// resources, and the outbound user agent aligned with package.json.
//
// Extends the defaults-consistency pattern without modifying
// tests/config/defaults-consistency.test.ts. Static repository reads only: no
// network, no spawns, no package-manager commands. The executable release-time
// equivalent is scripts/validate-release-metadata.mjs; this suite is the
// in-tree guard that runs with the normal test suite.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepositoryFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

interface PackageMetadata {
  name: string;
  version: string;
  mcpName: string;
}

interface ServerMetadata {
  name: string;
  version: string;
  packages: {
    registryType: string;
    identifier: string;
    version: string;
    environmentVariables?: { name: string; isSecret?: boolean }[];
  }[];
}

interface McpbManifest {
  name: string;
  version: string;
  user_config: Record<string, { sensitive?: boolean; default?: unknown }>;
}

describe("FULL-PACKAGE-008 release metadata identity", () => {
  it("pins one version identity across package.json, server.json, the MCPB manifest, and the CHANGELOG", () => {
    const pkg = JSON.parse(
      readRepositoryFile("package.json"),
    ) as PackageMetadata;
    const server = JSON.parse(
      readRepositoryFile("server.json"),
    ) as ServerMetadata;
    const manifest = JSON.parse(
      readRepositoryFile("mcpb/manifest.json"),
    ) as McpbManifest;
    const changelog = readRepositoryFile("CHANGELOG.md");

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe("0.0.0");

    // Name chain: the registry server name is the package `mcpName`, and the
    // registry npm entry identifier is the package name - the same two
    // assertions scripts/validate-release-metadata.mjs:31-41 executes at
    // release time, so a rename cannot land half-applied.
    expect(server.name).toBe(pkg.mcpName);
    const npmPackage = server.packages.find(
      (entry) => entry.registryType === "npm",
    );
    expect(npmPackage).toBeDefined();
    expect(npmPackage?.identifier).toBe(pkg.name);
    expect(npmPackage?.version).toBe(pkg.version);

    // Version chain (packet gap G1): the registry metadata, the MCPB manifest,
    // and the first released CHANGELOG section must all carry the package
    // version before a version decision is applied anywhere.
    expect(server.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.name).toBe(pkg.name.split("/")[1]);
    const topSection = /^##\s+(\d+\.\d+\.\d+)\s*$/m.exec(changelog);
    expect(topSection).not.toBeNull();
    expect(topSection?.[1]).toBe(pkg.version);
  });

  it("marks every *_API_KEY environment variable in server.json as a secret", () => {
    const server = JSON.parse(
      readRepositoryFile("server.json"),
    ) as ServerMetadata;
    const environmentVariables = server.packages.flatMap(
      (entry) => entry.environmentVariables ?? [],
    );
    const apiKeyEntries = environmentVariables.filter((entry) =>
      entry.name.endsWith("_API_KEY"),
    );

    // Non-vacuous guard: server.json carries five API-key entries today (four
    // hosted providers plus Firecrawl); a renamed or added entry must not slip
    // past secret marking unnoticed.
    expect(apiKeyEntries.map((entry) => entry.name).sort()).toEqual([
      "ULTRASEARCH_BRAVE_API_KEY",
      "ULTRASEARCH_EXA_API_KEY",
      "ULTRASEARCH_FIRECRAWL_API_KEY",
      "ULTRASEARCH_PARALLEL_API_KEY",
      "ULTRASEARCH_TINYFISH_API_KEY",
    ]);
    for (const entry of apiKeyEntries) {
      expect(entry.isSecret, `${entry.name} must set isSecret: true`).toBe(
        true,
      );
    }
  });

  it("marks every credential user_config field in the MCPB manifest as sensitive", () => {
    const manifest = JSON.parse(
      readRepositoryFile("mcpb/manifest.json"),
    ) as McpbManifest;
    const credentialKeys = Object.keys(manifest.user_config).filter((key) =>
      key.endsWith("_api_key"),
    );

    expect(credentialKeys.sort()).toEqual([
      "brave_api_key",
      "exa_api_key",
      "firecrawl_api_key",
      "parallel_api_key",
      "tinyfish_api_key",
    ]);
    for (const key of credentialKeys) {
      const field = manifest.user_config[key];
      expect(field?.sensitive, `${key} must set sensitive: true`).toBe(true);
      // The MCPB ships no credential material: every key field defaults empty
      // (docs/release-policy.md:26-31 artifact policy).
      expect(field?.default, `${key} must default to an empty value`).toBe("");
    }
  });

  it("reads the runtime version from the nearest package.json and cannot reach the 0.0.0 fallback", () => {
    const source = readRepositoryFile("src/version.ts");

    // Mechanism assertions (static): the resolver walks up to a package.json,
    // reads it with readFileSync, accepts only the reviewed package name with
    // a string version, and keeps "0.0.0" as a terminal fallback that a
    // version bump must never expose at runtime.
    expect(source).toContain('join(dir, "package.json")');
    expect(source).toContain('pkg.name === "@solresearchlabs/ultrasearch-mcp"');
    expect(source).toContain('typeof pkg.version === "string"');
    expect(source).toContain('return "0.0.0"');

    // Static reachability proof instead of importing VERSION (value equality
    // is tests/version.test.ts and is deliberately not duplicated): walking up
    // from the module directory src/, the first package.json found is the
    // repository root package.json, which carries the guarded name and a real
    // version, so resolveVersion() returns before the fallback line.
    const found: string[] = [];
    let dir = join(repoRoot, "src");
    for (let index = 0; index < 6; index += 1) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        found.push(candidate);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    expect(found).toEqual([join(repoRoot, "package.json")]);
    const runtimePackage = JSON.parse(
      readFileSync(found[0], "utf8"),
    ) as PackageMetadata;
    expect(runtimePackage.name).toBe("@solresearchlabs/ultrasearch-mcp");
    expect(typeof runtimePackage.version).toBe("string");
    expect(runtimePackage.version).not.toBe("0.0.0");
  });
});
