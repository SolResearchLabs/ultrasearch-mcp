import {
  configBoolean,
  configString,
  configStringList,
  providerApiKey,
  redactSecret,
  ultrasearchConfigPath,
} from "../runtime-config.js";

const PROVIDERS = ["tinyfish", "exa", "parallel", "brave"] as const;
type ProviderId = (typeof PROVIDERS)[number];
const PROVIDER_ENV: Record<ProviderId, string[]> = {
  tinyfish: ["ULTRASEARCH_TINYFISH_API_KEY", "TINYFISH_API_KEY"],
  exa: ["ULTRASEARCH_EXA_API_KEY", "EXA_API_KEY"],
  parallel: ["ULTRASEARCH_PARALLEL_API_KEY", "PARALLEL_API_KEY"],
  brave: ["ULTRASEARCH_BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"],
};

export function printHelp(): void {
  console.log(`UltraSearch MCP

Usage:
  ultrasearch-mcp                 Start the MCP server
  ultrasearch-mcp doctor          Print redacted local configuration status
  ultrasearch-mcp init-config     Print a starter JSON config
  ultrasearch-mcp help            Show this help

Default config file: ${ultrasearchConfigPath()}`);
}
export function printDoctor(): void {
  const order = configStringList(
    ["ULTRASEARCH_PROVIDER_ORDER", "HOSTED_SEARCH_PROVIDER_ORDER"],
    "search.providerOrder",
    ["tinyfish", "exa", "parallel", "brave"],
  );
  const fallbackEnabled = configBoolean(
    ["ULTRASEARCH_HOSTED_FALLBACK_ENABLED", "HOSTED_SEARCH_FALLBACK_ENABLED"],
    "search.hostedFallbackEnabled",
    false,
  );
  console.log("UltraSearch MCP doctor");
  console.log(`config_file=${ultrasearchConfigPath()}`);
  console.log(
    `transport=${configString(["ULTRASEARCH_TRANSPORT", "SEARXNG_MCP_TRANSPORT"], "transport.mode", "stdio")}`,
  );
  console.log(
    `searxng_url=${configString(["ULTRASEARCH_SEARXNG_URL", "SEARXNG_URL"], "search.searxngUrl", "http://localhost:8081")}`,
  );
  console.log(
    `cache_url=${configString(["ULTRASEARCH_CACHE_URL", "CACHE_URL", "VALKEY_URL", "REDIS_URL"], "cache.url", "redis://localhost:6381")}`,
  );
  console.log(`hosted_fallback_enabled=${fallbackEnabled}`);
  console.log(`provider_order=${order.join(",")}`);
  for (const provider of PROVIDERS) {
    const key = providerApiKey(provider, PROVIDER_ENV[provider]);
    console.log(`provider.${provider}.api_key=${redactSecret(key)}`);
  }
}

function envRef(name: string): string {
  return ["$", "{", name, "}"].join("");
}

export function printConfigTemplate(): void {
  const config = {
    transport: { mode: "stdio", host: "127.0.0.1", port: 3001 },
    search: {
      searxngUrl: "http://localhost:8081",
      hostedFallbackEnabled: true,
      providerOrder: ["tinyfish", "exa", "parallel", "brave"],
      fallbackMinResults: 1,
    },
    cache: { url: "redis://localhost:6381" },
    providers: {
      tinyfish: {
        apiKey: envRef("ULTRASEARCH_TINYFISH_API_KEY"),
        location: "CA",
        budget: { monthlyUnits: 50, unitsPerRequest: 1, warnPercent: 80 },
      },
      exa: { apiKey: envRef("ULTRASEARCH_EXA_API_KEY") },
      parallel: {
        apiKey: envRef("ULTRASEARCH_PARALLEL_API_KEY"),
        mode: "basic",
      },
      brave: { apiKey: envRef("ULTRASEARCH_BRAVE_API_KEY") },
    },
    budget: { failOpen: false },
  };
  console.log(JSON.stringify(config, null, 2));
}
