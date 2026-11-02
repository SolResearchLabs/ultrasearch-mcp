import { HOSTED_SEARCH_PROVIDER_IDS } from "../config/schema.js";
import { getControlPlaneConfig } from "../control-plane/config.js";
import type { SearxMeta } from "../types.js";
import { braveSearchProvider } from "./brave.js";
import {
  getHostedSearchBudgetStatus,
  HostedSearchBudgetError,
  type HostedSearchBudgetStatus,
} from "./budget.js";
import { deepseekSearchProvider } from "./deepseek.js";
import { exaSearchProvider } from "./exa.js";
import { parallelSearchProvider } from "./parallel.js";
import { tavilySearchProvider } from "./tavily.js";
import { tinyfishSearchProvider } from "./tinyfish.js";
import type {
  HostedSearchAttempt,
  HostedSearchFallbackResult,
  HostedSearchProvider,
  HostedSearchProviderId,
  HostedSearchRequest,
} from "./types.js";
import { youSearchProvider } from "./you.js";

const EMPTY_META: SearxMeta = {
  answers: [],
  infoboxes: [],
  corrections: [],
  suggestions: [],
};

const PROVIDERS: Record<HostedSearchProviderId, HostedSearchProvider> = {
  tinyfish: tinyfishSearchProvider,
  parallel: parallelSearchProvider,
  brave: braveSearchProvider,
  tavily: tavilySearchProvider,
  you: youSearchProvider,
  deepseek: deepseekSearchProvider,
  exa: exaSearchProvider,
};

const DEFAULT_ORDER: HostedSearchProviderId[] = [...HOSTED_SEARCH_PROVIDER_IDS];

function providerOrder(): HostedSearchProviderId[] {
  const configuredOrder =
    getControlPlaneConfig().values.search.hostedFallback.providerOrder;
  const seen = new Set<HostedSearchProviderId>();
  const order: HostedSearchProviderId[] = [];
  for (const item of configuredOrder) {
    const id = item.trim().toLowerCase() as HostedSearchProviderId;
    if (!(id in PROVIDERS) || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order.length > 0 ? order : DEFAULT_ORDER;
}

export function hostedSearchFallbackEnabled(): boolean {
  const configured =
    getControlPlaneConfig().values.search.hostedFallback.enabled;
  if (configured !== "auto") return configured;
  return providerOrder().some((id) => PROVIDERS[id].configured());
}

export function hostedSearchFallbackMinResults(): number {
  return getControlPlaneConfig().values.search.hostedFallback.minimumResults;
}

export function hasUsefulPrimarySearch(
  resultsCount: number,
  meta: SearxMeta,
): boolean {
  if (resultsCount >= hostedSearchFallbackMinResults()) return true;
  // SearXNG direct answers/infoboxes are already useful even when its ordinary
  // web result list is empty. Do not spend hosted-search quota unnecessarily.
  return meta.answers.length > 0 || meta.infoboxes.length > 0;
}

interface BudgetCandidate {
  id: HostedSearchProviderId;
  budget: HostedSearchBudgetStatus;
}

async function budgetAwareCandidates(
  attempts: HostedSearchAttempt[],
): Promise<BudgetCandidate[]> {
  const configured: HostedSearchProviderId[] = [];

  for (const id of providerOrder()) {
    if (!PROVIDERS[id].configured()) {
      attempts.push({ provider: id, outcome: "unconfigured" });
      continue;
    }
    configured.push(id);
  }

  // Provider order is the economic policy. Budget health is a hard gate, not
  // a reordering signal: a near-limit free provider should still be consumed
  // before a later paid provider while it remains allowed.
  return Promise.all(
    configured.map(async (id) => ({
      id,
      budget: await getHostedSearchBudgetStatus(id),
    })),
  );
}

export interface HostedSearchFallbackOutcome {
  result: HostedSearchFallbackResult | null;
  attempts: HostedSearchAttempt[];
  enabled: boolean;
}

export function describeHostedSearchAttempts(
  attempts: HostedSearchAttempt[],
): string {
  if (attempts.length === 0) return "no hosted providers attempted";
  return attempts
    .map((attempt) => {
      const detail = attempt.error ? `: ${attempt.error}` : "";
      return `${attempt.provider}=${attempt.outcome}${detail}`;
    })
    .join("; ");
}

export async function searchHostedFallbackWithAttempts(
  request: HostedSearchRequest,
): Promise<HostedSearchFallbackOutcome> {
  if (!hostedSearchFallbackEnabled()) {
    return { result: null, attempts: [], enabled: false };
  }

  const attempts: HostedSearchAttempt[] = [];
  const candidates = await budgetAwareCandidates(attempts);

  for (const { id, budget } of candidates) {
    const provider = PROVIDERS[id];
    if (!budget.allowed) {
      attempts.push({
        provider: id,
        outcome: "budget_blocked",
        budgetState: budget.state,
      });
      continue;
    }

    try {
      const results = await provider.search(request);
      if (results.length === 0) {
        attempts.push({
          provider: id,
          outcome: "empty",
          budgetState: budget.state,
        });
        continue;
      }
      attempts.push({
        provider: id,
        outcome: "hit",
        budgetState: budget.state,
      });
      return {
        result: {
          results,
          meta: EMPTY_META,
          provider: id,
          attempts,
        },
        attempts,
        enabled: true,
      };
    } catch (err) {
      if (err instanceof HostedSearchBudgetError) {
        attempts.push({
          provider: id,
          outcome: "budget_blocked",
          budgetState: err.budget.state,
          error: err.message,
        });
        continue;
      }

      attempts.push({
        provider: id,
        outcome: "error",
        budgetState: budget.state,
        error: err instanceof Error ? err.message : "provider error",
      });
    }
  }

  return { result: null, attempts, enabled: true };
}

export async function searchHostedFallback(
  request: HostedSearchRequest,
): Promise<HostedSearchFallbackResult | null> {
  return (await searchHostedFallbackWithAttempts(request)).result;
}

export function configuredHostedSearchProviders(): HostedSearchProviderId[] {
  return providerOrder().filter((id) => PROVIDERS[id].configured());
}

export async function hostedSearchBudgetSnapshot(): Promise<
  Record<HostedSearchProviderId, HostedSearchBudgetStatus>
> {
  const entries = await Promise.all(
    DEFAULT_ORDER.map(
      async (id) => [id, await getHostedSearchBudgetStatus(id)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    HostedSearchProviderId,
    HostedSearchBudgetStatus
  >;
}

export { hostedSearchControlSnapshot } from "./control.js";
export type {
  LocalSearchCapabilities,
  LocalSearchDirectAnswer,
  LocalSearchItem,
  LocalSearchKnowledgeCard,
  LocalSearchMetadata,
  LocalSearchProvider,
  LocalSearchRequest,
  LocalSearchResult,
} from "./local.js";
export {
  getActiveLocalSearchProvider,
  localSearchProvider,
  registerLocalSearchProvider,
  searchLocalProvider,
  searchWithLocalProvider,
  setActiveLocalSearchProvider,
} from "./local.js";
export { searxngSearchProvider } from "./searxng.js";
export type {
  HostedSearchCapabilities,
  HostedSearchProvider,
  HostedSearchProviderId,
  HostedSearchRequest,
} from "./types.js";
