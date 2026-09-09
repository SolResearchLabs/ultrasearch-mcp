import { PassThrough } from "node:stream";
import {
  type ServeStdioOptions,
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

export type InitialStdioPayload = {
  raw: Buffer;
  rest: Buffer;
};

const transportOptions = (
  initial: InitialStdioPayload | null,
): Pick<ServeStdioOptions, "transport"> => {
  if (!initial) return {};

  const stdin = new PassThrough();
  if (initial.raw.length > 0) {
    stdin.write(initial.raw);
  }
  if (initial.rest.length > 0) {
    stdin.write(initial.rest);
  }
  process.stdin.pipe(stdin);

  return {
    transport: new StdioServerTransport(stdin, process.stdout),
  };
};

export const startStdioServer = (initial: InitialStdioPayload | null): void => {
  serveStdio(
    async () => {
      const { createModernMcpServer, initRuntime } = await import(
        "./server-entry.js"
      );
      await initRuntime();
      return createModernMcpServer();
    },
    {
      ...transportOptions(initial),
      onerror: (error) => {
        console.error(
          `[ultrasearch-mcp] stdio transport error: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`,
        );
      },
    },
  );
};
