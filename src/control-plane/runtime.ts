import type { RuntimeMode } from "../config/schema.js";

const HEALTH_TIMEOUT_MS = 1_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const RUNTIME_LIFECYCLE_OPERATIONS = [
  "start",
  "stop",
  "restart",
  "reconcile",
  "repair",
  "adopt_container",
] as const;

export type RuntimeLifecycleOperation =
  (typeof RUNTIME_LIFECYCLE_OPERATIONS)[number];
export type RuntimeOwnership = "operator" | "external";
export type RuntimeObservation = "reachable" | "unreachable" | "not_probed";
export type RuntimeClock = () => Date;

export type RuntimeDiagnostic =
  | "endpoint_is_not_loopback"
  | "not_configured"
  | "redirect_refused"
  | "request_failed"
  | "transport_error"
  | {
      code: "http_error";
      httpStatus: number;
    }
  | null;

export interface RuntimeStatus {
  mode: RuntimeMode;
  ownership: RuntimeOwnership;
  observation: RuntimeObservation;
  lifecycle: "unavailable";
  observedAt: string;
  endpoint: string | null;
  diagnostic: RuntimeDiagnostic;
}

export interface LocalSearchStatus {
  state: RuntimeObservation;
  endpoint: string;
  statusCode?: number;
  reason?: "endpoint_is_not_loopback" | "not_configured" | "request_failed";
}

export interface RuntimeObservationResult {
  runtime: RuntimeStatus;
  localSearch: LocalSearchStatus;
}

export interface RuntimeObservationOptions {
  mode: RuntimeMode;
  endpoint: string;
  fetcher?: RuntimeFetch;
  clock?: RuntimeClock;
}

export interface RuntimeLifecycleRejection {
  operation: RuntimeLifecycleOperation;
  accepted: false;
  lifecycle: "unavailable";
  diagnostic: "lifecycle_unavailable";
}

export type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function ownershipFor(mode: RuntimeMode): RuntimeOwnership {
  return mode === "operator_compose" ? "operator" : "external";
}

function normalizedLoopbackBase(endpoint: string): string | undefined {
  if (
    endpoint !== endpoint.trim() ||
    endpoint.includes("?") ||
    endpoint.includes("#")
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(endpoint);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !LOOPBACK_HOSTS.has(parsed.hostname) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return undefined;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return undefined;
  }
}

function safeEndpointOrRedaction(endpoint: string): string {
  return endpoint.length === 0 ? "" : "[redacted]";
}

function unavailableObservation(
  mode: RuntimeMode,
  endpoint: string,
  observedAt: string,
  diagnostic: "endpoint_is_not_loopback" | "not_configured",
): RuntimeObservationResult {
  const normalized = normalizedLoopbackBase(endpoint);
  const safeEndpoint = normalized ?? safeEndpointOrRedaction(endpoint);

  return {
    runtime: {
      mode: "unavailable",
      ownership: ownershipFor(mode),
      observation: "not_probed",
      lifecycle: "unavailable",
      observedAt,
      endpoint: normalized ?? null,
      diagnostic,
    },
    localSearch: {
      state: "not_probed",
      endpoint: safeEndpoint,
      reason: diagnostic,
    },
  };
}

function transportDiagnostic(error: unknown): RuntimeDiagnostic {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const message = [
      error.message,
      cause instanceof Error ? cause.message : cause,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (message.includes("redirect")) {
      return "redirect_refused";
    }
  }
  return "transport_error";
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Closing an already-consumed or errored body does not change the probe.
  }
}

function responseObservation(
  mode: RuntimeMode,
  endpoint: string,
  observedAt: string,
  response: Response,
): RuntimeObservationResult {
  const ownership = ownershipFor(mode);
  if (response.ok) {
    return {
      runtime: {
        mode,
        ownership,
        observation: "reachable",
        lifecycle: "unavailable",
        observedAt,
        endpoint,
        diagnostic: null,
      },
      localSearch: {
        state: "reachable",
        endpoint,
        statusCode: response.status,
      },
    };
  }

  return {
    runtime: {
      mode,
      ownership,
      observation: "unreachable",
      lifecycle: "unavailable",
      observedAt,
      endpoint,
      diagnostic: {
        code: "http_error",
        httpStatus: response.status,
      },
    },
    localSearch: {
      state: "unreachable",
      endpoint,
      statusCode: response.status,
      reason: "request_failed",
    },
  };
}

function failedObservation(
  mode: RuntimeMode,
  endpoint: string,
  observedAt: string,
  diagnostic: RuntimeDiagnostic,
): RuntimeObservationResult {
  return {
    runtime: {
      mode,
      ownership: ownershipFor(mode),
      observation: "unreachable",
      lifecycle: "unavailable",
      observedAt,
      endpoint,
      diagnostic,
    },
    localSearch: {
      state: "unreachable",
      endpoint,
      reason: "request_failed",
    },
  };
}

export async function observeRuntime(
  options: RuntimeObservationOptions,
): Promise<RuntimeObservationResult> {
  const clock = options.clock ?? (() => new Date());
  const observedAt = clock().toISOString();
  const normalizedEndpoint = normalizedLoopbackBase(options.endpoint);

  if (options.endpoint.length === 0 || options.mode === "unavailable") {
    return unavailableObservation(
      options.mode,
      options.endpoint,
      observedAt,
      "not_configured",
    );
  }

  if (!normalizedEndpoint) {
    return unavailableObservation(
      options.mode,
      options.endpoint,
      observedAt,
      "endpoint_is_not_loopback",
    );
  }

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetcher(`${normalizedEndpoint}/healthz`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    const result = responseObservation(
      options.mode,
      normalizedEndpoint,
      observedAt,
      response,
    );
    await cancelResponseBody(response);
    return result;
  } catch (error) {
    return failedObservation(
      options.mode,
      normalizedEndpoint,
      observedAt,
      transportDiagnostic(error),
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function rejectRuntimeLifecycle(
  operation: RuntimeLifecycleOperation,
): RuntimeLifecycleRejection {
  return {
    operation,
    accepted: false,
    lifecycle: "unavailable",
    diagnostic: "lifecycle_unavailable",
  };
}
