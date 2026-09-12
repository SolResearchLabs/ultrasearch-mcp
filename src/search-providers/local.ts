import type { LocalSearchResult } from "../types.js";
import { searxngSearchProvider } from "./searxng.js";

export type {
  LocalSearchDirectAnswer,
  LocalSearchItem,
  LocalSearchKnowledgeCard,
  LocalSearchMetadata,
  LocalSearchResult,
} from "../types.js";

export interface LocalSearchCapabilities {
  categoryFilter: boolean;
  timeRangeFilter: boolean;
  languageFilter: boolean;
  engineFilter: boolean;
  siteFilter: boolean;
  directAnswerMetadata: boolean;
  knowledgeCardMetadata: boolean;
  queryCorrectionMetadata: boolean;
  querySuggestionMetadata: boolean;
  engineMetadata: boolean;
}

export interface LocalSearchRequest {
  query: string;
  numResults: number;
  category?: string;
  timeRange?: string;
  language?: string;
  engineFilter?: string;
  siteFilter?: string | string[];
}

/**
 * The Core-facing local-search boundary. Provider IDs stay generic here so a
 * future local implementation can satisfy the same contract before it is added
 * to the configured routing and provenance vocabulary.
 */
export interface LocalSearchProvider<ProviderId extends string = string> {
  readonly id: ProviderId;
  readonly displayName?: string;
  readonly capabilities: LocalSearchCapabilities;
  search(request: LocalSearchRequest): Promise<LocalSearchResult>;
}

export function searchWithLocalProvider<ProviderId extends string>(
  provider: LocalSearchProvider<ProviderId>,
  request: LocalSearchRequest,
): Promise<LocalSearchResult> {
  return provider.search(request);
}

const localSearchProviders = new Map<string, LocalSearchProvider>([
  [searxngSearchProvider.id, searxngSearchProvider],
]);

// The configured Stage A registry starts with one implementation. Registration
// keeps the Core boundary honest for a future local provider without selecting
// a new configuration value in this slice.
export let localSearchProvider: LocalSearchProvider = searxngSearchProvider;

export function registerLocalSearchProvider<ProviderId extends string>(
  provider: LocalSearchProvider<ProviderId>,
): void {
  localSearchProviders.set(provider.id, provider);
}

export function setActiveLocalSearchProvider(providerId: string): void {
  const provider = localSearchProviders.get(providerId);
  if (!provider) {
    throw new Error(`Unknown local search provider: ${providerId}`);
  }
  localSearchProvider = provider;
}

export function getActiveLocalSearchProvider(): LocalSearchProvider {
  return localSearchProvider;
}

export function searchLocalProvider(
  request: LocalSearchRequest,
): Promise<LocalSearchResult> {
  return searchWithLocalProvider(localSearchProvider, request);
}
