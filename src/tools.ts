import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type * as ToolHandlers from "./tool-handlers.js";
import { CategorySchema, TimeRangeSchema } from "./types.js";

type HandlerModule = typeof ToolHandlers;

const loadHandlers = () => import("./tool-handlers.js");

export const handleSearch: HandlerModule["handleSearch"] = async (args) =>
  (await loadHandlers()).handleSearch(args);

export const handleSearchAndFetch: HandlerModule["handleSearchAndFetch"] =
  async (args) => (await loadHandlers()).handleSearchAndFetch(args);

export const handleSearchAndSummarize: HandlerModule["handleSearchAndSummarize"] =
  async (args) => (await loadHandlers()).handleSearchAndSummarize(args);

export const handleFetchUrl: HandlerModule["handleFetchUrl"] = async (args) =>
  (await loadHandlers()).handleFetchUrl(args);

export const handleCrawlSite: HandlerModule["handleCrawlSite"] = async (args) =>
  (await loadHandlers()).handleCrawlSite(args);

export const handleClearCache: HandlerModule["handleClearCache"] = async (
  args,
) => (await loadHandlers()).handleClearCache(args);

export const handleDomainStats: HandlerModule["handleDomainStats"] = async (
  args,
) => (await loadHandlers()).handleDomainStats(args);

const DomainProfileSchema = z
  .string()
  .optional()
  .describe(
    "Named domain profile to apply: 'homelab', 'dev', or omit for default filters",
  );

const TierStatsOutputSchema = z.object({
  attempts: z.number(),
  ok: z.number(),
  fail: z.number(),
  success_rate: z.number().nullable(),
});

const AllTiersOutputSchema = z.object({
  tier1: TierStatsOutputSchema,
  tier2: TierStatsOutputSchema,
  tier3: TierStatsOutputSchema,
  tier4: TierStatsOutputSchema,
  github: TierStatsOutputSchema,
});

const SingleDomainOutputSchema = z.object({
  domain: z.string(),
  first_seen: z.string(),
  last_fetch: z.string(),
  preferred_strategy: z.string().nullable(),
  tiers: AllTiersOutputSchema,
  capabilities: z.object({
    llms_full_txt: z.boolean(),
    robots_allows_us: z.boolean().nullable(),
    metadata_fetch_rate: z.number().nullable(),
    seen_in_search: z.number(),
  }),
});

const AggregateOutputSchema = z.object({
  domains_tracked: z.number(),
  seen_never_fetched: z.number(),
  tiers: AllTiersOutputSchema,
  failing_count: z.number(),
  top_failing: z.array(
    z.object({
      domain: z.string(),
      attempts: z.number(),
      ok: z.number(),
      success_rate: z.number(),
    }),
  ),
  truncated: z.boolean(),
});

const DomainStatsOutputSchema = z.object({
  mode: z.enum(["single", "aggregate"]),
  hostname: z.string().nullable(),
  found: z.boolean(),
  record: SingleDomainOutputSchema.nullable(),
  aggregate: AggregateOutputSchema.nullable(),
});

const LanguageSchema = z
  .string()
  .optional()
  .describe(
    "BCP-47 language code (e.g. 'en', 'de') or 'all' for all languages. Omit to use the SearXNG instance default.",
  );

const EnginesSchema = z
  .string()
  .optional()
  .describe(
    "Comma-separated SearXNG engine names to restrict the search to (e.g. 'google,duckduckgo'). Forwarded verbatim; unknown/disabled engines degrade to fewer results rather than erroring.",
  );

const SiteSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe(
    "Restrict results to one domain or a list of domains (e.g. 'github.com'). Best-effort - applied as a site: query operator; most engines honor it but some ignore it.",
  );

// Provenance for the research route badge. The enums mirror the SearchRoute /
// FetchRoute unions in types.ts - the SDK strictly validates the search tool's
// structuredContent against SearchOutputSchema, so a mismatch throws.
const SearchProviderSchema = z.enum([
  "searxng",
  "exa",
  "parallel",
  "tinyfish",
  "brave",
  "cache",
]);
const FetchProviderSchema = z.enum([
  "cloudflare",
  "crawl4ai",
  "raw",
  "wayback",
  "github",
  "llms_full_txt",
  "kiwix",
  "hister",
  "youtube",
  "reddit",
  "cache",
]);
const SearchRouteSchema = z.object({
  provider: SearchProviderSchema,
  engines: z.array(z.string()).optional(),
  fallback: z.boolean().optional(),
  cacheHit: z.boolean().optional(),
});
const FetchRouteSchema = z.object({
  provider: FetchProviderSchema,
  fallback: z.boolean().optional(),
  cacheHit: z.boolean().optional(),
  also: z.array(FetchProviderSchema).optional(),
});
const ResearchRouteSchema = z.object({
  search: SearchRouteSchema.optional(),
  fetch: FetchRouteSchema.optional(),
});

// Output schema for the `search` tool - surfaces SearXNG's native answers /
// infoboxes / corrections / suggestions alongside a minimal result list so
// callers can check for a direct answer programmatically.
const SearchOutputSchema = z.object({
  answers: z.array(
    z.object({ answer: z.string(), url: z.string().nullable() }),
  ),
  infoboxes: z.array(
    z.object({
      title: z.string(),
      content: z.string(),
      url: z.string().nullable(),
    }),
  ),
  corrections: z.array(z.string()),
  suggestions: z.array(z.string()),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string().nullable(),
    }),
  ),
  researchRoute: ResearchRouteSchema.optional(),
});

export function registerTools(server: McpServer): void {
  server.registerTool(
    "search",
    {
      title: "Web search",
      description:
        "Search the web via the local SearXNG instance with reranking. Fetches a wider result pool from SearXNG, reranks by relevance using a local ML model, then returns the top results. SearXNG's native direct answers, infoboxes, spelling corrections, and related-search suggestions are surfaced above the list (and in structuredContent). Results are cached for 1 hour. Blocked domains are filtered out; boosted domains are surfaced higher. Prefer this over the built-in WebSearch tool.",
      inputSchema: {
        query: z.string().describe("Search query"),
        num_results: z.coerce
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe("Number of results to return (default 5, max 20)"),
        category: CategorySchema.describe(
          "Search category: general, news, it, or science (default general)",
        ),
        time_range: TimeRangeSchema.describe(
          "Limit results to: day, week, month, or year (omit for all time)",
        ),
        domain_profile: DomainProfileSchema,
        expand: z.coerce
          .boolean()
          .optional()
          .describe(
            "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency; most useful for research queries where one phrasing may miss relevant results.",
          ),
        language: LanguageSchema,
        engines: EnginesSchema,
        site: SiteSchema,
      },
      outputSchema: SearchOutputSchema,
    },
    handleSearch,
  );

  server.tool(
    "search_and_fetch",
    "Search the web, rerank results, then fetch the full content of the top result(s). GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Results and fetched pages are cached. Blocked domains are filtered. Returns the result list plus clean markdown of the fetched pages.",
    {
      query: z.string().describe("Search query"),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(3)
        .default(1)
        .describe(
          "Number of top results to fetch full content for (default 1, max 3)",
        ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe(
          "Use local LLM to generate 2-3 query variants and merge results for a wider search surface (default: off). Adds ~3s latency.",
        ),
      language: LanguageSchema,
      engines: EnginesSchema,
      site: SiteSchema,
    },
    handleSearchAndFetch,
  );

  server.tool(
    "fetch_url",
    "Fetch and extract readable content from any URL. GitHub URLs are fetched via the GitHub API; all others go through a fetch cascade: Firecrawl → Crawl4AI → raw HTTP. Returns clean markdown where possible. Content is trimmed to a token budget (default ~2000 tokens / 8000 chars; raise with max_tokens). Results cached for 24 hours. Blocked domains and private/internal addresses are refused.",
    {
      url: z.string().url().describe("URL to fetch and extract content from"),
      domain_profile: DomainProfileSchema,
      max_tokens: z.coerce
        .number()
        .int()
        .min(100)
        .max(10000)
        .optional()
        .describe(
          "Approximate token budget for the returned content (chars ≈ tokens × 4). Omit for the ~2000-token / 8000-char default; max 10000 tokens.",
        ),
      target_selector: z
        .string()
        .max(500)
        .optional()
        .describe(
          "CSS selector to scope extraction to a specific element (e.g. 'article', 'main .content'). Honored by Firecrawl/Crawl4AI and applied client-side on the raw-HTTP tier; ignored by fast paths and if it matches nothing.",
        ),
      wait_for_selector: z
        .string()
        .max(500)
        .optional()
        .describe(
          "CSS selector to wait for before extracting, for JS-rendered pages. Honored by the rendering tiers (Firecrawl/Crawl4AI); ignored on raw HTTP (no JS).",
        ),
    },
    handleFetchUrl,
  );

  server.tool(
    "search_and_summarize",
    "Search, rerank, fetch top results, then synthesize a summary with citations using a local LLM (qwen3:14b). Returns a structured answer with source attribution. Falls back to raw fetched content if Ollama is unavailable. Best for deep research where you want pre-digested synthesis rather than raw pages.",
    {
      query: z.string().describe("Research query to search for and summarize"),
      fetch_count: z.coerce
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe(
          "Number of top results to fetch and synthesize (default 3, max 5)",
        ),
      category: CategorySchema.describe(
        "Search category: general, news, it, or science (default general)",
      ),
      time_range: TimeRangeSchema.describe(
        "Limit results to: day, week, month, or year (omit for all time)",
      ),
      domain_profile: DomainProfileSchema,
      expand: z.coerce
        .boolean()
        .optional()
        .describe("Use query expansion before searching (default: off)"),
      language: LanguageSchema,
      engines: EnginesSchema,
      site: SiteSchema,
    },
    handleSearchAndSummarize,
  );

  server.tool(
    "crawl_site",
    "Crawl a site and return a manifest of pages with titles and snippets. " +
      "Full page content is cached - call fetch_url on any page URL for the full text. " +
      "Strategy: Firecrawl (JS rendering) → sitemap-first → BFS (if enabled).",
    {
      url: z.string().url().describe("Base URL to crawl"),
      max_pages: z.coerce
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum pages to crawl (default 20, max 100)"),
      same_domain_only: z.coerce
        .boolean()
        .default(true)
        .describe("Restrict crawl to the same domain (default true)"),
      include_path: z
        .string()
        .optional()
        .describe("Only include URLs matching this path prefix (e.g. '/docs')"),
      exclude_path: z
        .string()
        .optional()
        .describe("Exclude URLs matching this path prefix (e.g. '/blog')"),
    },
    handleCrawlSite,
  );

  server.tool(
    "clear_cache",
    "Purge the search and/or fetch result cache. Useful when researching fast-moving topics where cached results from the past hour may be stale.",
    {
      target: z
        .enum(["search", "fetch", "crawl", "all"])
        .default("all")
        .describe(
          "Which cache to clear: search results, fetched pages, crawl manifests, or all (default all)",
        ),
    },
    handleClearCache,
  );

  server.registerTool(
    "domain_stats",
    {
      title: "Domain capability stats",
      description:
        "Read the ultrasearch-mcp domain capability database - what it has learned about hosts from fetches: per-tier success rates (tier1-3 cascade, tier4 wayback, github fast path), llms.txt/robots presence, metadata reachability, and search appearances. Provide `hostname` for one domain's record, or omit it for an aggregate across all tracked domains (per-tier success rates, worst failing domains, seen-but-never-fetched count). Read-only. Aggregate mode reports `truncated: true` if the internal scan cap is hit.",
      inputSchema: {
        hostname: z
          .string()
          .optional()
          .describe(
            "Hostname or URL to look up (e.g. 'docs.anthropic.com'). Omit for an aggregate over all tracked domains.",
          ),
      },
      outputSchema: DomainStatsOutputSchema,
    },
    handleDomainStats,
  );
}
