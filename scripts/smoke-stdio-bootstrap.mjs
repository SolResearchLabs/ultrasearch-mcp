import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = "build/src/index.js";
const env = {
  ...process.env,
  ULTRASEARCH_TRANSPORT: "stdio",
  ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "true",
  ULTRASEARCH_PROVIDER_ORDER: "tinyfish,exa,parallel,brave",
  ULTRASEARCH_TINYFISH_API_KEY: "test-tinyfish-key",
  ULTRASEARCH_EXA_API_KEY: "${user_config.exa_api_key}",
  ULTRASEARCH_PARALLEL_API_KEY: "${user_config.parallel_api_key}",
  ULTRASEARCH_BRAVE_API_KEY: "${user_config.brave_api_key}",
  ULTRASEARCH_FIRECRAWL_URL: "${user_config.firecrawl_url}",
  ULTRASEARCH_FIRECRAWL_API_KEY: "${user_config.firecrawl_api_key}",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function timedDiscover(timeoutMs) {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: `discover-${timeoutMs}`,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    })}\n`,
  );
  await sleep(timeoutMs);
  child.kill("SIGTERM");

  const lines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const response = lines[0];
  if (response?.result?.supportedVersions === undefined) {
    throw new Error(
      `server/discover did not respond within ${timeoutMs}ms; stdout=${JSON.stringify(
        stdout,
      )}; stderr=${JSON.stringify(stderr)}`,
    );
  }
  console.log(
    JSON.stringify({
      test: `server_discover_${timeoutMs}ms`,
      supportedVersions: response.result.supportedVersions,
    }),
  );
}

async function discoverThenInitializeSamePipe() {
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-bootstrap-smoke", version: "0.0.0" },
      },
    })}\n`,
  );
  await sleep(1200);
  child.kill("SIGTERM");

  const lines = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const initialize = lines.find((line) => line.id === 2);
  if (!initialize?.result?.protocolVersion) {
    throw new Error(
      `same-pipe discover+initialize failed; stdout=${JSON.stringify(stdout)}`,
    );
  }
  console.log(
    JSON.stringify({
      test: "server_discover_then_initialize_same_pipe",
      responses: lines.length,
      protocolVersion: initialize.result.protocolVersion,
    }),
  );
}

async function sdkClientSmoke() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
  });
  const client = new Client({ name: "stdio-bootstrap-smoke", version: "0.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  if (tools.tools.length < 7) {
    throw new Error(`expected at least 7 tools, got ${tools.tools.length}`);
  }
  console.log(
    JSON.stringify({
      test: "sdk_stdio_client",
      toolCount: tools.tools.length,
    }),
  );
}

await timedDiscover(150);
await timedDiscover(300);
await timedDiscover(750);
await discoverThenInitializeSamePipe();
await sdkClientSmoke();
console.log("stdio_bootstrap_smoke=PASS");
