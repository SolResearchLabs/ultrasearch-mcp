import { createServer } from "node:http";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as ModernMcpServer } from "@modelcontextprotocol/server";
import { HTTP_HOST, HTTP_PORT } from "./config.js";
import { initEvents, shutdownEvents } from "./events.js";
import { createHttpRequestListener } from "./http-transport.js";
import { logError } from "./log.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

type LegacyToolRegistrar = Parameters<typeof registerTools>[0];
type RawShape = Record<string, unknown>;
type ToolCallback = (args: never) => unknown;
type ModernRegisterTool = (
  name: string,
  config: RawShape,
  cb: ToolCallback,
) => unknown;

let processHandlersInstalled = false;
let runtimeInitialized: Promise<void> | null = null;

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

export const initRuntime = async (): Promise<void> => {
  installProcessHandlers();
  runtimeInitialized ??= Promise.all([initObservability(), initEvents()]).then(
    () => undefined,
  );
  await runtimeInitialized;
};

const adaptModernServer = (server: ModernMcpServer): LegacyToolRegistrar => {
  const registerTool = server.registerTool.bind(
    server,
  ) as unknown as ModernRegisterTool;
  const adapter = {
    registerTool: (
      name: string,
      config: { inputSchema?: unknown; outputSchema?: unknown } & RawShape,
      cb: ToolCallback,
    ) => registerTool(name, config, cb),
    tool: (
      name: string,
      description: string,
      inputSchema: unknown,
      cb: ToolCallback,
    ) => registerTool(name, { description, inputSchema }, cb),
  };
  return adapter as unknown as LegacyToolRegistrar;
};

export const createModernMcpServer = (): ModernMcpServer => {
  const server = new ModernMcpServer({
    name: "ultrasearch-mcp",
    version: VERSION,
  });
  registerTools(adaptModernServer(server));
  return server;
};

const createLegacyMcpServer = (): LegacyMcpServer => {
  const server = new LegacyMcpServer({
    name: "ultrasearch-mcp",
    version: VERSION,
  });
  registerTools(server);
  return server;
};

export const startHttpServer = async (): Promise<void> => {
  await initRuntime();

  const httpServer = createServer(
    createHttpRequestListener(createLegacyMcpServer),
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
