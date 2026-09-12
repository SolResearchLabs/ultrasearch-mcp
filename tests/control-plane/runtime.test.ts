import { describe, expect, it, vi } from "vitest";
import {
  observeRuntime,
  RUNTIME_LIFECYCLE_OPERATIONS,
  rejectRuntimeLifecycle,
} from "../../src/control-plane/runtime.js";

describe("Control Plane runtime observation", () => {
  it("normalizes a safe base path and makes one bounded healthz request", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      body: { cancel },
    } as unknown as Response);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      const result = await observeRuntime({
        mode: "operator_compose",
        endpoint: "http://localhost:8099/runtime/",
        fetcher,
        clock: () => new Date("2026-09-11T01:02:03.000Z"),
      });

      expect(result).toEqual({
        runtime: {
          mode: "operator_compose",
          ownership: "operator",
          observation: "reachable",
          lifecycle: "unavailable",
          observedAt: "2026-09-11T01:02:03.000Z",
          endpoint: "http://localhost:8099/runtime",
          diagnostic: null,
        },
        localSearch: {
          state: "reachable",
          endpoint: "http://localhost:8099/runtime",
          statusCode: 204,
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledWith(
        "http://localhost:8099/runtime/healthz",
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetcher.mock.calls[0][1]).not.toHaveProperty("headers");
      expect(cancel).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it("accepts an IPv6 loopback base", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
    } as unknown as Response);

    const result = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "https://[::1]:8099/runtime/",
      fetcher,
      clock: () => new Date("2026-09-11T01:02:03.000Z"),
    });

    expect(result.runtime.endpoint).toBe("https://[::1]:8099/runtime");
    expect(fetcher).toHaveBeenCalledWith(
      "https://[::1]:8099/runtime/healthz",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it.each([
    "https://remote.example.test",
    "http://user:pass@127.0.0.1:8099",
    "http://127.0.0.1:8099/path?query=value",
    "http://127.0.0.1:8099/path#fragment",
    "http://127.0.0.1:8099/path?",
    "http://127.0.0.1:8099/path#",
    "not a URL",
  ])("rejects unsafe endpoint %s before fetch", async (endpoint) => {
    const fetcher = vi.fn();

    const result = await observeRuntime({
      mode: "external_endpoint",
      endpoint,
      fetcher,
      clock: () => new Date("2026-09-11T01:02:03.000Z"),
    });

    expect(result).toEqual({
      runtime: {
        mode: "unavailable",
        ownership: "external",
        observation: "not_probed",
        lifecycle: "unavailable",
        observedAt: "2026-09-11T01:02:03.000Z",
        endpoint: null,
        diagnostic: "endpoint_is_not_loopback",
      },
      localSearch: {
        state: "not_probed",
        endpoint: "[redacted]",
        reason: "endpoint_is_not_loopback",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(endpoint);
  });

  it("does not observe blank endpoints or an explicitly unavailable mode", async () => {
    const fetcher = vi.fn();
    const clock = () => new Date("2026-09-11T01:02:03.000Z");

    const blank = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "",
      fetcher,
      clock,
    });
    const unavailable = await observeRuntime({
      mode: "unavailable",
      endpoint: "http://127.0.0.1:8099",
      fetcher,
      clock,
    });

    expect(blank).toMatchObject({
      runtime: {
        mode: "unavailable",
        ownership: "external",
        observation: "not_probed",
        endpoint: null,
        diagnostic: "not_configured",
      },
      localSearch: {
        state: "not_probed",
        endpoint: "",
        reason: "not_configured",
      },
    });
    expect(unavailable).toMatchObject({
      runtime: {
        mode: "unavailable",
        ownership: "external",
        observation: "not_probed",
        endpoint: "http://127.0.0.1:8099",
        diagnostic: "not_configured",
      },
      localSearch: {
        state: "not_probed",
        endpoint: "http://127.0.0.1:8099",
        reason: "not_configured",
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps configured ownership on HTTP and transport failures without retrying", async () => {
    const httpCancel = vi.fn().mockResolvedValue(undefined);
    const httpFetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: { cancel: httpCancel },
    } as unknown as Response);
    const transportFetcher = vi
      .fn()
      .mockRejectedValue(new Error("connection refused"));
    const redirectFetcher = vi
      .fn()
      .mockRejectedValue(new Error("redirect refused"));
    const wrappedRedirect = Object.assign(new TypeError("fetch failed"), {
      cause: new Error("unexpected redirect"),
    });
    const wrappedRedirectFetcher = vi.fn().mockRejectedValue(wrappedRedirect);
    const unknownTransportFetcher = vi.fn().mockRejectedValue("socket reset");
    const clock = () => new Date("2026-09-11T01:02:03.000Z");

    const http = await observeRuntime({
      mode: "operator_compose",
      endpoint: "http://127.0.0.1:8099",
      fetcher: httpFetcher,
      clock,
    });
    const transport = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "http://127.0.0.1:8099",
      fetcher: transportFetcher,
      clock,
    });
    const redirect = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "http://127.0.0.1:8099",
      fetcher: redirectFetcher,
      clock,
    });
    const wrapped = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "http://127.0.0.1:8099",
      fetcher: wrappedRedirectFetcher,
      clock,
    });
    const unknownTransport = await observeRuntime({
      mode: "external_endpoint",
      endpoint: "http://127.0.0.1:8099",
      fetcher: unknownTransportFetcher,
      clock,
    });

    expect(http.runtime).toMatchObject({
      mode: "operator_compose",
      ownership: "operator",
      observation: "unreachable",
      diagnostic: { code: "http_error", httpStatus: 503 },
    });
    expect(http.localSearch).toEqual({
      state: "unreachable",
      endpoint: "http://127.0.0.1:8099",
      statusCode: 503,
      reason: "request_failed",
    });
    expect(transport.runtime).toMatchObject({
      mode: "external_endpoint",
      ownership: "external",
      observation: "unreachable",
      diagnostic: "transport_error",
    });
    expect(transport.localSearch).toEqual({
      state: "unreachable",
      endpoint: "http://127.0.0.1:8099",
      reason: "request_failed",
    });
    expect(redirect.runtime.diagnostic).toBe("redirect_refused");
    expect(wrapped.runtime.diagnostic).toBe("redirect_refused");
    expect(unknownTransport.runtime.diagnostic).toBe("transport_error");
    expect(unknownTransport.localSearch).toEqual({
      state: "unreachable",
      endpoint: "http://127.0.0.1:8099",
      reason: "request_failed",
    });
    expect(httpCancel).toHaveBeenCalledOnce();
    expect(httpFetcher).toHaveBeenCalledOnce();
    expect(transportFetcher).toHaveBeenCalledOnce();
    expect(redirectFetcher).toHaveBeenCalledOnce();
    expect(wrappedRedirectFetcher).toHaveBeenCalledOnce();
    expect(unknownTransportFetcher).toHaveBeenCalledOnce();
  });

  it("aborts a stalled request after 1000 ms and clears the timeout", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    try {
      const observation = observeRuntime({
        mode: "external_endpoint",
        endpoint: "http://127.0.0.1:8099",
        fetcher,
        clock: () => new Date("2026-09-11T01:02:03.000Z"),
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(observation).resolves.toMatchObject({
        runtime: {
          observation: "unreachable",
          diagnostic: "transport_error",
        },
        localSearch: {
          state: "unreachable",
          reason: "request_failed",
        },
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects all lifecycle operations without a host executor", () => {
    const outcomes = RUNTIME_LIFECYCLE_OPERATIONS.map((operation) =>
      rejectRuntimeLifecycle(operation),
    );

    expect(outcomes).toEqual(
      RUNTIME_LIFECYCLE_OPERATIONS.map((operation) => ({
        operation,
        accepted: false,
        lifecycle: "unavailable",
        diagnostic: "lifecycle_unavailable",
      })),
    );
  });
});
