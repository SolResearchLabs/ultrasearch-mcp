import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;
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

function normalizeConfigString(value: string): string | undefined {
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
      const normalized = normalizeConfigString(value);
      if (normalized !== undefined) return normalized;
    }
  }
  const value = getPath(path);
  if (typeof value === "string") return normalizeConfigString(value);
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
      const normalized = normalizeConfigString(raw);
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
    const normalized = normalizeConfigString(value);
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
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
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
