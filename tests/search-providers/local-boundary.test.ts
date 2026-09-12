import { afterEach, describe, expect, it, vi } from "vitest";

const hostedFallback = vi.hoisted(() => ({
  search: vi.fn().mockResolvedValue({
    result: null,
    attempts: [{ provider: "test-hosted", outcome: "error" }],
    enabled: true,
  }),
}));

vi.mock("../../src/cache.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  searchCacheKey: vi.fn().mockReturnValue("local-provider-boundary"),
}));

vi.mock("../../src/domain-db.js", () => ({
  normalizeHostname: () => null,
  recordSearchAppearance: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/domains.js", () => ({
  applyDomainFilters: vi.fn().mockImplementation((results) => results),
}));

vi.mock("../../src/ollama.js", () => ({
  expandQuery: vi
    .fn()
    .mockResolvedValue([
      "local provider boundary variant one",
      "local provider boundary variant two",
    ]),
}));

vi.mock("../../src/search-providers/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/search-providers/index.js")
    >();
  return {
    ...actual,
    describeHostedSearchAttempts: () => "test-hosted=error",
    hasUsefulPrimarySearch: (
      resultsCount: number,
      meta: { answers: unknown[]; infoboxes: unknown[] },
    ) =>
      resultsCount > 0 || meta.answers.length > 0 || meta.infoboxes.length > 0,
    searchHostedFallbackWithAttempts: hostedFallback.search,
  };
});

import {
  localSearchProviderControlSnapshot,
  runLocalSearchProvider,
} from "../../src/provider-control.js";
import { searxSearch } from "../../src/search.js";
import {
  type LocalSearchProvider,
  type LocalSearchRequest,
  localSearchProvider,
  registerLocalSearchProvider,
  searchLocalProvider,
  setActiveLocalSearchProvider,
} from "../../src/search-providers/local.js";

const request: LocalSearchRequest = {
  query: "local provider boundary",
  category: "general",
  numResults: 3,
};

afterEach(() => {
  setActiveLocalSearchProvider("searxng");
  vi.restoreAllMocks();
});

describe("LocalSearchProvider boundary", () => {
  it("binds the active local registry to the existing SearXNG provider identity", () => {
    expect(localSearchProvider.id).toBe("searxng");
    expect(localSearchProvider.capabilities).toMatchObject({
      categoryFilter: true,
      timeRangeFilter: true,
      languageFilter: true,
      engineFilter: true,
      siteFilter: true,
      engineMetadata: true,
    });
  });

  it("routes Core-facing requests through the active local provider", async () => {
    const search = vi.spyOn(localSearchProvider, "search").mockResolvedValue({
      items: [],
    });

    await expect(searchLocalProvider(request)).resolves.toMatchObject({
      items: [],
    });
    expect(search).toHaveBeenCalledWith(request);
  });

  it("uses the local provider boundary from the Core search route", async () => {
    const search = vi.spyOn(localSearchProvider, "search").mockResolvedValue({
      items: [{ title: "Local result", url: "https://local.test" }],
      metadata: { engineNames: [] },
    });

    await expect(
      searxSearch(
        "local provider boundary",
        "general",
        3,
        undefined,
        undefined,
        false,
      ),
    ).resolves.toMatchObject({
      route: { provider: "searxng" },
      results: [{ url: "https://local.test" }],
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "local provider boundary",
        category: "general",
        numResults: 9,
      }),
    );
  });

  it("registers a non-SearX-shaped provider for original and expanded Core requests", async () => {
    const alternateProvider: LocalSearchProvider<"memory-local"> = {
      id: "memory-local",
      displayName: "Memory index",
      capabilities: {
        categoryFilter: false,
        timeRangeFilter: false,
        languageFilter: false,
        engineFilter: false,
        siteFilter: false,
        directAnswerMetadata: true,
        knowledgeCardMetadata: true,
        queryCorrectionMetadata: false,
        querySuggestionMetadata: false,
        engineMetadata: false,
      },
      search: vi.fn().mockImplementation((localRequest) =>
        runLocalSearchProvider(
          "memory-local",
          localRequest.query,
          async () => ({
            items: [
              {
                title: "Indexed local result",
                url: `https://memory.test/${encodeURIComponent(localRequest.query)}`,
                snippet: "A provider-neutral snippet",
                publishedAt: "2026-09-12",
              },
            ],
            metadata: {
              directAnswers: [{ text: "Indexed direct answer" }],
              knowledgeCards: [
                {
                  title: "Indexed card",
                  text: "A provider-neutral knowledge card",
                },
              ],
              engineNames: ["memory-engine"],
            },
          }),
        ),
      ),
    };
    registerLocalSearchProvider(alternateProvider);
    setActiveLocalSearchProvider("memory-local");

    const result = await searxSearch(
      "local provider boundary",
      "general",
      3,
      undefined,
      undefined,
      true,
      undefined,
      "google,brave",
      "example.com",
    );

    expect(alternateProvider.search).toHaveBeenCalledTimes(3);
    expect(alternateProvider.search).toHaveBeenNthCalledWith(1, {
      query: "local provider boundary",
      numResults: 9,
    });
    expect(alternateProvider.search).toHaveBeenNthCalledWith(2, {
      query: "local provider boundary variant one",
      numResults: 9,
    });
    expect(alternateProvider.search).toHaveBeenNthCalledWith(3, {
      query: "local provider boundary variant two",
      numResults: 9,
    });
    expect(result.results).toEqual(
      expect.arrayContaining([
        {
          title: "Indexed local result",
          url: "https://memory.test/local%20provider%20boundary",
          content: "A provider-neutral snippet",
          publishedDate: "2026-09-12",
        },
      ]),
    );
    expect(result).toMatchObject({
      meta: {
        answers: [{ answer: "Indexed direct answer" }],
        infoboxes: [
          {
            title: "Indexed card",
            content: "A provider-neutral knowledge card",
          },
        ],
        corrections: [],
        suggestions: [],
      },
      route: { provider: "memory-local" },
    });
    expect(result.route).not.toHaveProperty("engines");
  });

  it("allows hosted fallback when the active provider cannot apply an engine filter", async () => {
    const alternateProvider: LocalSearchProvider<"memory-empty"> = {
      id: "memory-empty",
      capabilities: {
        categoryFilter: false,
        timeRangeFilter: false,
        languageFilter: false,
        engineFilter: false,
        siteFilter: false,
        directAnswerMetadata: false,
        knowledgeCardMetadata: false,
        queryCorrectionMetadata: false,
        querySuggestionMetadata: false,
        engineMetadata: false,
      },
      search: vi.fn().mockResolvedValue({ items: [] }),
    };
    hostedFallback.search.mockResolvedValueOnce({
      result: {
        results: [{ title: "Hosted result", url: "https://hosted.test" }],
        meta: {
          answers: [],
          infoboxes: [],
          corrections: [],
          suggestions: [],
        },
        provider: "brave",
        attempts: [],
      },
      attempts: [],
      enabled: true,
    });
    registerLocalSearchProvider(alternateProvider);
    setActiveLocalSearchProvider("memory-empty");

    await expect(
      searxSearch(
        "local provider boundary",
        "general",
        3,
        undefined,
        undefined,
        false,
        undefined,
        "google,brave",
      ),
    ).resolves.toMatchObject({
      results: [{ url: "https://hosted.test" }],
      route: { provider: "brave", fallback: true },
    });
    expect(alternateProvider.search).toHaveBeenCalledWith({
      query: "local provider boundary",
      numResults: 9,
    });
    expect(hostedFallback.search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "local provider boundary",
        numResults: 9,
      }),
    );
  });

  it("keeps local provider control state isolated by provider identity", async () => {
    const failingProvider = "local-control-alpha";
    const untouchedProvider = "local-control-beta";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        runLocalSearchProvider(
          failingProvider,
          `failure-${attempt}`,
          async () => {
            throw new Error("local provider failure");
          },
        ),
      ).rejects.toThrow("local provider failure");
    }

    expect(
      localSearchProviderControlSnapshot(failingProvider).circuit,
    ).toMatchObject({
      state: "open",
      consecutiveFailures: 5,
    });
    expect(
      localSearchProviderControlSnapshot(untouchedProvider).circuit,
    ).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("does not add SearXNG text to a non-SearX provider failure", async () => {
    const alternateProvider: LocalSearchProvider<"memory-error"> = {
      id: "memory-error",
      displayName: "Memory index",
      capabilities: {
        categoryFilter: false,
        timeRangeFilter: false,
        languageFilter: false,
        engineFilter: false,
        siteFilter: false,
        directAnswerMetadata: false,
        knowledgeCardMetadata: false,
        queryCorrectionMetadata: false,
        querySuggestionMetadata: false,
        engineMetadata: false,
      },
      search: vi.fn().mockRejectedValue(new Error("Memory index unavailable")),
    };
    registerLocalSearchProvider(alternateProvider);
    setActiveLocalSearchProvider("memory-error");

    try {
      await searxSearch("local provider boundary", "general", 3);
      throw new Error("Expected the local provider failure to be rethrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Memory index search failed (Memory index unavailable); hosted fallback did not produce results (test-hosted=error)",
      );
      expect((error as Error).message).not.toContain("SearXNG");
    }
  });
});
