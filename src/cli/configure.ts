import {
  type ControlPlaneStatus,
  getControlPlaneConfig,
  getControlPlaneStatus,
  type ManagedRuntimeStatus,
} from "../control-plane/index.js";
import { ultrasearchConfigPath } from "../runtime-config.js";
import { runRuntimeCommand } from "./runtime.js";

type DiagnosticCommand = "doctor" | "status";
type DiagnosticOutputFormat = "human" | "json";
const SAFE_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function printHelp(): void {
  console.log(`UltraSearch MCP

Usage:
  ultrasearch-mcp                 Start the MCP server
  ultrasearch-mcp doctor [--json] Print redacted local configuration status
  ultrasearch-mcp status [--json] Print redacted Control Plane status
  ultrasearch-mcp runtime <op> [--json] Manage the managed local runtime lifecycle
  ultrasearch-mcp init-config     Print a starter JSON config
  ultrasearch-mcp help            Show this help

Default config file: ${ultrasearchConfigPath()}`);
}

function sortForStableOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableOutput);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortForStableOutput(item)]),
  );
}

function stringifyStable(value: unknown, space?: number): string {
  return JSON.stringify(sortForStableOutput(value), null, space) ?? "null";
}

function optionalLine(
  name: string,
  value: string | number | undefined,
): string | undefined {
  return value === undefined ? undefined : `${name}=${value}`;
}

function runtimeDiagnosticLine(
  diagnostic: ControlPlaneStatus["runtime"]["diagnostic"],
): string {
  if (diagnostic === null) return "none";
  if (typeof diagnostic === "string") return diagnostic;
  return `${diagnostic.code}:${diagnostic.httpStatus}`;
}

function synchronousDoctorEndpoint(endpoint: string): string {
  if (endpoint.length === 0) return endpoint;
  if (
    endpoint !== endpoint.trim() ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  ) {
    return "[redacted]";
  }

  try {
    const parsed = new URL(endpoint);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !SAFE_LOOPBACK_HOSTS.has(parsed.hostname) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return "[redacted]";
    }
    return endpoint;
  } catch {
    return "[redacted]";
  }
}

function managedRuntimeStatusLines(
  managedRuntime: ManagedRuntimeStatus | null,
): string[] {
  if (managedRuntime === null) return ["managed_runtime.state=unavailable"];
  return [
    `managed_runtime.state=${managedRuntime.state}`,
    `managed_runtime.endpoint=${managedRuntime.endpoint}`,
    `managed_runtime.port=${managedRuntime.port}`,
    `managed_runtime.pid=${managedRuntime.pid ?? "none"}`,
    `managed_runtime.generation=${managedRuntime.generation}`,
    `managed_runtime.ownership=${managedRuntime.ownership}`,
  ];
}

export function renderControlPlaneStatus(
  status: ControlPlaneStatus,
  command: DiagnosticCommand,
  format: DiagnosticOutputFormat,
): string {
  if (format === "json") return stringifyStable(status, 2);

  const firecrawl = status.providers.remoteFetch.firecrawl;
  const lines = [
    `UltraSearch MCP ${command}`,
    `schema_version=${status.schemaVersion}`,
    `profile.name=${status.configuration.profile.name ?? "none"}`,
    `profile.source=${status.configuration.profile.source}`,
    `routing.mode=${status.routing.mode}`,
    `routing.local_search.enabled=${status.routing.localSearch.enabled}`,
    `routing.hosted_search.enabled=${status.routing.hostedSearch.enabled}`,
    `routing.hosted_search.invocation=${status.routing.hostedSearch.invocation}`,
    `routing.offline_fetch.enabled=${status.routing.offlineFetch.enabled}`,
    `routing.offline_fetch.live_network_allowed=${status.routing.offlineFetch.liveNetworkAllowed}`,
    `local_search.endpoint=${status.localSearch.endpoint}`,
    `local_search.state=${status.localSearch.state}`,
    optionalLine("local_search.status_code", status.localSearch.statusCode),
    optionalLine("local_search.reason", status.localSearch.reason),
    `runtime.mode=${status.runtime.mode}`,
    `runtime.ownership=${status.runtime.ownership}`,
    `runtime.observation=${status.runtime.observation}`,
    `runtime.lifecycle=${status.runtime.lifecycle}`,
    `runtime.observed_at=${status.runtime.observedAt}`,
    `runtime.endpoint=${status.runtime.endpoint ?? "null"}`,
    `runtime.diagnostic=${runtimeDiagnosticLine(status.runtime.diagnostic)}`,
    ...managedRuntimeStatusLines(status.managedRuntime),
    `cache.state=${status.cache.state}`,
    `providers.configured_hosted_search=${status.providers.configuredHostedSearch.join(",") || "none"}`,
    `firecrawl.enabled=${firecrawl.enabled}`,
    `firecrawl.configured=${firecrawl.configured}`,
    `firecrawl.api_key_configured=${firecrawl.apiKeyConfigured}`,
    `configuration.sources=${stringifyStable(status.configuration.sources)}`,
    `configuration.values=${stringifyStable(status.configuration.values)}`,
    `providers.control=${stringifyStable(status.providers.control)}`,
    `providers.hosted_search_control=${stringifyStable(status.providers.hostedSearchControl)}`,
    `providers.hosted_search_budget=${stringifyStable(status.providers.hostedSearchBudget)}`,
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

async function printDiagnosticStatus(
  command: DiagnosticCommand,
  format: DiagnosticOutputFormat,
): Promise<void> {
  const status = await getControlPlaneStatus();
  console.log(renderControlPlaneStatus(status, command, format));
}

export async function printDoctorStatus(
  format: DiagnosticOutputFormat = "human",
): Promise<void> {
  await printDiagnosticStatus("doctor", format);
}

export async function printStatus(
  format: DiagnosticOutputFormat = "human",
): Promise<void> {
  await printDiagnosticStatus("status", format);
}

function diagnosticOutputFormat(
  argumentsAfterCommand: readonly string[],
): DiagnosticOutputFormat {
  return argumentsAfterCommand.includes("--json") ? "json" : "human";
}

/**
 * Dispatches only explicit CLI commands. Returning false leaves startup to the
 * normal MCP transport path.
 */
export async function runCliCommand(
  argumentsForCommand: readonly string[],
): Promise<boolean> {
  const [command, ...argumentsAfterCommand] = argumentsForCommand;
  switch (command) {
    case "doctor":
      await printDoctorStatus(diagnosticOutputFormat(argumentsAfterCommand));
      return true;
    case "status":
      await printStatus(diagnosticOutputFormat(argumentsAfterCommand));
      return true;
    case "runtime":
      await runRuntimeCommand(argumentsAfterCommand);
      return true;
    case "init-config":
    case "configure":
      printConfigTemplate();
      return true;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return true;
    default:
      return false;
  }
}

/**
 * Retained for the synchronous default-surface contract established in
 * FULL-PACKAGE-001. Executable doctor/status commands use the full
 * asynchronous Control Plane status result above.
 */
export function printDoctor(): void {
  const config = getControlPlaneConfig();
  console.log("UltraSearch MCP doctor");
  console.log(
    `searxng_url=${synchronousDoctorEndpoint(config.values.localSearch.endpoint)}`,
  );
}

function envRef(name: string): string {
  return ["$", "{", name, "}"].join("");
}

export function printConfigTemplate(): void {
  const config = {
    transport: { mode: "stdio", host: "127.0.0.1", port: 3001 },
    runtime: { mode: "external_endpoint" },
    search: {
      searxngUrl: "http://127.0.0.1:8099",
      hostedFallbackEnabled: true,
      providerOrder: ["tinyfish", "exa", "parallel", "brave"],
      fallbackMinResults: 1,
    },
    cache: { url: "redis://localhost:6381" },
    providers: {
      tinyfish: {
        apiKey: envRef("ULTRASEARCH_TINYFISH_API_KEY"),
        location: "CA",
        budget: { monthlyUnits: 50, unitsPerRequest: 1, warnPercent: 80 },
      },
      exa: { apiKey: envRef("ULTRASEARCH_EXA_API_KEY") },
      parallel: {
        apiKey: envRef("ULTRASEARCH_PARALLEL_API_KEY"),
        mode: "basic",
      },
      brave: { apiKey: envRef("ULTRASEARCH_BRAVE_API_KEY") },
    },
    budget: { failOpen: false },
  };
  console.log(JSON.stringify(config, null, 2));
}
