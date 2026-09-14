import { join } from "node:path";

import {
  cleanupManagedRuntime,
  defaultManagedRuntimeRoot,
  type ManagedRuntimeCleanupResult,
  type ManagedRuntimeOperationResult,
  type ManagedRuntimeOptions,
  ManagedRuntimeRefusalError,
  type ManagedRuntimeStatus,
  managedRuntimePathsForRoot,
  provisionManagedRuntime,
  readManagedRuntimeStatus,
  repairManagedRuntime,
  restartManagedRuntime,
  startManagedRuntime,
  stopManagedRuntime,
} from "../control-plane/index.js";

type RuntimeCliFormat = "human" | "json";

export const RUNTIME_CLI_OPERATIONS = [
  "provision",
  "start",
  "stop",
  "restart",
  "status",
  "repair",
  "cleanup",
] as const;

export type RuntimeCliOperation = (typeof RUNTIME_CLI_OPERATIONS)[number];

const RUNTIME_CLI_USAGE = [
  "UltraSearch MCP runtime",
  "",
  "Usage:",
  "  ultrasearch-mcp runtime <operation> [--json]",
  "",
  "Operations:",
  "  provision   Verify the staged root and apply the pinned Windows patch",
  "  start       Start the managed local runtime on 127.0.0.1:18099",
  "  stop        Stop the managed runtime after verifying its recorded process",
  "  restart     Verified stop followed by start",
  "  status      Print the read-only managed runtime status",
  "  repair      Re-verify provisioning; re-apply the patch from a pristine checkout",
  "  cleanup     Delete the managed root after verification and proof",
].join("\n");

function sortForStableOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableOutput);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortForStableOutput(item)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableOutput(value), null, 2) ?? "null";
}

function isRuntimeCliOperation(
  value: string | undefined,
): value is RuntimeCliOperation {
  return (
    value !== undefined &&
    (RUNTIME_CLI_OPERATIONS as readonly string[]).includes(value)
  );
}

/**
 * The CLI resolves only the default managed root; the lifecycle, port, and
 * path rules stay in the Control Plane module. No port flag, configuration
 * key, or environment key exists for the managed runtime.
 */
export function runtimeCliOptions(): ManagedRuntimeOptions {
  const paths = managedRuntimePathsForRoot(defaultManagedRuntimeRoot());
  return {
    paths,
    settingsPath: join(paths.managedRoot, "searxng-settings.yml"),
  };
}

function runRuntimeOperation(
  operation: RuntimeCliOperation,
  options: ManagedRuntimeOptions,
): Promise<
  | ManagedRuntimeOperationResult
  | ManagedRuntimeCleanupResult
  | ManagedRuntimeStatus
> {
  switch (operation) {
    case "provision":
      return provisionManagedRuntime(options);
    case "start":
      return startManagedRuntime(options);
    case "stop":
      return stopManagedRuntime(options);
    case "restart":
      return restartManagedRuntime(options);
    case "status":
      return readManagedRuntimeStatus(options);
    case "repair":
      return repairManagedRuntime(options);
    case "cleanup":
      return cleanupManagedRuntime(options);
  }
}

function renderStatusLines(status: ManagedRuntimeStatus): string[] {
  return [
    `managed_runtime.state=${status.state}`,
    `managed_runtime.endpoint=${status.endpoint}`,
    `managed_runtime.port=${status.port}`,
    `managed_runtime.pid=${status.pid ?? "none"}`,
    `managed_runtime.generation=${status.generation}`,
    `managed_runtime.ownership=${status.ownership}`,
    `managed_runtime.state_file=${status.stateFile}`,
    `managed_runtime.observed_at=${status.observedAt}`,
  ];
}

function isCleanupResult(
  value:
    | ManagedRuntimeOperationResult
    | ManagedRuntimeCleanupResult
    | ManagedRuntimeStatus,
): value is ManagedRuntimeCleanupResult {
  return "pathAbsent" in value;
}

function isOperationResult(
  value:
    | ManagedRuntimeOperationResult
    | ManagedRuntimeCleanupResult
    | ManagedRuntimeStatus,
): value is ManagedRuntimeOperationResult {
  return "outcome" in value && "status" in value;
}

function renderManagedRuntimeResult(
  operation: RuntimeCliOperation,
  result:
    | ManagedRuntimeOperationResult
    | ManagedRuntimeCleanupResult
    | ManagedRuntimeStatus,
  format: RuntimeCliFormat,
): string {
  if (format === "json") return stableJson(result);

  const lines = [
    `UltraSearch MCP runtime`,
    `managed_runtime.operation=${operation}`,
  ];
  if (isCleanupResult(result)) {
    lines.push(
      `managed_runtime.outcome=${result.outcome}`,
      `managed_runtime.last_state=${result.lastState}`,
      `managed_runtime.managed_root=${result.managedRoot}`,
      `managed_runtime.path_absent=${result.pathAbsent}`,
      `managed_runtime.listeners_after=${result.listenersAfter}`,
      `managed_runtime.survivors_after=${result.survivorPids.length}`,
      `managed_runtime.cleared_lock_pids=${result.clearedLockPids.join(",") || "none"}`,
      `managed_runtime.verified_at=${result.verifiedAt}`,
    );
    return lines.join("\n");
  }
  if (isOperationResult(result)) {
    lines.push(`managed_runtime.outcome=${result.outcome}`);
    if (result.note !== undefined) {
      lines.push(`managed_runtime.note=${result.note}`);
    }
    lines.push(...renderStatusLines(result.status));
    return lines.join("\n");
  }
  lines.push(...renderStatusLines(result));
  return lines.join("\n");
}

export function renderManagedRuntimeRefusal(
  operation: string,
  error: ManagedRuntimeRefusalError,
  format: RuntimeCliFormat,
): string {
  if (format === "json") {
    return stableJson({
      operation,
      refused: true,
      code: error.code,
      detail: error.detail,
    });
  }
  return [
    "UltraSearch MCP runtime",
    `managed_runtime.operation=${operation}`,
    "managed_runtime.refused=true",
    `managed_runtime.refusal_code=${error.code}`,
    `managed_runtime.detail=${error.detail}`,
  ].join("\n");
}

/**
 * Thin `runtime <operation> [--json]` surface. It parses arguments and prints
 * the Control Plane result; it contains no lifecycle rule, no process
 * handling, and no path logic beyond resolving the default managed root.
 */
export async function runRuntimeCommand(
  argumentsAfterCommand: readonly string[],
): Promise<void> {
  const format: RuntimeCliFormat = argumentsAfterCommand.includes("--json")
    ? "json"
    : "human";
  const [operation] = argumentsAfterCommand;

  if (operation === undefined || operation === "help") {
    console.log(RUNTIME_CLI_USAGE);
    return;
  }
  if (!isRuntimeCliOperation(operation)) {
    console.log(RUNTIME_CLI_USAGE);
    console.log(`managed_runtime.unknown_operation=${operation}`);
    return;
  }

  try {
    const result = await runRuntimeOperation(operation, runtimeCliOptions());
    console.log(renderManagedRuntimeResult(operation, result, format));
  } catch (error) {
    if (error instanceof ManagedRuntimeRefusalError) {
      console.log(renderManagedRuntimeRefusal(operation, error, format));
      return;
    }
    throw error;
  }
}
