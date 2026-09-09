#!/usr/bin/env node

type InitialStdioMessage = {
  raw: Buffer;
  line: string;
  rest: Buffer;
};

type InitialStdioPayload = {
  raw: Buffer;
  rest: Buffer;
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
      },
    })}\n`,
  );
};

const envTransport = (
  process.env.ULTRASEARCH_TRANSPORT ??
  process.env.SEARXNG_MCP_TRANSPORT ??
  "stdio"
).toLowerCase();

if (envTransport === "http") {
  const { startHttpServer } = await import("./server-entry.js");
  await startHttpServer();
} else {
  const initial = await readInitialStdioMessage();
  const discover = initial ? isServerDiscoverRequest(initial.line) : null;
  const initialForServer: InitialStdioPayload | null = discover
    ? initial && initial.rest.length > 0
      ? { raw: initial.rest, rest: Buffer.alloc(0) }
      : null
    : initial
      ? { raw: initial.raw, rest: initial.rest }
      : null;

  if (discover) {
    sendLegacyDiscoverResponse(discover.id);
  }

  const { startStdioServer } = await import("./server-entry.js");
  await startStdioServer(initialForServer);
}
