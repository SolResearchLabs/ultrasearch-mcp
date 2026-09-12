import { CircuitBreaker } from "../circuit-breaker.js";
import { BoundedSemaphore, singleflight } from "../concurrency.js";
import { getControlPlaneConfig } from "../control-plane/config.js";
import {
  HostedSearchBudgetError,
  reserveHostedSearchBudget,
} from "./budget.js";
import type { HostedSearchProviderId } from "./types.js";

interface HostedProviderControl {
  gate: BoundedSemaphore;
  circuit: CircuitBreaker;
}

function makeControl(id: HostedSearchProviderId): HostedProviderControl {
  const config =
    getControlPlaneConfig().values.hostedSearch.providers[id].control;
  return {
    gate: new BoundedSemaphore(
      `${id}-search`,
      config.maxInFlight,
      config.maxQueue,
      config.queueTimeoutMs,
    ),
    circuit: new CircuitBreaker(`${id}-search`, {
      failureThreshold: config.circuitFailureThreshold,
      cooldownMs: config.circuitCooldownMs,
      maxCooldownMs: config.circuitMaxCooldownMs,
    }),
  };
}

const controls: Record<HostedSearchProviderId, HostedProviderControl> = {
  exa: makeControl("exa"),
  parallel: makeControl("parallel"),
  tinyfish: makeControl("tinyfish"),
  brave: makeControl("brave"),
};

export function runHostedSearchProvider<T>(
  provider: HostedSearchProviderId,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const control = controls[provider];
  return singleflight(`hosted-search:${provider}:${key}`, async () => {
    // Keep known-unhealthy providers out of the queue. We check again after
    // admission because another concurrent request may open the circuit while
    // this caller is waiting for a provider slot.
    control.circuit.assertAvailable();
    return control.gate.run(async () => {
      control.circuit.assertAvailable();

      // Budget accounting sits outside circuit execution. An exhausted or
      // unverifiable hard budget is an operator-routing condition, not evidence
      // that the provider itself is unhealthy.
      const budget = await reserveHostedSearchBudget(provider);
      if (!budget.allowed) throw new HostedSearchBudgetError(provider, budget);

      return control.circuit.execute(fn);
    });
  });
}

export function hostedSearchControlSnapshot() {
  return Object.fromEntries(
    (
      Object.entries(controls) as Array<
        [HostedSearchProviderId, HostedProviderControl]
      >
    ).map(([id, control]) => [
      id,
      {
        ...control.gate.snapshot(),
        circuit: control.circuit.snapshot(),
      },
    ]),
  );
}
