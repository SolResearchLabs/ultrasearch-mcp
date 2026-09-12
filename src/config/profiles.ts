import type { RoutingMode } from "./schema.js";

export type ConfigProfileName = "local" | "hybrid" | "hosted" | "offline";

export interface ConfigProfile {
  routingMode: RoutingMode;
}

export const CONFIG_PROFILES: Record<ConfigProfileName, ConfigProfile> = {
  local: { routingMode: "local_only" },
  hybrid: { routingMode: "hybrid" },
  hosted: { routingMode: "hosted_only" },
  offline: { routingMode: "offline_fetch_only" },
};

export function isConfigProfileName(
  value: unknown,
): value is ConfigProfileName {
  return (
    typeof value === "string" && Object.keys(CONFIG_PROFILES).includes(value)
  );
}
