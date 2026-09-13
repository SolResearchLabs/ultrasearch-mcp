import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { printConfigTemplate, printDoctor } from "../../src/cli/configure.js";
import { CONFIG_PROFILES } from "../../src/config/profiles.js";
import {
  DEFAULT_CONFIG,
  LOCAL_SEARCH_ENDPOINT,
  ROUTING_MODES,
  resolveEffectiveConfig,
} from "../../src/config/schema.js";
import { resetRuntimeConfigForTests } from "../../src/runtime-config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepositoryFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function captureStdout(run: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

describe("FULL-PACKAGE-001 configuration defaults", () => {
  it("keeps the local endpoint aligned across owned input surfaces", () => {
    const envExample = readRepositoryFile("examples/env.example");
    const claudeDesktop = JSON.parse(
      readRepositoryFile("examples/claude-desktop.json"),
    ) as {
      mcpServers: {
        ultrasearch: { env: { ULTRASEARCH_SEARXNG_URL: string } };
      };
    };
    const codexToml = readRepositoryFile("examples/codex.toml");
    const runtimeConfig = readRepositoryFile("src/config.ts");
    const readme = readRepositoryFile("README.md");
    const architecture = readRepositoryFile("docs/architecture.md");
    const localRuntime = readRepositoryFile("docs/local-runtime.md");
    const releasePolicy = readRepositoryFile("docs/release-policy.md");
    const manifest = JSON.parse(readRepositoryFile("mcpb/manifest.json")) as {
      user_config: { searxng_url: { default: string } };
    };

    expect(LOCAL_SEARCH_ENDPOINT).toBe("http://127.0.0.1:8099");
    expect(DEFAULT_CONFIG.localSearch.endpoint).toBe(LOCAL_SEARCH_ENDPOINT);
    expect(envExample).toContain(
      `ULTRASEARCH_SEARXNG_URL=${LOCAL_SEARCH_ENDPOINT}`,
    );
    expect(
      claudeDesktop.mcpServers.ultrasearch.env.ULTRASEARCH_SEARXNG_URL,
    ).toBe(LOCAL_SEARCH_ENDPOINT);
    expect(codexToml).toContain(
      `ULTRASEARCH_SEARXNG_URL = "${LOCAL_SEARCH_ENDPOINT}"`,
    );
    expect(runtimeConfig).toContain("getControlPlaneConfig");
    expect(runtimeConfig).toContain(
      "CONTROL_PLANE_CONFIG.values.localSearch.endpoint",
    );
    expect(manifest.user_config.searxng_url.default).toBe(
      LOCAL_SEARCH_ENDPOINT,
    );
    expect(readme).toContain(`\`${LOCAL_SEARCH_ENDPOINT}\``);
    expect(architecture).toContain(`\`${LOCAL_SEARCH_ENDPOINT}\``);
    expect(localRuntime).toContain(LOCAL_SEARCH_ENDPOINT);
    expect(releasePolicy).toContain(`\`${LOCAL_SEARCH_ENDPOINT}\``);
  });

  it("keeps Firecrawl as an optional explicit remote escalation", () => {
    const envExample = readRepositoryFile("examples/env.example");
    const runtimeConfig = readRepositoryFile("src/config.ts");
    const manifest = JSON.parse(readRepositoryFile("mcpb/manifest.json")) as {
      user_config: {
        firecrawl_url: { default: string; description: string };
        firecrawl_api_key: { description: string };
      };
    };

    expect(envExample).toContain(
      "# Optional BYOK remote fetch/crawl escalation; no local sidecar is enabled.",
    );
    expect(envExample).toContain("ULTRASEARCH_FIRECRAWL_URL=");
    expect(runtimeConfig).toContain(
      "CONTROL_PLANE_CONFIG.values.remoteFetch.firecrawl.url",
    );
    expect(runtimeConfig).toContain(
      "CONTROL_PLANE_CONFIG.values.remoteFetch.firecrawl.apiKey",
    );
    expect(manifest.user_config.firecrawl_url.default).toBe("");
    expect(manifest.user_config.firecrawl_url.description).toContain(
      "BYOK remote Firecrawl API URL",
    );
    expect(manifest.user_config.firecrawl_api_key.description).toContain(
      "explicitly configured remote Firecrawl",
    );
    expect(DEFAULT_CONFIG.remoteFetch.firecrawl.enabled).toBe(false);
    expect(DEFAULT_CONFIG.remoteFetch.firecrawl.url).toBe("");
    expect(resolveEffectiveConfig().values.remoteFetch.firecrawl.url).toBe("");
    expect(envExample).not.toContain(
      "ULTRASEARCH_FIRECRAWL_URL=https://api.firecrawl.dev",
    );
  });

  it("keeps the CLI generated default surfaces on the canonical endpoint", () => {
    const previousCanonical = process.env.ULTRASEARCH_SEARXNG_URL;
    const previousLegacy = process.env.SEARXNG_URL;
    const previousConfigPath = process.env.ULTRASEARCH_CONFIG;
    try {
      delete process.env.ULTRASEARCH_SEARXNG_URL;
      delete process.env.SEARXNG_URL;
      process.env.ULTRASEARCH_CONFIG = join(
        repoRoot,
        "tests",
        "config",
        "__missing-config__.json",
      );
      resetRuntimeConfigForTests();

      const template = JSON.parse(
        captureStdout(() => printConfigTemplate()),
      ) as {
        runtime: { mode: string };
        search: { searxngUrl: string };
      };
      expect(template.search.searxngUrl).toBe(LOCAL_SEARCH_ENDPOINT);
      expect(template.runtime).toEqual({ mode: "external_endpoint" });

      const doctor = captureStdout(() => printDoctor());
      expect(doctor).toContain(`searxng_url=${LOCAL_SEARCH_ENDPOINT}`);
    } finally {
      for (const [name, value] of [
        ["ULTRASEARCH_SEARXNG_URL", previousCanonical],
        ["SEARXNG_URL", previousLegacy],
        ["ULTRASEARCH_CONFIG", previousConfigPath],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetRuntimeConfigForTests();
    }
  });

  it("keeps the runtime projection defaults aligned with its documentation", () => {
    const resolved = resolveEffectiveConfig();
    const configuration = readRepositoryFile("docs/configuration.md");
    const controlPlane = readRepositoryFile("docs/control-plane.md");
    const localRuntime = readRepositoryFile("docs/local-runtime.md");
    const readme = readRepositoryFile("README.md");

    expect(DEFAULT_CONFIG.runtime.mode).toBe("external_endpoint");
    expect(resolved.values.runtime.mode).toBe("external_endpoint");
    expect(resolved.sources.runtimeMode).toBe("default");
    expect(configuration).toContain("`runtime.mode`");
    expect(configuration).toContain("`ULTRASEARCH_RUNTIME_MODE`");
    expect(controlPlane).toContain("`/healthz`");
    expect(controlPlane).toContain("no resident watcher");
    expect(controlPlane).toContain("no auto-restart");
    expect(controlPlane).toContain("no OS service registration");
    expect(localRuntime).toContain("`operator_compose`");
    expect(readme).toContain("`runtime.mode`");
  });

  it("does not ship a retired local search endpoint on a code or example surface", () => {
    const surfaces = [
      "src/config.ts",
      "src/cli/configure.ts",
      "examples/env.example",
      "examples/claude-desktop.json",
      "examples/codex.toml",
      "mcpb/manifest.json",
    ];
    for (const surface of surfaces) {
      expect(readRepositoryFile(surface)).not.toContain("localhost:8081");
    }
  });

  it("exposes only the approved routing modes and defaults to local_first", () => {
    const manifest = JSON.parse(readRepositoryFile("mcpb/manifest.json")) as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, unknown>;
    };

    expect(ROUTING_MODES).toEqual([
      "local_only",
      "local_first",
      "hybrid",
      "hosted_only",
      "offline_fetch_only",
    ]);
    expect(DEFAULT_CONFIG.routing.mode).toBe("local_first");
    expect(manifest.user_config).not.toHaveProperty("routing_mode");
    expect(manifest.server.mcp_config.env).not.toHaveProperty(
      "ULTRASEARCH_ROUTING_MODE",
    );
    expect(readRepositoryFile("examples/env.example")).not.toContain(
      "ULTRASEARCH_ROUTING_MODE=",
    );
  });

  it("applies the locked configuration precedence and reports each source", () => {
    const resolved = resolveEffectiveConfig({
      operation: { routing: { mode: "offline_fetch_only" } },
      environment: { routing: { mode: "hosted_only" } },
      userConfig: { routing: { mode: "hybrid" } },
      profile: "local",
    });

    expect(resolved.values.routing.mode).toBe("offline_fetch_only");
    expect(resolved.sources.routingMode).toBe("operation");
    expect(
      resolveEffectiveConfig({ profile: "hybrid" }).values.routing.mode,
    ).toBe(CONFIG_PROFILES.hybrid.routingMode);
  });
});
