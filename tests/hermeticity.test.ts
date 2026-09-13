import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  printConfigTemplate,
  renderControlPlaneStatus,
} from "../src/cli/configure.js";
import { renderManagedRuntimeRefusal } from "../src/cli/runtime.js";
import { HOSTED_SEARCH_PROVIDER_IDS } from "../src/config/schema.js";
import { resolveControlPlaneConfig } from "../src/control-plane/config.js";
import { resolveRoutingPolicy } from "../src/control-plane/policy.js";
import { redactConfigForDiagnostics } from "../src/control-plane/redaction.js";
import { ManagedRuntimeRefusalError } from "../src/control-plane/runtime-lifecycle.js";
import type { ControlPlaneStatus } from "../src/control-plane/status.js";
import { resetRuntimeConfigForTests } from "../src/runtime-config.js";
import { braveSearchProvider } from "../src/search-providers/brave.js";
import { exaSearchProvider } from "../src/search-providers/exa.js";
import {
  configuredHostedSearchProviders,
  hostedSearchFallbackEnabled,
  searchHostedFallbackWithAttempts,
} from "../src/search-providers/index.js";
import { parallelSearchProvider } from "../src/search-providers/parallel.js";
import { tinyfishSearchProvider } from "../src/search-providers/tinyfish.js";

// H8 hermeticity controls: canary every recognized credential variable, prove
// the harness suites' oracle computations are identical with the canaries set
// and cleared, enforce the Q6 invariant (every provider-mocking harness suite
// mocks every registry provider), and assert a canary value never reaches any
// output or artifact. Zero network: fetch is replaced by a throwing tripwire
// for the whole file.

const CREDENTIAL_CANARY_VARS = [
  "TINYFISH_API_KEY",
  "ULTRASEARCH_TINYFISH_API_KEY",
  "EXA_API_KEY",
  "ULTRASEARCH_EXA_API_KEY",
  "PARALLEL_API_KEY",
  "ULTRASEARCH_PARALLEL_API_KEY",
  "BRAVE_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "ULTRASEARCH_BRAVE_API_KEY",
  "FIRECRAWL_API_KEY",
  "ULTRASEARCH_FIRECRAWL_API_KEY",
  "OLLAMA_API_KEY",
  "LLM_API_KEY",
] as const;

// Obviously fake; never a real credential shape.
const CANARY = "fp007-canary-not-a-real-credential";

// Built by concatenation so a placeholder stays a plain string.
function envRef(name: string): string {
  return ["$", "{", name, "}"].join("");
}

const PROVIDER_ENV_NAMES: Record<string, string[]> = {
  tinyfish: ["ULTRASEARCH_TINYFISH_API_KEY", "TINYFISH_API_KEY"],
  exa: ["ULTRASEARCH_EXA_API_KEY", "EXA_API_KEY"],
  parallel: ["ULTRASEARCH_PARALLEL_API_KEY", "PARALLEL_API_KEY"],
  brave: ["ULTRASEARCH_BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
};

const registryProviders = {
  exa: exaSearchProvider,
  parallel: parallelSearchProvider,
  tinyfish: tinyfishSearchProvider,
  brave: braveSearchProvider,
};

const ENV_ISOLATED = [
  ...CREDENTIAL_CANARY_VARS,
  "ULTRASEARCH_CONFIG",
  "ULTRASEARCH_HOSTED_FALLBACK_ENABLED",
  "HOSTED_SEARCH_FALLBACK_ENABLED",
  "ULTRASEARCH_PROVIDER_ORDER",
  "HOSTED_SEARCH_PROVIDER_ORDER",
  "ULTRASEARCH_SEARXNG_URL",
  "SEARXNG_URL",
  "ULTRASEARCH_ROUTING_MODE",
  "ROUTING_MODE",
  "ULTRASEARCH_FIRECRAWL_URL",
  "FIRECRAWL_URL",
];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MISSING_CONFIG_PATH = join(
  repoRoot,
  "tests",
  "__missing-hermeticity-config__.json",
);

// Harness classes under the Q6 invariant. Worker B owns the four control-plane
// files; they are inspected when present, never edited.
const HARNESS_FILES = [
  "tests/route-matrix.test.ts",
  "tests/cli/cli-surface-matrix.test.ts",
  "tests/config/precedence-matrix.test.ts",
  "tests/control-plane/lifecycle-matrix.test.ts",
  "tests/control-plane/platform-matrix.test.ts",
  "tests/control-plane/survivor-cleanup-matrix.test.ts",
  "tests/control-plane/provisioning-identity-matrix.test.ts",
];

// Files this worker owns: the hermeticity static scans cover these, since the
// control-plane classes legitimately use the recorded local-git fixture
// pattern (tests/control-plane/runtime-lifecycle.test.ts:92-112).
const OWNED_SUITE_FILES = [
  "tests/route-matrix.test.ts",
  "tests/cli/cli-surface-matrix.test.ts",
  "tests/config/precedence-matrix.test.ts",
];

const originalEnv = new Map<string, string | undefined>();
const fetchSpy = vi.fn(() => {
  throw new Error("hermeticity suite forbids network fetches");
});

function setCanaries(): void {
  for (const name of CREDENTIAL_CANARY_VARS) process.env[name] = CANARY;
}

function clearCanaries(): void {
  for (const name of CREDENTIAL_CANARY_VARS) delete process.env[name];
}

function statusFixture(): ControlPlaneStatus {
  // Deterministic by construction: explicit empty environment and empty user
  // config, so no ambient state can influence the rendered oracle.
  const resolved = resolveControlPlaneConfig({
    environment: {},
    userConfig: {},
  });
  return {
    schemaVersion: 1,
    configuration: {
      values: redactConfigForDiagnostics(resolved.values),
      sources: resolved.sources,
      profile: resolved.profile,
    },
    routing: resolveRoutingPolicy(resolved),
    localSearch: {
      state: "reachable",
      endpoint: "http://127.0.0.1:8099",
      statusCode: 200,
    },
    runtime: {
      mode: "external_endpoint",
      ownership: "external",
      observation: "reachable",
      lifecycle: "unavailable",
      observedAt: "2026-09-12T00:00:00.000Z",
      endpoint: "http://127.0.0.1:8099",
      diagnostic: null,
    },
    managedRuntime: null,
    cache: { state: "reachable" },
    providers: {
      configuredHostedSearch: [],
      control: { searxng: { active: 0 } },
      hostedSearchControl: { exa: { active: 0 } },
      hostedSearchBudget: { exa: { allowed: true, state: "disabled" } },
      remoteFetch: {
        firecrawl: {
          classification: "explicit_remote_fetch_crawl_escalation",
          enabled: false,
          configured: false,
          apiKeyConfigured: false,
        },
      },
    },
  };
}

// The in-process oracle set: one representative computation per harness class
// this worker owns (H1 routing policy, H6 renderings, H7 resolution). The full
// cross-posture suite determinism is the lab gate run (packet section 8.4).
function harnessOracleSet(): unknown {
  const resolved = resolveControlPlaneConfig({
    environment: {},
    userConfig: {},
  });
  return {
    routing: resolveRoutingPolicy(resolved),
    endpoint: resolved.values.localSearch.endpoint,
    sources: resolved.sources,
    statusHuman: renderControlPlaneStatus(statusFixture(), "status", "human"),
    statusJson: renderControlPlaneStatus(statusFixture(), "status", "json"),
    refusalHuman: renderManagedRuntimeRefusal(
      "start",
      new ManagedRuntimeRefusalError("state_conflict", "held by provision"),
      "human",
    ),
    refusalJson: renderManagedRuntimeRefusal(
      "cleanup",
      new ManagedRuntimeRefusalError("cleanup_refused", "active child"),
      "json",
    ),
  };
}

// Every console emission during a test is captured; the afterEach asserts no
// canary value can appear in it (output-leak guard for the whole file).
const consoleLines: string[] = [];
let restoreConsole: () => void = () => {};

beforeEach(() => {
  originalEnv.clear();
  for (const key of ENV_ISOLATED) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ULTRASEARCH_CONFIG = MISSING_CONFIG_PATH;
  resetRuntimeConfigForTests();
  consoleLines.length = 0;
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  restoreConsole = () => {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  };
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  const emitted = consoleLines.join("\n");
  restoreConsole();

  // Canary capture/restore is exact and leaves no ambient trace.
  for (const key of ENV_ISOLATED) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    expect(process.env[key]).toBe(value);
  }
  originalEnv.clear();
  resetRuntimeConfigForTests();
  vi.unstubAllGlobals();

  expect(emitted).not.toContain(CANARY);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockClear();
});

describe("H8 credential canary inventory", () => {
  it("canaries exactly the thirteen recognized credential variable names", () => {
    expect(CREDENTIAL_CANARY_VARS).toHaveLength(13);
    expect(new Set(CREDENTIAL_CANARY_VARS).size).toBe(13);
    expect([...CREDENTIAL_CANARY_VARS].sort()).toEqual([
      "BRAVE_API_KEY",
      "BRAVE_SEARCH_API_KEY",
      "EXA_API_KEY",
      "FIRECRAWL_API_KEY",
      "LLM_API_KEY",
      "OLLAMA_API_KEY",
      "PARALLEL_API_KEY",
      "TINYFISH_API_KEY",
      "ULTRASEARCH_BRAVE_API_KEY",
      "ULTRASEARCH_EXA_API_KEY",
      "ULTRASEARCH_FIRECRAWL_API_KEY",
      "ULTRASEARCH_PARALLEL_API_KEY",
      "ULTRASEARCH_TINYFISH_API_KEY",
    ]);
  });

  it("covers every environment name the four registry providers read", () => {
    const canaryNames = new Set<string>(CREDENTIAL_CANARY_VARS);
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      expect(PROVIDER_ENV_NAMES[id]).toBeDefined();
      for (const name of PROVIDER_ENV_NAMES[id]) {
        expect(canaryNames.has(name)).toBe(true);
      }
    }
  });
});

describe("H8 provider configuration is canary-driven without ambient leakage", () => {
  it("no registry provider is configured with canaries cleared and no config file", () => {
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      expect(registryProviders[id].configured()).toBe(false);
    }
    expect(configuredHostedSearchProviders()).toEqual([]);
    expect(hostedSearchFallbackEnabled()).toBe(false);
  });

  for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
    it(`only ${id} becomes configured when only its canary names are set`, () => {
      for (const name of PROVIDER_ENV_NAMES[id]) {
        process.env[name] = `${CANARY}-${id}`;
      }
      for (const other of HOSTED_SEARCH_PROVIDER_IDS) {
        expect(registryProviders[other].configured()).toBe(other === id);
      }
      expect(configuredHostedSearchProviders()).toEqual([id]);
      expect(hostedSearchFallbackEnabled()).toBe(true);
    });
  }

  it("with all thirteen canaries set the real registry is ambient-sensitive (the FP-006 hazard)", () => {
    setCanaries();
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      expect(registryProviders[id].configured()).toBe(true);
    }
    expect(hostedSearchFallbackEnabled()).toBe(true);
    expect(configuredHostedSearchProviders()).toEqual([
      "tinyfish",
      "exa",
      "parallel",
      "brave",
    ]);
  });

  it("a cleared posture short-circuits the real registry before any provider call", async () => {
    const outcome = await searchHostedFallbackWithAttempts({
      query: "hermeticity query",
      numResults: 5,
      category: "general",
    });
    expect(outcome).toEqual({ result: null, attempts: [], enabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("H8 cross-posture determinism of the harness oracle set", () => {
  it("produces identical routing, status, and refusal oracles with canaries cleared and set", () => {
    clearCanaries();
    const cleared = harnessOracleSet();

    setCanaries();
    const canaried = harnessOracleSet();

    expect(canaried).toEqual(cleared);
    // The ambient sensitivity exists (above), yet the oracle set the harness
    // suites consume is unchanged, which is the property the mocks protect.
  });
});

describe("H8 canary values never surface in output or artifacts", () => {
  it("redacts a canary-valued secret and keeps it out of every rendered surface", () => {
    setCanaries();
    const resolved = resolveControlPlaneConfig({
      environment: {
        ULTRASEARCH_FIRECRAWL_API_KEY: CANARY,
      },
      userConfig: {},
    });
    // The raw resolution legitimately carries the configured secret value.
    expect(resolved.values.remoteFetch.firecrawl.apiKey).toBe(CANARY);

    const redacted = redactConfigForDiagnostics(resolved.values);
    expect(JSON.stringify(redacted)).not.toContain(CANARY);

    const status: ControlPlaneStatus = {
      ...statusFixture(),
      configuration: {
        values: redacted,
        sources: resolved.sources,
        profile: resolved.profile,
      },
      providers: {
        ...statusFixture().providers,
        remoteFetch: {
          firecrawl: {
            classification: "explicit_remote_fetch_crawl_escalation",
            enabled: true,
            configured: true,
            apiKeyConfigured: true,
          },
        },
      },
    };
    const human = renderControlPlaneStatus(status, "doctor", "human");
    const json = renderControlPlaneStatus(status, "status", "json");
    expect(human).not.toContain(CANARY);
    expect(json).not.toContain(CANARY);

    printConfigTemplate();
    const emitted = consoleLines.join("\n");
    expect(emitted).not.toContain(CANARY);
    // The template prints placeholder names, never values.
    expect(emitted).toContain("ULTRASEARCH_TINYFISH_API_KEY");
  });

  it("keeps an expanded canary secret out of diagnostics as well", () => {
    setCanaries();
    const resolved = resolveControlPlaneConfig({
      environment: {},
      userConfig: {
        remoteFetch: {
          firecrawl: { apiKey: envRef("ULTRASEARCH_FIRECRAWL_API_KEY") },
        },
      },
    });
    // Expansion happens through the process environment (by design), so the
    // raw value is present; diagnostics must not carry it onward.
    expect(resolved.values.remoteFetch.firecrawl.apiKey).toBe(CANARY);
    expect(resolved.sources.firecrawlApiKey).toBe("user_config");
    const serialized = JSON.stringify({
      values: redactConfigForDiagnostics(resolved.values),
      sources: resolved.sources,
      profile: resolved.profile,
    });
    expect(serialized).not.toContain(CANARY);
  });
});

describe("H8 harness-suite static invariants (Q6 and the fake-only envelope)", () => {
  it("every harness suite that mocks a registry provider mocks every registry provider", () => {
    const inspected: string[] = [];
    for (const relative of HARNESS_FILES) {
      const absolute = join(repoRoot, relative);
      if (!existsSync(absolute)) continue;
      inspected.push(relative);
      const source = readFileSync(absolute, "utf8");
      const mocked = HOSTED_SEARCH_PROVIDER_IDS.filter((id) =>
        source.includes(`search-providers/${id}.js`),
      );
      if (mocked.length === 0) continue;
      expect({ file: relative, mocked }).toEqual({
        file: relative,
        mocked: [...HOSTED_SEARCH_PROVIDER_IDS],
      });
    }
    expect(inspected).toContain("tests/route-matrix.test.ts");
    expect(inspected.length).toBeGreaterThanOrEqual(4);
  });

  it("the provider-mocking H1 class also installs a rejecting fetch tripwire", () => {
    const source = readFileSync(
      join(repoRoot, "tests/route-matrix.test.ts"),
      "utf8",
    );
    expect(source).toContain('stubGlobal("fetch"');
    for (const id of HOSTED_SEARCH_PROVIDER_IDS) {
      expect(source).toContain(`search-providers/${id}.js`);
    }
  });

  it("this worker's suites contain no network, process, port, or package-manager access", () => {
    const forbidden = [
      "node:http",
      "node:https",
      "node:net",
      "node:dns",
      "child_process",
      "undici",
      "spawn(",
      "spawnSync(",
      "git apply",
      "pnpm",
      "npx",
      ".listen(",
    ];
    for (const relative of OWNED_SUITE_FILES) {
      const source = readFileSync(join(repoRoot, relative), "utf8");
      for (const token of forbidden) {
        expect({
          file: relative,
          token,
          hit: source.includes(token),
        }).toEqual({ file: relative, token, hit: false });
      }
    }
  });
});
