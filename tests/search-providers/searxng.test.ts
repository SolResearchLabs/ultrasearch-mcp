import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerControl = vi.hoisted(() => ({
  runSearxng: vi.fn(
    async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
  ),
}));

const observability = vi.hoisted(() => ({
  withSpan: vi.fn(
    async <T>(
      _name: string,
      _attributes: Record<string, unknown>,
      fn: () => Promise<T>,
    ): Promise<T> => fn(),
  ),
}));

vi.mock("../../src/config.js", () => ({
  SEARXNG_URL: "http://127.0.0.1:8099",
}));

vi.mock("../../src/observability.js", () => ({
  withSpan: observability.withSpan,
}));

vi.mock("../../src/provider-control.js", () => ({
  runSearxng: providerControl.runSearxng,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  searxngSearchProvider,
  searxSearchSingle,
} from "../../src/search-providers/searxng.js";

function response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SearXNG local search provider", () => {
  it("preserves the SearXNG request, normalized metadata, and route provenance", async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        results: [
          {
            title: "First result",
            url: "https://first.test",
            engines: ["Google", "DuckDuckGo"],
          },
          {
            title: "Second result",
            url: "https://second.test",
            engine: "Bing",
          },
        ],
        answers: ["42"],
        infoboxes: [
          {
            infobox: "Answer",
            content: "The answer",
            urls: [{ url: "https://answer.test" }],
          },
        ],
        corrections: ["query correction"],
        suggestions: ["related query"],
      }),
    );

    const result = await searxngSearchProvider.search({
      query: "provider boundary",
      category: "general",
      numResults: 1,
      timeRange: "week",
      language: "en",
      engineFilter: "google,duckduckgo",
      siteFilter: ["example.com", "docs.example.com"],
    });

    expect(searxngSearchProvider.id).toBe("searxng");
    expect(providerControl.runSearxng).toHaveBeenCalledWith(
      JSON.stringify([
        "provider boundary",
        "general",
        1,
        "week",
        "en",
        "google,duckduckgo",
        ["example.com", "docs.example.com"],
      ]),
      expect.any(Function),
    );
    expect(observability.withSpan).toHaveBeenCalledWith(
      "searxng_request",
      { "search.category": "general", "search.time_range": "week" },
      expect.any(Function),
    );

    const requestUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe(
      "http://127.0.0.1:8099/search",
    );
    expect(requestUrl.searchParams.get("q")).toBe(
      "(site:example.com OR site:docs.example.com) provider boundary",
    );
    expect(requestUrl.searchParams.get("format")).toBe("json");
    expect(requestUrl.searchParams.get("categories")).toBe("general");
    expect(requestUrl.searchParams.get("pageno")).toBe("1");
    expect(requestUrl.searchParams.get("time_range")).toBe("week");
    expect(requestUrl.searchParams.get("language")).toBe("en");
    expect(requestUrl.searchParams.get("engines")).toBe("google,duckduckgo");
    expect(result).toEqual({
      items: [
        {
          title: "First result",
          url: "https://first.test",
          sources: ["Google", "DuckDuckGo"],
        },
      ],
      metadata: {
        directAnswers: [{ text: "42" }],
        knowledgeCards: [
          {
            title: "Answer",
            text: "The answer",
            url: "https://answer.test",
          },
        ],
        queryCorrections: ["query correction"],
        querySuggestions: ["related query"],
        engineNames: ["Google", "DuckDuckGo"],
      },
    });
  });

  it("maps the neutral adapter result back to the existing SearXNG helper output", async () => {
    mockFetch.mockResolvedValueOnce(
      response({
        results: [
          {
            title: "First result",
            url: "https://first.test",
            engine: "Google",
          },
        ],
        answers: ["42"],
      }),
    );

    await expect(
      searxSearchSingle("provider boundary", "general", 5),
    ).resolves.toEqual({
      results: [
        {
          title: "First result",
          url: "https://first.test",
          engine: "Google",
        },
      ],
      meta: {
        answers: [{ answer: "42" }],
        infoboxes: [],
        corrections: [],
        suggestions: [],
      },
      route: {
        provider: "searxng",
        engines: ["Google"],
      },
    });
  });

  it("keeps the existing SearXNG HTTP error shape and compatibility helper", async () => {
    mockFetch.mockResolvedValueOnce(
      response(
        { results: [] },
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "3" },
        },
      ),
    );

    await expect(
      searxSearchSingle("provider boundary", "general", 5),
    ).rejects.toMatchObject({
      provider: "searxng",
      status: 429,
      message: "SearXNG error: 429 Too Many Requests",
      retryAfterMs: 3_000,
    });
  });
});
