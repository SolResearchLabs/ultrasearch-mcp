import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTP_HOST, HTTP_PORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { logError } from "./log.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

export type InitialStdioPayload = {
  raw: Buffer;
  rest: Buffer;
};

let processHandlersInstalled = false;

const shutdown = async () => {
  await Promise.allSettled([shutdownObservability(), shutdownEvents()]);
  process.exit(0);
};

const installProcessHandlers = () => {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on("uncaughtException", (err) => {
    logError(
      `FATAL uncaughtException - exiting for a clean PM2 restart: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logError(
      `unhandledRejection (continuing): ${
        reason instanceof Error
          ? (reason.stack ?? reason.message)
          : String(reason)
      }`,
    );
  });

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
};

const initRuntime = async () => {
  installProcessHandlers();
  await initObservability();
  await initEvents();
};

const createSearxngServer = () => {
  const server = new McpServer({
    name: "ultrasearch-mcp",
    version: VERSION,
  });
  registerTools(server);
  return server;
};

export const startStdioServer = async (
  initial: InitialStdioPayload | null,
): Promise<void> => {
  await initRuntime();

  const stdin = new PassThrough();
  if (initial) {
    if (initial.raw.length > 0) {
      stdin.write(initial.raw);
    }
    if (initial.rest.length > 0) {
      stdin.write(initial.rest);
    }
  }

  process.stdin.pipe(stdin);
  const server = createSearxngServer();
  const transport = new StdioServerTransport(stdin, process.stdout);
  await server.connect(transport);
};

export const startHttpServer = async (): Promise<void> => {
  await initRuntime();

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
};
