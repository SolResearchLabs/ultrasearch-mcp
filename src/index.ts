#!/usr/bin/env node

type InitialStdioMessage = {
  raw: Buffer;
  line: string;
  rest: Buffer;
};

type InitialStdioPayload = {
  raw: Buffer;
  rest: Buffer;
  suppressFirstResponseId?: unknown;
};

const printCliAndExit = async (command: string) => {
  const { printConfigTemplate, printDoctor, printHelp } = await import(
    "./cli/configure.js"
  );
  if (command === "doctor") {
    printDoctor();
  } else if (command === "init-config" || command === "configure") {
    printConfigTemplate();
  } else {
    printHelp();
  }
  process.exit(0);
};

const command = process.argv[2];
if (
  command === "doctor" ||
  command === "init-config" ||
  command === "configure" ||
  command === "help" ||
  command === "--help" ||
  command === "-h"
) {
  await printCliAndExit(command);
}

const envTransport = (
  process.env.ULTRASEARCH_TRANSPORT ??
  process.env.SEARXNG_MCP_TRANSPORT ??
  "stdio"
).toLowerCase();

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
      process.stdin.pause();
      resolve(value);
    };

    const onError = (error: Error) => {
      cleanup();
      process.stdin.pause();
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

const isModernDiscoverRequest = (line: string): { id: unknown } | null => {
  try {
    const message = JSON.parse(line) as {
      id?: unknown;
      method?: unknown;
      params?: { _meta?: Record<string, unknown> };
    };
    const meta = message.params?._meta;
    return message.method === "server/discover" &&
      "id" in message &&
      meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28"
      ? { id: message.id }
      : null;
  } catch {
    return null;
  }
};

const sendModernDiscoverResponse = (id: unknown) => {
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: { listChanged: true } },
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "ultrasearch-mcp",
            version: "0.1.0",
          },
        },
      },
    })}\n`,
  );
};

if (envTransport === "http") {
  const { startHttpServer } = await import("./server-entry.js");
  await startHttpServer();
} else {
  const initial = await readInitialStdioMessage();
  const discover = initial ? isModernDiscoverRequest(initial.line) : null;
  if (discover) {
    sendModernDiscoverResponse(discover.id);
  }

  const initialForServer: InitialStdioPayload | null = discover
    ? initial
      ? {
          raw: initial.raw,
          rest: initial.rest,
          suppressFirstResponseId: discover.id,
        }
      : null
    : initial
      ? { raw: initial.raw, rest: initial.rest }
      : null;

  const { startStdioServer } = await import("./stdio-entry.js");
  startStdioServer(initialForServer);
}
