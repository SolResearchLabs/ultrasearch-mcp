import { getValkey } from "../cache.js";
import { getControlPlaneConfig } from "../control-plane/config.js";
import type { HostedSearchProviderId } from "./types.js";

export type BudgetHealthState =
  | "disabled"
  | "healthy"
  | "near_limit"
  | "exhausted"
  | "unknown";

export interface HostedSearchBudgetStatus {
  provider: HostedSearchProviderId;
  state: BudgetHealthState;
  allowed: boolean;
  usedUnits: number;
  limitUnits?: number;
  remainingUnits?: number;
  warnPercent: number;
  period: string;
  resetAt: string;
  failOpen: boolean;
}

export class HostedSearchBudgetError extends Error {
  constructor(
    public readonly provider: HostedSearchProviderId,
    public readonly budget: HostedSearchBudgetStatus,
  ) {
    super(
      budget.state === "unknown"
        ? `${provider} search budget could not be verified`
        : `${provider} search budget is exhausted`,
    );
    this.name = "HostedSearchBudgetError";
  }
}

function budgetConfig(provider: HostedSearchProviderId) {
  return getControlPlaneConfig().values.hostedSearch.providers[provider].budget;
}

function periodInfo(now = new Date()): {
  period: string;
  resetAt: Date;
  expireAtSeconds: number;
} {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const nextMonth = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0));
  // Keep the completed counter briefly after reset for diagnostics while the
  // active routing key naturally rolls to the new YYYY-MM namespace.
  const expireAtSeconds = Math.floor(
    (nextMonth.getTime() + 2 * 24 * 60 * 60 * 1000) / 1000,
  );
  return {
    period: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    resetAt: nextMonth,
    expireAtSeconds,
  };
}

function monthlyLimit(provider: HostedSearchProviderId): number | undefined {
  return budgetConfig(provider).monthlyUnits;
}

function unitsPerRequest(provider: HostedSearchProviderId): number {
  return budgetConfig(provider).unitsPerRequest;
}

function warnPercent(provider: HostedSearchProviderId): number {
  return budgetConfig(provider).warnPercent;
}

export function hostedBudgetFailOpen(
  provider: HostedSearchProviderId = "exa",
): boolean {
  return budgetConfig(provider).failOpen;
}

function budgetKey(provider: HostedSearchProviderId, period: string): string {
  return `budget:hosted-search:${provider}:${period}`;
}

function classify(
  provider: HostedSearchProviderId,
  usedUnits: number,
  limitUnits: number | undefined,
  period: string,
  resetAt: Date,
  failOpen: boolean,
  forceUnknown = false,
): HostedSearchBudgetStatus {
  const warning = warnPercent(provider);
  if (limitUnits === undefined) {
    return {
      provider,
      state: "disabled",
      allowed: true,
      usedUnits,
      warnPercent: warning,
      period,
      resetAt: resetAt.toISOString(),
      failOpen,
    };
  }

  if (forceUnknown) {
    return {
      provider,
      state: "unknown",
      allowed: failOpen,
      usedUnits,
      limitUnits,
      remainingUnits: Math.max(0, limitUnits - usedUnits),
      warnPercent: warning,
      period,
      resetAt: resetAt.toISOString(),
      failOpen,
    };
  }

  const remainingUnits = Math.max(0, limitUnits - usedUnits);
  const percent = limitUnits > 0 ? (usedUnits / limitUnits) * 100 : 100;
  const state: BudgetHealthState =
    usedUnits >= limitUnits
      ? "exhausted"
      : percent >= warning
        ? "near_limit"
        : "healthy";

  return {
    provider,
    state,
    allowed: state !== "exhausted",
    usedUnits,
    limitUnits,
    remainingUnits,
    warnPercent: warning,
    period,
    resetAt: resetAt.toISOString(),
    failOpen,
  };
}

export async function getHostedSearchBudgetStatus(
  provider: HostedSearchProviderId,
  now = new Date(),
): Promise<HostedSearchBudgetStatus> {
  const { period, resetAt } = periodInfo(now);
  const limit = monthlyLimit(provider);
  const failOpen = hostedBudgetFailOpen(provider);
  if (limit === undefined) {
    return classify(provider, 0, undefined, period, resetAt, failOpen);
  }

  try {
    const client = await getValkey();
    if (!client) {
      return classify(provider, 0, limit, period, resetAt, failOpen, true);
    }
    const raw = await client.get(budgetKey(provider, period));
    const used = raw === null ? 0 : Number.parseFloat(raw);
    if (!Number.isFinite(used)) {
      return classify(provider, 0, limit, period, resetAt, failOpen, true);
    }
    return classify(provider, used, limit, period, resetAt, failOpen);
  } catch {
    return classify(provider, 0, limit, period, resetAt, failOpen, true);
  }
}

// Atomic reservation. Units represent an operator-defined local accounting
// scale, not provider currency or a hardcoded vendor pricing model.
const RESERVE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local increment = tonumber(ARGV[1])
local hard_limit = tonumber(ARGV[2])
if (current + increment) > hard_limit then
  return {0, tostring(current)}
end
local updated = redis.call('INCRBYFLOAT', KEYS[1], increment)
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return {1, tostring(updated)}
`;

export async function reserveHostedSearchBudget(
  provider: HostedSearchProviderId,
  now = new Date(),
): Promise<HostedSearchBudgetStatus> {
  const { period, resetAt, expireAtSeconds } = periodInfo(now);
  const limit = monthlyLimit(provider);
  const failOpen = hostedBudgetFailOpen(provider);
  if (limit === undefined) {
    return classify(provider, 0, undefined, period, resetAt, failOpen);
  }

  try {
    const client = await getValkey();
    if (!client) {
      return classify(provider, 0, limit, period, resetAt, failOpen, true);
    }

    const result = (await client.eval(
      RESERVE_SCRIPT,
      1,
      budgetKey(provider, period),
      String(unitsPerRequest(provider)),
      String(limit),
      String(expireAtSeconds),
    )) as [number | string, string];

    const allowed = Number(result?.[0]) === 1;
    const used = Number.parseFloat(String(result?.[1] ?? "0"));
    const status = classify(
      provider,
      Number.isFinite(used) ? used : 0,
      limit,
      period,
      resetAt,
      failOpen,
      !Number.isFinite(used),
    );

    if (!allowed) {
      return { ...status, state: "exhausted", allowed: false };
    }
    return status;
  } catch {
    return classify(provider, 0, limit, period, resetAt, failOpen, true);
  }
}

export function budgetRoutingRank(state: BudgetHealthState): number {
  switch (state) {
    case "disabled":
    case "healthy":
      return 0;
    case "near_limit":
      return 1;
    case "unknown":
      return 2;
    case "exhausted":
      return 3;
  }
}
