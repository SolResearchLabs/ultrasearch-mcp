#!/usr/bin/env node
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  printConfigTemplate,
  printDoctor,
  printHelp,
} from "./cli/configure.js";
import { HTTP_HOST, HTTP_PORT, TRANSPORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { logError } from "./log.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

// This is a single long-lived HTTP process serving all agents. Before these
// handlers, a fault anywhere took searxng down for everyone with nothing logged
// - the 2026-07-16 crash-loop left 10 core dumps and zero log lines. Register
// before any init work so faults during startup are captured too.
process.on("uncaughtException", (err) => {
  logError(
    `FATAL uncaughtException - exiting for a clean PM2 restart: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  // Undefined process state after an uncaught throw - exit so PM2 restarts a
  // clean process rather than limping on. exit(1) marks it abnormal.
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  // Log and keep running - an unhandled rejection is usually one degraded
  // request, not process-wide corruption. It is no longer silent, which is the
  // point. A genuinely fatal one will surface as an uncaughtException above.
  logError(
    `unhandledRejection (continuing): ${
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason)
    }`,
  );
});

const command = process.argv[2];
if (command === "doctor") {
  printDoctor();
  process.exit(0);
}
if (command === "init-config" || command === "configure") {
  printConfigTemplate();
  process.exit(0);
}
if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

await initObservability();
await initEvents();

const createSearxngServer = () => {
  const server = new McpServer({
    name: "ultrasearch-mcp",
    version: VERSION,
  });
  registerTools(server);
  return server;
};

type InitialStdioMessage = {
  raw: Buffer;
  line: string;
  rest: Buffer;
};

const readInitialStdioMessage = async (): Promise<InitialStdioMessage | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };

    const finish = (value: InitialStdioMessage | null) => {
      cleanup();
      resolve(value);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onEnd = () => finish(null);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex === -1) return;

      finish({
        raw: buffered.subarray(0, newlineIndex + 1),
        line: buffered.toString("utf8", 0, newlineIndex).replace(/\r$/, ""),
        rest: buffered.subarray(newlineIndex + 1),
      });
    };

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });

const isServerDiscoverRequest = (line: string): { id: unknown } | null => {
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown };
    return message.method === "server/discover" && "id" in message
      ? { id: message.id }
      : null;
  } catch {
    return null;
  }
};

const sendLegacyDiscoverResponse = (id: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        supportedVersions: [],
        capabilities: {},
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "ultrasearch-mcp",
            version: VERSION,
          },
        },
        instructions:
          "UltraSearch MCP serves the legacy initialize-based MCP stdio transport.",
      },
    })}\n`,
  );
};

const connectStdioServer = async (server: McpServer) => {
  const initial = await readInitialStdioMessage();
  const stdin = new PassThrough();

  if (initial) {
    const discover = isServerDiscoverRequest(initial.line);
    if (discover) {
      sendLegacyDiscoverResponse(discover.id);
    } else {
      stdin.write(initial.raw);
    }

    if (initial.rest.length > 0) {
      stdin.write(initial.rest);
    }
  }

  process.stdin.pipe(stdin);
  const transport = new StdioServerTransport(stdin, process.stdout);
  await server.connect(transport);
};

const shutdown = async () => {
  await Promise.allSettled([shutdownObservability(), shutdownEvents()]);
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

if (TRANSPORT === "http") {
  // Stateful HTTP transport - each MCP session gets its own transport (and
  // server) instance, keyed by Mcp-Session-Id, so concurrent clients don't
  // collide on a single shared transport. Multiple clients share in-process
  // caches (L1 llms.txt, domain stats) but have separate Valkey-backed state.
  const httpServer = createServer(
    createHttpRequestListener(createSearxngServer),
  );

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(
      `[ultrasearch-mcp] HTTP transport listening on http://${HTTP_HOST}:${HTTP_PORT}`,
    );
    if (HTTP_HOST !== "127.0.0.1") {
      console.error(
        `[ultrasearch-mcp] WARNING: HTTP transport bound to ${HTTP_HOST}:${HTTP_PORT} - no built-in auth; ensure network-level protection`,
      );
    }
  });
} else {
  const server = createSearxngServer();
  await connectStdioServer(server);
}
