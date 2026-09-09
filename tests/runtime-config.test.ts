import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
  "ULTRASEARCH_CONFIG",
  "ULTRASEARCH_TINYFISH_API_KEY",
  "TINYFISH_API_KEY",
  "ULTRASEARCH_PROVIDER_ORDER",
  "ULTRASEARCH_EXA_API_KEY",
  "ULTRASEARCH_FIRECRAWL_API_KEY",
  "TINYFISH_SECRET_FROM_ENV",
];
const userConfigPlaceholder = (name: string) =>
  ["$", "{", `user_config.${name}`, "}"].join("");
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ultrasearch-config-"));
  for (const key of ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime config", () => {
  it("uses canonical env vars before legacy env vars", async () => {
    process.env.ULTRASEARCH_TINYFISH_API_KEY = "canonical";
    process.env.TINYFISH_API_KEY = "legacy";
    const { providerApiKey, resetRuntimeConfigForTests } = await import(
      "../src/runtime-config.js"
    );
    resetRuntimeConfigForTests();
    expect(
      providerApiKey("tinyfish", [
        "ULTRASEARCH_TINYFISH_API_KEY",
        "TINYFISH_API_KEY",
      ]),
    ).toBe("canonical");
  });

  it("reads provider keys from config files with env interpolation", async () => {
    const configPath = join(dir, "config.json");
    process.env.ULTRASEARCH_CONFIG = configPath;
    process.env.TINYFISH_SECRET_FROM_ENV = "from-env";
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          tinyfish: {
            apiKey: ["$", "{", "TINYFISH_SECRET_FROM_ENV", "}"].join(""),
          },
        },
      }),
    );
    const { providerApiKey, resetRuntimeConfigForTests } = await import(
      "../src/runtime-config.js"
    );
    resetRuntimeConfigForTests();
    expect(providerApiKey("tinyfish", ["ULTRASEARCH_TINYFISH_API_KEY"])).toBe(
      "from-env",
    );
  });

  it("reads provider order arrays from config", async () => {
    const configPath = join(dir, "config.json");
    process.env.ULTRASEARCH_CONFIG = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ search: { providerOrder: ["exa", "tinyfish"] } }),
    );
    const { configStringList, resetRuntimeConfigForTests } = await import(
      "../src/runtime-config.js"
    );
    resetRuntimeConfigForTests();
    expect(
      configStringList(
        ["ULTRASEARCH_PROVIDER_ORDER"],
        "search.providerOrder",
        [],
      ),
    ).toEqual(["exa", "tinyfish"]);
  });

  it("ignores unresolved MCPB user_config placeholders", async () => {
    process.env.ULTRASEARCH_EXA_API_KEY = userConfigPlaceholder("exa_api_key");
    const { providerApiKey, resetRuntimeConfigForTests } = await import(
      "../src/runtime-config.js"
    );
    resetRuntimeConfigForTests();
    expect(providerApiKey("exa", ["ULTRASEARCH_EXA_API_KEY"])).toBeUndefined();
  });

  it("falls back to config when canonical env is an unresolved MCPB placeholder", async () => {
    const configPath = join(dir, "config.json");
    process.env.ULTRASEARCH_CONFIG = configPath;
    process.env.ULTRASEARCH_FIRECRAWL_API_KEY =
      userConfigPlaceholder("firecrawl_api_key");
    writeFileSync(
      configPath,
      JSON.stringify({ providers: { firecrawl: { apiKey: "from-config" } } }),
    );
    const { providerApiKey, resetRuntimeConfigForTests } = await import(
      "../src/runtime-config.js"
    );
    resetRuntimeConfigForTests();
    expect(providerApiKey("firecrawl", ["ULTRASEARCH_FIRECRAWL_API_KEY"])).toBe(
      "from-config",
    );
  });
});
