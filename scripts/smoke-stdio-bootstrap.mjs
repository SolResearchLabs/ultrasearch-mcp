import { spawn } from "node:child_process";
import { Client as V2Client } from "@modelcontextprotocol/client";
import { StdioClientTransport as V2StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = "build/src/index.js";
const placeholder = (name) => ["$", "{", `user_config.${name}`, "}"].join("");
const env = {
  ...process.env,
  ULTRASEARCH_TRANSPORT: "stdio",
  ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "true",
  ULTRASEARCH_EXA_API_KEY: placeholder("exa_api_key"),
  ULTRASEARCH_PARALLEL_API_KEY: placeholder("parallel_api_key"),
  ULTRASEARCH_BRAVE_API_KEY: placeholder("brave_api_key"),
  ULTRASEARCH_FIRECRAWL_API_KEY: placeholder("firecrawl_api_key"),
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
          "io.modelcontextprotocol/clientCapabilities": {},
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
  if (!Array.isArray(response?.result?.supportedVersions)) {
    throw new Error(
      `server/discover did not respond within ${timeoutMs}ms; stdout=${JSON.stringify(
        stdout,
      )}; stderr=${JSON.stringify(stderr)}`,
    );
  }
  if (response.result.supportedVersions.length === 0) {
    throw new Error(
      `server/discover returned legacy-only empty versions; stdout=${JSON.stringify(
        stdout,
      )}`,
    );
  }
  console.log(
    JSON.stringify({
      test: `server_discover_${timeoutMs}ms`,
      supportedVersions: response.result.supportedVersions,
    }),
  );
}
async function v2ClientSmoke() {
  const transport = new V2StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
  });
  const client = new V2Client({
    name: "stdio-bootstrap-smoke-v2",
    version: "0.0.0",
  });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  if (tools.tools.length < 7) {
    throw new Error(`expected at least 7 tools, got ${tools.tools.length}`);
  }
  console.log(
    JSON.stringify({ test: "v2_sdk_stdio_client", toolCount: tools.tools.length }),
  );
}
async function v1ClientSmoke() {
  const transport = new V1StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
  });
  const client = new V1Client({
    name: "stdio-bootstrap-smoke-v1",
    version: "0.0.0",
  });
  await client.connect(transport);
  const tools = await client.listTools();
  await client.close();
  if (tools.tools.length < 7) {
    throw new Error(`expected at least 7 tools, got ${tools.tools.length}`);
  }
  console.log(
    JSON.stringify({ test: "v1_sdk_stdio_client", toolCount: tools.tools.length }),
  );
}

await timedDiscover(150);
await timedDiscover(300);
await timedDiscover(750);
await v2ClientSmoke();
await v1ClientSmoke();
console.log("stdio_bootstrap_smoke=PASS");
