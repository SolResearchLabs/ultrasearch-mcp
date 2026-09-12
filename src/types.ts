import { z } from "zod";
import type { LocalSearchProviderId } from "./config/schema.js";

export interface DomainProfile {
  boost?: string[];
  block?: string[];
}

export type TierSlot = "tier1" | "tier2" | "tier3";

export interface DomainConfig {
  boost: string[];
  block: string[];
  llms_txt?: string[];
  tier_skip?: Record<string, TierSlot[]>;
  // Per-domain adblock bypass. v1 only carries the schema slot - Firecrawl
  // does not forward custom headers to the puppeteer-service, so the
  // X-Disable-Adblock signaling described in the build plan can't be wired
  // yet. Tracked in scope-creep.md.
  adblock_skip?: string[];
  profiles: Record<string, DomainProfile>;
}

export interface SearxResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  engines?: string[];
  publishedDate?: string;
}

// SearXNG's raw JSON carries these alongside `results`. Their shapes vary a bit
// across versions (answers/corrections have been both strings and objects), so
// the raw types below are permissive and normalizeSearxMeta() collapses them.
export interface SearxResponse {
  results: SearxResult[];
  answers?: Array<string | { answer?: string; content?: string; url?: string }>;
  infoboxes?: Array<{
    infobox?: string;
    content?: string;
    urls?: Array<{ url?: string; title?: string }>;
  }>;
  corrections?: Array<string | { title?: string; url?: string }>;
  suggestions?: string[];
}

// Normalized, caller-facing shapes for the surfaced meta.
export interface SearxAnswer {
  answer: string;
  url?: string;
}

export interface SearxInfobox {
  title: string;
  content: string;
  url?: string;
}

export interface SearxMeta {
  answers: SearxAnswer[];
  infoboxes: SearxInfobox[];
  corrections: string[];
  suggestions: string[];
}

/**
 * Provider-neutral item returned from a local-search implementation. The
 * legacy SearXNG result vocabulary remains below for compatibility at the
 * public Core boundary.
 */
export interface LocalSearchItem {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
  sources?: string[];
  publishedAt?: string;
}

export interface LocalSearchDirectAnswer {
  text: string;
  url?: string;
}

export interface LocalSearchKnowledgeCard {
  title?: string;
  text: string;
  url?: string;
}

export interface LocalSearchMetadata {
  directAnswers?: LocalSearchDirectAnswer[];
  knowledgeCards?: LocalSearchKnowledgeCard[];
  queryCorrections?: string[];
  querySuggestions?: string[];
  engineNames?: string[];
}

export interface SearchDiagnostic {
  code: "offline_source_unavailable";
  mode: "offline_fetch_only";
  message: string;
}

export interface LocalSearchResult {
  items: LocalSearchItem[];
  metadata?: LocalSearchMetadata;
  diagnostic?: SearchDiagnostic;
}

// Existing SearXNG-shaped consumers keep this public compatibility contract.
export interface SearxSearchResult {
  results: SearxResult[];
  meta: SearxMeta;
  route?: SearchRoute;
  diagnostic?: SearchDiagnostic;
}

// ── Research-route provenance ───────────────────────────────────────────────
// Which provider/tier actually served a request. Surfaced to users as a
// concise "Research route:" line and in structuredContent for badge rendering.
// Built only from explicit runtime state, never inferred from logs.
export type SearchProviderId =
  | LocalSearchProviderId
  | "exa"
  | "parallel"
  | "tinyfish"
  | "brave"
  | "cache";
// A registered local provider can participate in Core before it is added to
// the configured public vocabulary. Known providers remain validated at the
// cache/protocol boundaries.
export type SearchRouteProviderId = SearchProviderId | (string & {});
export type FetchProviderId =
  | "cloudflare"
  | "crawl4ai"
  | "raw"
  | "wayback"
  | "github"
  | "llms_full_txt"
  | "kiwix"
  | "hister"
  | "youtube"
  | "reddit"
  | "cache";

export interface SearchRoute {
  provider: SearchRouteProviderId;
  /** Engine names reported by a local provider when available. */
  engines?: string[];
  /**
   * True when hosted escalation served after local search, either as a
   * fallback or as a sequential hybrid supplement.
   */
  fallback?: boolean;
  /** True when served from the search cache rather than a live query. */
  cacheHit?: boolean;
}

export function localSearchMetadataToSearxMeta(
  metadata: LocalSearchMetadata | undefined,
): SearxMeta {
  return {
    answers: (metadata?.directAnswers ?? []).map((answer) => ({
      answer: answer.text,
      ...(answer.url === undefined ? {} : { url: answer.url }),
    })),
    infoboxes: (metadata?.knowledgeCards ?? []).map((card) => ({
      title: card.title ?? "",
      content: card.text,
      ...(card.url === undefined ? {} : { url: card.url }),
    })),
    corrections: metadata?.queryCorrections ?? [],
    suggestions: metadata?.querySuggestions ?? [],
  };
}

export function localSearchResultToSearxSearchResult(
  result: LocalSearchResult,
  options: {
    provider: SearchRouteProviderId;
    includeDirectAnswerMetadata: boolean;
    includeKnowledgeCardMetadata: boolean;
    includeQueryCorrectionMetadata: boolean;
    includeQuerySuggestionMetadata: boolean;
    includeEngineMetadata: boolean;
  },
): SearxSearchResult {
  const metadata = result.metadata;
  const legacyMeta = localSearchMetadataToSearxMeta(metadata);
  return {
    results: result.items.map((item) => ({
      title: item.title,
      url: item.url,
      ...(item.snippet === undefined ? {} : { content: item.snippet }),
      ...(item.source === undefined ? {} : { engine: item.source }),
      ...(item.sources === undefined ? {} : { engines: item.sources }),
      ...(item.publishedAt === undefined
        ? {}
        : { publishedDate: item.publishedAt }),
    })),
    meta: {
      answers: options.includeDirectAnswerMetadata ? legacyMeta.answers : [],
      infoboxes: options.includeKnowledgeCardMetadata
        ? legacyMeta.infoboxes
        : [],
      corrections: options.includeQueryCorrectionMetadata
        ? legacyMeta.corrections
        : [],
      suggestions: options.includeQuerySuggestionMetadata
        ? legacyMeta.suggestions
        : [],
    },
    route: options.includeEngineMetadata
      ? {
          provider: options.provider,
          engines: result.metadata?.engineNames ?? [],
        }
      : { provider: options.provider },
    ...(result.diagnostic === undefined
      ? {}
      : { diagnostic: result.diagnostic }),
  };
}

export interface FetchRoute {
  provider: FetchProviderId;
  fallback?: boolean;
  cacheHit?: boolean;
  /** Additional distinct fetch providers (multi-page search_and_fetch). */
  also?: FetchProviderId[];
}

export interface ResearchRoute {
  search?: SearchRoute;
  fetch?: FetchRoute;
}

export interface FirecrawlScrapeResponse {
  success: boolean;
  data?: {
    markdown?: string;
    html?: string;
    metadata?: {
      title?: string;
      sourceURL?: string;
    };
  };
  error?: string;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankResponse {
  results: RerankResult[];
}

export interface OllamaGenerateResponse {
  response: string;
}

export interface OllamaChatMessage {
  role: string;
  content: string;
}

export interface OllamaChatResponse {
  message: OllamaChatMessage;
}

export interface Citation {
  url: string;
  title: string;
  key_facts: string[];
}

export interface SummaryResult {
  summary: string;
  citations: Citation[];
}

export interface GitHubReadmeResponse {
  content: string;
  name: string;
  html_url: string;
}

export const CategorySchema = z
  .enum(["general", "news", "it", "science"])
  .default("general");

export const TimeRangeSchema = z
  .enum(["day", "week", "month", "year"])
  .optional();
