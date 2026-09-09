import { spawn } from "node:child_process";
import { Client as V2Client } from "@modelcontextprotocol/client";
import { StdioClientTransport as V2StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as V1StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = "build/src/index.js";
const placeholder = (name) => ["$", "{", `user_config.${name}`, "}"].join("");
const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};
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
const collectJsonLines = (stdout) =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const spawnServer = () =>
  spawn(process.execPath, [entry], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

const writeMessage = (child, message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

async function timedDiscover(timeoutMs) {
  const child = spawnServer();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  writeMessage(child, {
    jsonrpc: "2.0",
    id: `discover-${timeoutMs}`,
    method: "server/discover",
    params: { _meta: envelope },
  });
  await sleep(timeoutMs);
  child.kill("SIGTERM");

  const response = collectJsonLines(stdout)[0];
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

async function claudeModernToolsListSmoke() {
  const child = spawnServer();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  writeMessage(child, {
    jsonrpc: "2.0",
    id: "discover-claude",
    method: "server/discover",
    params: { _meta: envelope },
  });
  await sleep(200);
  writeMessage(child, {
    jsonrpc: "2.0",
    id: 0,
    method: "tools/list",
    params: { _meta: envelope },
  });
  await sleep(1200);
  child.kill("SIGTERM");

  const lines = collectJsonLines(stdout);
  const discover = lines.find((line) => line.id === "discover-claude");
  const tools = lines.find((line) => line.id === 0);
  if (!Array.isArray(discover?.result?.supportedVersions)) {
    throw new Error(`missing discover response: ${JSON.stringify({ stdout, stderr })}`);
  }
  if (!Array.isArray(tools?.result?.tools) || tools.result.tools.length < 7) {
    throw new Error(`missing tools/list response: ${JSON.stringify({ stdout, stderr })}`);
  }
  console.log(
    JSON.stringify({
      test: "claude_modern_tools_list",
      supportedVersions: discover.result.supportedVersions,
      toolCount: tools.result.tools.length,
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
await claudeModernToolsListSmoke();
await v2ClientSmoke();
await v1ClientSmoke();
console.log("stdio_bootstrap_smoke=PASS");
