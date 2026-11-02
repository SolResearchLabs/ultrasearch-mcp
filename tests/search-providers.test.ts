import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/search-providers/control.js", () => ({
  runHostedSearchProvider: async <T>(
    _provider: string,
    _key: string,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { braveSearchProvider } from "../src/search-providers/brave.js";
import { deepseekSearchProvider } from "../src/search-providers/deepseek.js";
import { exaSearchProvider } from "../src/search-providers/exa.js";
import { parallelSearchProvider } from "../src/search-providers/parallel.js";
import { tavilySearchProvider } from "../src/search-providers/tavily.js";
import { tinyfishSearchProvider } from "../src/search-providers/tinyfish.js";
import { youSearchProvider } from "../src/search-providers/you.js";

const originalEnv = { ...process.env };

// The providers read the canonical `ULTRASEARCH_*` alias before the plain
// variable this suite pins (`providerApiKey`/`providerOption`), so an ambient
// export would shadow every synthetic value below. Each test therefore removes
// the conflicting ambient names; `afterEach` restores the captured process
// environment exactly (FP-006 posture-independence pattern).
const AMBIENT_SHADOWING_NAMES = [
  "ULTRASEARCH_EXA_API_KEY",
  "ULTRASEARCH_EXA_SEARCH_TYPE",
  "ULTRASEARCH_PARALLEL_API_KEY",
  "ULTRASEARCH_PARALLEL_SEARCH_MODE",
  "ULTRASEARCH_TINYFISH_API_KEY",
  "ULTRASEARCH_TINYFISH_LOCATION",
  "ULTRASEARCH_BRAVE_API_KEY",
  "BRAVE_API_KEY",
  "ULTRASEARCH_TAVILY_API_KEY",
  "ULTRASEARCH_YOU_API_KEY",
  "ULTRASEARCH_DEEPSEEK_API_KEY",
  "ULTRASEARCH_DEEPSEEK_SEARCH_NEED_CONTENT",
  "YOU_API_KEY",
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of AMBIENT_SHADOWING_NAMES) delete process.env[name];
  process.env.EXA_API_KEY = "exa-test";
  process.env.PARALLEL_API_KEY = "parallel-test";
  process.env.TINYFISH_API_KEY = "tinyfish-test";
  process.env.BRAVE_SEARCH_API_KEY = "brave-test";
  process.env.TAVILY_API_KEY = "tavily-test";
  process.env.YDC_API_KEY = "you-test";
  process.env.DEEPSEEK_API_KEY = "deepseek-test";
  delete process.env.EXA_SEARCH_TYPE;
  delete process.env.PARALLEL_SEARCH_MODE;
  delete process.env.TINYFISH_SEARCH_LOCATION;
  delete process.env.DEEPSEEK_SEARCH_NEED_CONTENT;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("Exa hosted search", () => {
  it("maps domains, recency, news category and highlights", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Exa result",
            url: "https://example.com/exa",
            publishedDate: "2026-08-12T00:00:00.000Z",
            highlights: ["first highlight", "second highlight"],
          },
        ],
      }),
    );

    const results = await exaSearchProvider.search({
      query: "latest browser rendering",
      numResults: 5,
      category: "news",
      timeRange: "week",
      site: ["example.com", "docs.example.com"],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.exa.ai/search");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "exa-test",
    });
    const body = JSON.parse(String(options.body));
    expect(body.query).toBe("latest browser rendering");
    expect(body.numResults).toBe(5);
    expect(body.type).toBe("auto");
    expect(body.category).toBe("news");
    expect(body.includeDomains).toEqual(["example.com", "docs.example.com"]);
    expect(body.startPublishedDate).toBeDefined();
    expect(body.contents).toEqual({ highlights: true });
    expect(results[0]).toMatchObject({
      url: "https://example.com/exa",
      engine: "exa",
      content: "first highlight\nsecond highlight",
    });
  });
});

describe("Parallel hosted search", () => {
  it("uses v1 search, strict source policy and normalized excerpts", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Parallel result",
            url: "https://example.com/parallel",
            publish_date: "2026-08-11",
            excerpts: ["excerpt one", "excerpt two"],
          },
        ],
      }),
    );

    const results = await parallelSearchProvider.search({
      query: "browser rendering update",
      numResults: 4,
      category: "news",
      timeRange: "day",
      site: "example.com",
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.parallel.ai/v1/search",
    );
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "parallel-test",
    });
    const body = JSON.parse(String(options.body));
    expect(body.search_queries).toEqual(["browser rendering update"]);
    expect(body.mode).toBe("basic");
    expect(body.max_chars_total).toBe(4800);
    expect(body.objective).toContain("current news");
    expect(body.advanced_settings.max_results).toBe(4);
    expect(body.advanced_settings.source_policy.include_domains).toEqual([
      "example.com",
    ]);
    expect(body.advanced_settings.source_policy.after_date).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(results[0]).toMatchObject({
      url: "https://example.com/parallel",
      engine: "parallel",
      content: "excerpt one\nexcerpt two",
      publishedDate: "2026-08-11",
    });
  });

  it("accepts the current advanced mode override", async () => {
    process.env.PARALLEL_SEARCH_MODE = "advanced";
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await parallelSearchProvider.search({
      query: "complex research",
      numResults: 5,
      category: "general",
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.mode).toBe("advanced");
  });
});

describe("TinyFish hosted search", () => {
  it("maps domains, language, freshness, news category and snippets", async () => {
    process.env.TINYFISH_SEARCH_LOCATION = "CA";
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            position: 1,
            site_name: "example.com",
            title: "TinyFish result",
            snippet: "tinyfish snippet",
            url: "https://example.com/tinyfish",
            date: "2026-08-12",
            publisher: "Example Publisher",
          },
        ],
        total_results: 1,
        page: 0,
      }),
    );

    const results = await tinyfishSearchProvider.search({
      query: "browser rendering update",
      numResults: 3,
      category: "news",
      timeRange: "week",
      language: "en-CA",
      site: ["example.com", "docs.example.com"],
    });

    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(`${calledUrl.origin}${calledUrl.pathname}`).toBe(
      "https://api.search.tinyfish.ai/",
    );
    expect(calledUrl.searchParams.get("query")).toBe(
      "browser rendering update",
    );
    expect(calledUrl.searchParams.get("page")).toBe("0");
    expect(calledUrl.searchParams.get("domain_type")).toBe("news");
    expect(calledUrl.searchParams.get("include_domains")).toBe(
      "example.com,docs.example.com",
    );
    expect(calledUrl.searchParams.get("location")).toBe("CA");
    expect(calledUrl.searchParams.get("language")).toBe("en");
    expect(calledUrl.searchParams.get("recency_minutes")).toBe("10080");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      Accept: "application/json",
      "X-API-Key": "tinyfish-test",
    });
    expect(results[0]).toMatchObject({
      title: "TinyFish result",
      url: "https://example.com/tinyfish",
      engine: "tinyfish",
      engines: ["tinyfish"],
      content: "tinyfish snippet",
      publishedDate: "2026-08-12",
    });
  });
});

describe("Brave hosted search", () => {
  it("maps site, language, freshness and snippets", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        web: {
          results: [
            {
              title: "Brave result",
              url: "https://example.com/brave",
              description: "main snippet",
              extra_snippets: ["extra one", "extra two"],
              page_age: "2026-08-12T00:00:00Z",
            },
          ],
        },
      }),
    );

    const results = await braveSearchProvider.search({
      query: "browser rendering",
      numResults: 7,
      category: "general",
      timeRange: "month",
      language: "en-CA",
      site: "example.com",
    });

    const calledUrl = new URL(mockFetch.mock.calls[0][0] as string);
    expect(`${calledUrl.origin}${calledUrl.pathname}`).toBe(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(calledUrl.searchParams.get("q")).toBe(
      "site:example.com browser rendering",
    );
    expect(calledUrl.searchParams.get("count")).toBe("7");
    expect(calledUrl.searchParams.get("freshness")).toBe("pm");
    expect(calledUrl.searchParams.get("search_lang")).toBe("en");
    expect(calledUrl.searchParams.get("result_filter")).toBe("web");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      Accept: "application/json",
      "X-Subscription-Token": "brave-test",
    });
    expect(results[0]).toMatchObject({
      url: "https://example.com/brave",
      engine: "brave",
      content: "main snippet\nextra one\nextra two",
      publishedDate: "2026-08-12T00:00:00Z",
    });
  });
});

describe("Tavily hosted search", () => {
  it("uses basic search without answer or raw-content spend", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            title: "Tavily result",
            url: "https://example.com/tavily",
            content: "tavily snippet",
            published_date: "2026-10-31",
          },
        ],
      }),
    );

    const results = await tavilySearchProvider.search({
      query: "BC real estate regulation",
      numResults: 6,
      category: "news",
      timeRange: "week",
      site: ["example.com", "docs.example.com"],
    });

    expect(mockFetch.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      Authorization: "Bearer tavily-test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      query: "BC real estate regulation",
      search_depth: "basic",
      max_results: 6,
      include_answer: false,
      include_raw_content: false,
      topic: "news",
      time_range: "week",
      include_domains: ["example.com", "docs.example.com"],
    });
    expect(results[0]).toMatchObject({
      url: "https://example.com/tavily",
      engine: "tavily",
      content: "tavily snippet",
      publishedDate: "2026-10-31",
    });
  });
});

describe("You.com hosted search", () => {
  it("requests web snippets without extraction and normalizes results", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: {
          web: [
            {
              title: "You result",
              url: "https://example.com/you",
              description: "description",
              snippets: ["snippet one", "snippet two"],
              page_age: "2026-10-30T00:00:00Z",
            },
          ],
        },
      }),
    );

    const results = await youSearchProvider.search({
      query: "BCFSA guidance",
      numResults: 8,
      category: "general",
      timeRange: "month",
      language: "en-CA",
      site: "example.com",
    });

    expect(mockFetch.mock.calls[0][0]).toBe("https://ydc-index.io/v1/search");
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      "X-API-Key": "you-test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(options.body));
    expect(body).toMatchObject({
      query: "BCFSA guidance",
      count: 8,
      freshness: "month",
      language: "EN-CA",
      include_domains: ["example.com"],
    });
    expect(results[0]).toMatchObject({
      url: "https://example.com/you",
      engine: "you",
      content: "snippet one\nsnippet two",
      publishedDate: "2026-10-30T00:00:00Z",
    });
  });
});

describe("DeepSeek hosted search", () => {
  it("uses the low-cost search API, keeps page content off, and maps ranked summaries", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            rerank_score: 0.95,
            title: "DeepSeek result",
            url: "https://example.com/deepseek",
            snippet: "short snippet",
            summary: "model-readable summary",
            content: "",
            date: "2026-10-29",
            authority: 0.9,
          },
        ],
      }),
    );

    const results = await deepseekSearchProvider.search({
      query: "BCFSA artificial intelligence guidance",
      numResults: 50,
      category: "general",
      timeRange: "month",
      language: "en-CA",
      site: "example.com",
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.deepseek.com/v1/tools/search",
    );
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.headers).toMatchObject({
      Authorization: "Bearer deepseek-test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(options.body));
    expect(body.count).toBe(50);
    expect(body.need_content).toBe(false);
    expect(body.query).toContain("site:example.com");
    expect(body.query).toContain("lang:en");
    expect(body.query).toMatch(/after:\d{4}-\d{2}-\d{2}/);
    expect(body.query.length).toBeLessThanOrEqual(128);
    expect(results[0]).toMatchObject({
      url: "https://example.com/deepseek",
      engine: "deepseek",
      content: "model-readable summary",
      publishedDate: "2026-10-29",
    });
  });
});
