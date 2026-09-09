#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const entry = "build/src/index.js";
const envelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linesOf = (stdout) =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const server = createServer((socket) => {
  socket.on("error", () => {});
  // Intentionally never respond. The MCP tool-level deadline should win before
  // fetch's lower-level timeout so desktop bridges are never left pending.
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("expected TCP test server address");
}

const child = spawn(process.execPath, [entry], {
  env: {
    ...process.env,
    ULTRASEARCH_TRANSPORT: "stdio",
    ULTRASEARCH_SEARXNG_URL: `http://127.0.0.1:${address.port}`,
    ULTRASEARCH_HOSTED_FALLBACK_ENABLED: "false",
    MCP_TOOL_TIMEOUT_MS: "1000",
    CACHE_CONNECT_TIMEOUT_MS: "100",
    CACHE_COMMAND_TIMEOUT_MS: "100",
    CACHE_MAX_RETRIES_PER_REQUEST: "1",
  },
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

const writeMessage = (message) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
};

const t0 = Date.now();
writeMessage({
  jsonrpc: "2.0",
  id: "discover",
  method: "server/discover",
  params: { _meta: envelope },
});
await sleep(200);
writeMessage({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "search",
    arguments: {
      query: "deadline smoke",
      num_results: 3,
    },
    _meta: envelope,
  },
});

let response;
for (let i = 0; i < 40; i++) {
  await sleep(100);
  response = linesOf(stdout).find((line) => line.id === 1);
  if (response) break;
}

child.kill("SIGTERM");
server.close();

if (!response) {
  throw new Error(
    `tools/call did not return before deadline; stdout=${JSON.stringify(
      stdout,
    )}; stderr=${JSON.stringify(stderr)}`,
  );
}

const elapsedMs = Date.now() - t0;
const text = response.result?.content?.[0]?.text ?? "";
if (!response.result?.isError || !String(text).includes("timed out")) {
  throw new Error(`expected timeout error response, got ${JSON.stringify(response)}`);
}
if (elapsedMs > 7000) {
  throw new Error(`tool deadline response was too slow: ${elapsedMs}ms`);
}

console.log(
  JSON.stringify({
    test: "tool_deadline_returns_before_bridge_timeout",
    elapsedMs,
    isError: response.result.isError,
  }),
);
console.log("stdio_tool_timeout_smoke=PASS");
