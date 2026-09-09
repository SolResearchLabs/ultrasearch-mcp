import { PassThrough, Transform, type Writable } from "node:stream";
import {
  type ServeStdioOptions,
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

export type InitialStdioPayload = {
  raw: Buffer;
  rest: Buffer;
  suppressFirstResponseId?: unknown;
};

const responseSink = (suppressFirstResponseId: unknown): Writable => {
  if (suppressFirstResponseId === undefined) return process.stdout;

  let pending = "";
  let suppressed = false;

  const sink = new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      let newlineIndex = pending.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex + 1);
        pending = pending.slice(newlineIndex + 1);

        if (!suppressed) {
          suppressed = true;
          try {
            const parsed = JSON.parse(line.trim()) as { id?: unknown };
            if (parsed.id === suppressFirstResponseId) {
              newlineIndex = pending.indexOf("\n");
              continue;
            }
          } catch {
            // Forward malformed lines below.
          }
        }

        this.push(line);
        newlineIndex = pending.indexOf("\n");
      }

      callback();
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending);
      callback();
    },
  });

  sink.pipe(process.stdout);
  return sink;
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
    transport: new StdioServerTransport(
      stdin,
      responseSink(initial.suppressFirstResponseId),
    ),
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
