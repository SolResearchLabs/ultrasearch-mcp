import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RuntimeConfigObject = Record<string, unknown>;
type JsonObject = RuntimeConfigObject;
let loaded = false;
let cachedConfig: JsonObject = {};

export function ultrasearchConfigPath(): string {
  const explicit = process.env.ULTRASEARCH_CONFIG?.trim();
  return (
    explicit || join(homedir(), ".config", "ultrasearch-mcp", "config.json")
  );
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
function loadConfig(): JsonObject {
  if (loaded) return cachedConfig;
  loaded = true;
  const path = ultrasearchConfigPath();
  if (!existsSync(path)) return cachedConfig;
  try {
    cachedConfig = asObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (err) {
    console.warn(
      `[ultrasearch-mcp] could not read config file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    cachedConfig = {};
  }
  return cachedConfig;
}

export function resetRuntimeConfigForTests(): void {
  loaded = false;
  cachedConfig = {};
}

/**
 * Returns a JSON-only snapshot for compatibility adapters. The clone prevents
 * callers from mutating the process-level cache while resolving diagnostics.
 */
export function runtimeConfigSnapshot(): RuntimeConfigObject {
  return JSON.parse(JSON.stringify(loadConfig())) as RuntimeConfigObject;
}

function getPath(path?: string): unknown {
  if (!path) return undefined;
  let current: unknown = loadConfig();
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}
function isUnresolvedUserConfigPlaceholder(value: string): boolean {
  return /^\$\{user_config\.[A-Za-z0-9_.-]+\}$/.test(value.trim());
}

export function normalizeRuntimeConfigString(
  value: string,
): string | undefined {
  const expanded = expandEnv(value).trim();
  if (expanded === "" || isUnresolvedUserConfigPlaceholder(expanded)) {
    return undefined;
  }
  return expanded;
}

function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)(?::-(.*?))?\}/g,
    (_m, name: string, fallback: string | undefined) => {
      const envValue = process.env[name];
      return envValue === undefined || envValue === ""
        ? (fallback ?? "")
        : envValue;
    },
  );
}

export function optionalConfigString(
  envNames: string[],
  path?: string,
): string | undefined {
  for (const name of envNames) {
    const value = process.env[name];
    if (value !== undefined) {
      const normalized = normalizeRuntimeConfigString(value);
      if (normalized !== undefined) return normalized;
    }
  }
  const value = getPath(path);
  if (typeof value === "string") return normalizeRuntimeConfigString(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(String).join(",");
  return undefined;
}

export function configString(
  envNames: string[],
  path: string | undefined,
  fallback: string,
): string {
  return optionalConfigString(envNames, path) ?? fallback;
}
export function configStringList(
  envNames: string[],
  path: string | undefined,
  fallback: string[],
): string[] {
  for (const name of envNames) {
    const raw = process.env[name];
    if (raw !== undefined) {
      const normalized = normalizeRuntimeConfigString(raw);
      if (normalized !== undefined) {
        return normalized
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      }
    }
  }
  const value = getPath(path);
  if (Array.isArray(value))
    return value
      .map(String)
      .map((x) => x.trim())
      .filter(Boolean);
  if (typeof value === "string") {
    const normalized = normalizeRuntimeConfigString(value);
    if (normalized !== undefined) {
      return normalized
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return fallback;
}

export function optionalConfigNumber(
  envNames: string[],
  path?: string,
): number | undefined {
  const raw = optionalConfigString(envNames, path);
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function configNumber(
  envNames: string[],
  path: string | undefined,
  fallback: number,
): number {
  return optionalConfigNumber(envNames, path) ?? fallback;
}
export function optionalConfigBoolean(
  envNames: string[],
  path?: string,
): boolean | undefined {
  const raw = optionalConfigString(envNames, path);
  if (raw === undefined) return undefined;
  return parseRuntimeConfigBoolean(raw);
}

export function parseRuntimeConfigBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const valueLower = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(valueLower)) return true;
  if (["0", "false", "no", "off"].includes(valueLower)) return false;
  return undefined;
}

export function configBoolean(
  envNames: string[],
  path: string | undefined,
  fallback: boolean,
): boolean {
  return optionalConfigBoolean(envNames, path) ?? fallback;
}

export function providerApiKey(
  provider: string,
  envNames: string[],
): string | undefined {
  return (
    optionalConfigString(envNames, `providers.${provider}.apiKey`)?.trim() ||
    undefined
  );
}

export function providerOption(
  provider: string,
  key: string,
  envNames: string[],
  fallback?: string,
): string | undefined {
  return (
    optionalConfigString(envNames, `providers.${provider}.${key}`) ?? fallback
  );
}

export function redactSecret(value: string | undefined): string {
  if (!value) return "not set";
  return value.length <= 8
    ? "set"
    : `${value.slice(0, 4)}...${value.slice(-4)}`;
}
