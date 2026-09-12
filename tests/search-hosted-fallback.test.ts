import { beforeEach, describe, expect, it, vi } from "vitest";

const hosted = vi.hoisted(() => ({
  hasUsefulPrimarySearch: vi.fn(),
  searchHostedFallback: vi.fn(),
  searchHostedFallbackWithAttempts: vi.fn(),
}));

const controlPlane = vi.hoisted(() => ({
  getControlPlaneConfig: vi.fn(),
  resolveRoutingPolicy: vi.fn(),
}));

vi.mock("../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("cache-key"),
}));

vi.mock("../src/control-plane/index.js", () => ({
  getControlPlaneConfig: controlPlane.getControlPlaneConfig,
  resolveRoutingPolicy: controlPlane.resolveRoutingPolicy,
}));

vi.mock("../src/ollama.js", () => ({
  expandQuery: vi.fn().mockResolvedValue(["variant 1", "variant 2"]),
}));

vi.mock("../src/domains.js", () => ({
  applyDomainFilters: vi.fn().mockImplementation((results) => results),
}));

vi.mock("../src/domain-db.js", () => ({
  normalizeHostname: () => "example.com",
  recordSearchAppearance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/observability.js", () => ({
  withSpan: vi.fn().mockImplementation((_name, _attributes, fn) => fn()),
}));

vi.mock("../src/provider-control.js", () => ({
  runSearxng: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock("../src/search-providers/index.js", () => ({
  hasUsefulPrimarySearch: hosted.hasUsefulPrimarySearch,
  describeHostedSearchAttempts: (
    attempts: Array<{ provider: string; outcome: string; error?: string }>,
  ) =>
    attempts
      .map(
        (attempt) =>
          `${attempt.provider}=${attempt.outcome}${attempt.error ? `: ${attempt.error}` : ""}`,
      )
      .join("; "),
  searchHostedFallback: hosted.searchHostedFallback,
  searchHostedFallbackWithAttempts: hosted.searchHostedFallbackWithAttempts,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { cacheGet, cacheSet } from "../src/cache.js";
import type { ResolvedRoutingPolicy } from "../src/control-plane/index.js";
import { expandQuery } from "../src/ollama.js";
import { searxSearch } from "../src/search.js";

const result = (url: string, engine = "google") => ({
  title: "Result",
  url,
  content: "snippet",
  engine,
  engines: [engine],
});

function searxResponse(
  results: unknown[],
  extras: Record<string, unknown> = {},
) {
  return new Response(JSON.stringify({ results, ...extras }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function routingPolicy(
  mode: ResolvedRoutingPolicy["mode"],
): ResolvedRoutingPolicy {
  switch (mode) {
    case "local_only":
      return {
        mode,
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: false,
          invocation: "never",
          withEngineFilter: false,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "local_first":
      return {
        mode,
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: true,
          invocation: "after_local_hard_failure_or_zero_usable_results",
          withEngineFilter: false,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "hybrid":
      return {
        mode,
        localSearch: { enabled: true },
        hostedSearch: {
          enabled: true,
          invocation: "sequential_supplement_or_fallback",
          withEngineFilter: false,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "hosted_only":
      return {
        mode,
        localSearch: { enabled: false },
        hostedSearch: {
          enabled: true,
          invocation: "primary",
          withEngineFilter: false,
        },
        offlineFetch: { enabled: false, liveNetworkAllowed: false },
      };
    case "offline_fetch_only":
      return {
        mode,
        localSearch: { enabled: false },
        hostedSearch: {
          enabled: false,
          invocation: "never",
          withEngineFilter: false,
        },
        offlineFetch: { enabled: true, liveNetworkAllowed: false },
      };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
  hosted.searchHostedFallback.mockReset();
  hosted.searchHostedFallbackWithAttempts.mockReset();
  delete process.env.HOSTED_SEARCH_FALLBACK_ENABLED;
  controlPlane.getControlPlaneConfig.mockReturnValue({ values: {} });
  controlPlane.resolveRoutingPolicy.mockReturnValue(
    routingPolicy("local_first"),
  );
  hosted.hasUsefulPrimarySearch.mockImplementation(
    (count: number, meta: { answers: unknown[]; infoboxes: unknown[] }) =>
      count >= 1 || meta.answers.length > 0 || meta.infoboxes.length > 0,
  );
  hosted.searchHostedFallback.mockResolvedValue(null);
  hosted.searchHostedFallbackWithAttempts.mockImplementation(
    async (request) => {
      const result = await hosted.searchHostedFallback(request);
      return {
        result,
        attempts: result?.attempts ?? [],
        enabled: true,
      };
    },
  );
});

describe("SearXNG hosted fallback policy", () => {
  it("does not call hosted search when SearXNG returns useful results", async () => {
    mockFetch.mockResolvedValueOnce(
      searxResponse([result("https://searx.test")]),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results[0].url).toBe("https://searx.test");
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("kill switch off + successful SearXNG behaves normally (no fallback attempt)", async () => {
    process.env.HOSTED_SEARCH_FALLBACK_ENABLED = "false";
    mockFetch.mockResolvedValueOnce(
      searxResponse([result("https://searx.test")]),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results[0].url).toBe("https://searx.test");
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("does not spend hosted quota when SearXNG has a direct answer", async () => {
    mockFetch.mockResolvedValueOnce(
      searxResponse([], { answers: ["direct answer"] }),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results).toEqual([]);
    expect(search.meta.answers).toEqual([{ answer: "direct answer" }]);
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("uses one hosted fallback when SearXNG returns no useful result", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch("query", "general", 5, "week");

    expect(hosted.searchHostedFallback).toHaveBeenCalledTimes(1);
    expect(hosted.searchHostedFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "query",
        category: "general",
        timeRange: "week",
      }),
    );
    expect(search.results[0].engine).toBe("exa");
    expect(cacheSet).toHaveBeenCalledOnce();
  });

  it("recovers from a SearXNG technical failure through hosted fallback", async () => {
    mockFetch.mockRejectedValueOnce(new Error("searx network down"));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://parallel.test", "parallel")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "parallel",
      attempts: [{ provider: "parallel", outcome: "hit" }],
    });

    await expect(searxSearch("query", "general", 5)).resolves.toMatchObject({
      results: [expect.objectContaining({ engine: "parallel" })],
    });
  });

  it("returns the sparse SearXNG result when every hosted fallback fails", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce(null);

    await expect(searxSearch("query", "general", 5)).resolves.toMatchObject({
      results: [],
    });
  });

  it("rethrows the SearXNG failure when no hosted provider succeeds", async () => {
    mockFetch.mockRejectedValueOnce(new Error("searx network down"));
    hosted.searchHostedFallback.mockResolvedValueOnce(null);

    await expect(searxSearch("query", "general", 5)).rejects.toThrow(
      "searx network down",
    );
  });

  it("reports hosted fallback attempts when primary and hosted search fail", async () => {
    mockFetch.mockRejectedValueOnce(new Error("searx network down"));
    hosted.searchHostedFallbackWithAttempts.mockResolvedValueOnce({
      result: null,
      attempts: [
        {
          provider: "tinyfish",
          outcome: "error",
          error: "TinyFish search error: 401 Unauthorized",
        },
      ],
      enabled: true,
    });

    await expect(searxSearch("query", "general", 5)).rejects.toThrow(
      "hosted fallback did not produce results (tinyfish=error: TinyFish search error: 401 Unauthorized)",
    );
  });

  it("preserves explicit engine constraints by suppressing hosted fallback", async () => {
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      "google",
    );

    expect(search.results).toEqual([]);
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("allows the resolved policy to opt into fallback despite an engine constraint", async () => {
    const policy = routingPolicy("local_first");
    controlPlane.resolveRoutingPolicy.mockReturnValue({
      ...policy,
      hostedSearch: {
        ...policy.hostedSearch,
        withEngineFilter: true,
      },
    });
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://brave.test", "brave")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "brave",
      attempts: [{ provider: "brave", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      undefined,
      undefined,
      "google",
    );

    expect(search.results[0].engine).toBe("brave");
  });

  it("allows hosted fallback only for the original expanded query", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("original SearXNG failed"))
      .mockRejectedValue(new Error("variant SearXNG failed"));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://exa.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      true,
    );

    expect(search.results[0].engine).toBe("exa");
    expect(hosted.searchHostedFallback).toHaveBeenCalledTimes(1);
  });
});

describe("Control Plane routing policy enforcement", () => {
  it("local_only never invokes hosted search after a local hard failure", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("local_only"),
    );
    mockFetch.mockRejectedValueOnce(new Error("local search unavailable"));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://hosted.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    await expect(searxSearch("query", "general", 5)).rejects.toThrow(
      "local search unavailable",
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("local_only never invokes hosted search after zero local results", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("local_only"),
    );
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://hosted.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch("query", "general", 5);

    expect(search.results).toEqual([]);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("local_first does not top up a weak but usable local result", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("local_first"),
    );
    hosted.hasUsefulPrimarySearch.mockReturnValue(false);
    mockFetch.mockResolvedValueOnce(
      searxResponse([result("https://local.test")]),
    );

    const search = await searxSearch("query", "general", 5);

    expect(search.results).toEqual([result("https://local.test")]);
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
  });

  it("local_first uses hosted search after zero usable local results", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("local_first"),
    );
    mockFetch.mockResolvedValueOnce(searxResponse([]));
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://hosted.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch("query", "general", 5);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(hosted.searchHostedFallback).toHaveBeenCalledOnce();
    expect(search.route).toEqual({ provider: "exa", fallback: true });
  });

  it("hybrid supplements weak local results sequentially without replacing local results or metadata", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(routingPolicy("hybrid"));
    hosted.hasUsefulPrimarySearch.mockReturnValue(false);
    const calls: string[] = [];
    const firstLocal = {
      ...result("https://local.test", "searxng"),
      title: "First local result",
      content: "local result metadata",
    };
    const duplicateLocal = {
      ...result("https://local.test", "other-local-engine"),
      title: "Duplicate local result",
    };
    const duplicateHosted = {
      ...result("https://local.test", "exa"),
      title: "Duplicate hosted result",
    };
    const uniqueHosted = {
      ...result("https://hosted.test", "exa"),
      title: "Unique hosted result",
    };
    mockFetch.mockImplementation(async () => {
      calls.push("local");
      return searxResponse([firstLocal, duplicateLocal], {
        answers: ["Local answer"],
        infoboxes: [
          {
            infobox: "Local infobox",
            content: "Local infobox content",
            urls: [{ url: "https://local-info.test" }],
          },
        ],
      });
    });
    hosted.searchHostedFallback.mockImplementation(async () => {
      calls.push("hosted");
      return {
        results: [duplicateHosted, uniqueHosted],
        meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
        provider: "exa",
        attempts: [{ provider: "exa", outcome: "hit" }],
      };
    });

    const search = await searxSearch("query", "general", 5);

    expect(calls).toEqual(["local", "hosted"]);
    expect(search.results).toEqual([firstLocal, uniqueHosted]);
    expect(search.meta).toEqual({
      answers: [{ answer: "Local answer" }],
      infoboxes: [
        {
          title: "Local infobox",
          content: "Local infobox content",
          url: "https://local-info.test",
        },
      ],
      corrections: [],
      suggestions: [],
    });
    expect(search.route).toEqual({ provider: "exa", fallback: true });
  });

  it("keeps hosted_only primary search behavior when an engine filter is present", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("hosted_only"),
    );
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://hosted.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      false,
      undefined,
      "google",
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(hosted.searchHostedFallback).toHaveBeenCalledOnce();
    expect(search.route).toEqual({ provider: "exa" });
  });

  it("hosted_only skips local search and uses hosted search as primary", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("hosted_only"),
    );
    hosted.searchHostedFallback.mockResolvedValueOnce({
      results: [result("https://hosted.test", "exa")],
      meta: { answers: [], infoboxes: [], corrections: [], suggestions: [] },
      provider: "exa",
      attempts: [{ provider: "exa", outcome: "hit" }],
    });

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      true,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(expandQuery).not.toHaveBeenCalled();
    expect(hosted.searchHostedFallback).toHaveBeenCalledOnce();
    expect(search.route).toEqual({ provider: "exa" });
  });

  it("offline_fetch_only returns a structured unavailable diagnostic without a live call", async () => {
    controlPlane.resolveRoutingPolicy.mockReturnValue(
      routingPolicy("offline_fetch_only"),
    );

    const search = await searxSearch(
      "query",
      "general",
      5,
      undefined,
      undefined,
      true,
    );

    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(expandQuery).not.toHaveBeenCalled();
    expect(hosted.searchHostedFallback).not.toHaveBeenCalled();
    expect(search).toMatchObject({
      results: [],
      diagnostic: {
        code: "offline_source_unavailable",
        mode: "offline_fetch_only",
      },
    });
  });
});
