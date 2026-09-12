import { CircuitBreaker } from "./circuit-breaker.js";
import { BoundedSemaphore, singleflight, TokenBucket } from "./concurrency.js";
import { getControlPlaneConfig } from "./control-plane/config.js";
import { crawl4aiHostPressure, LocalLoadShedError } from "./host-pressure.js";

function circuit(
  name: string,
  config: {
    circuitFailureThreshold: number;
    circuitCooldownMs: number;
    circuitMaxCooldownMs: number;
  },
): CircuitBreaker {
  return new CircuitBreaker(name, {
    failureThreshold: config.circuitFailureThreshold,
    cooldownMs: config.circuitCooldownMs,
    maxCooldownMs: config.circuitMaxCooldownMs,
  });
}

const providerConfig = getControlPlaneConfig().values.providerControl;

interface LocalSearchProviderControl {
  gate: BoundedSemaphore;
  circuit: CircuitBreaker;
}

const localSearchProviderControls = new Map<
  string,
  LocalSearchProviderControl
>();

function localSearchProviderControl(
  provider: string,
): LocalSearchProviderControl {
  const existing = localSearchProviderControls.get(provider);
  if (existing) return existing;

  // Keep providerControl.searxng as the current compatibility configuration
  // source. Newly registered providers receive independent gate/circuit state
  // from that baseline until a future slice adds provider-specific settings.
  const config = providerConfig.searxng;
  const control = {
    gate: new BoundedSemaphore(
      provider,
      config.maxInFlight,
      config.maxQueue,
      config.queueTimeoutMs,
    ),
    circuit: circuit(provider, config),
  };
  localSearchProviderControls.set(provider, control);
  return control;
}

const cloudflareGate = new BoundedSemaphore(
  "cloudflare-browser-run",
  providerConfig.cloudflare.maxInFlight,
  providerConfig.cloudflare.maxQueue,
  providerConfig.cloudflare.queueTimeoutMs,
);

// Public-safe default follows the current Workers Free Quick Actions limit:
// one request every ten seconds. Paid deployments should explicitly raise this
// below their account ceiling (currently 10 req/s by default).
const cloudflareRate = new TokenBucket(
  "cloudflare-browser-run-rate",
  providerConfig.cloudflare.quickActionRps,
  providerConfig.cloudflare.quickActionBurst,
  providerConfig.cloudflare.rateMaxWaiters,
  providerConfig.cloudflare.rateMaxWaitMs,
);
const cloudflareCircuit = circuit(
  "cloudflare-browser-run",
  providerConfig.cloudflare,
);

const crawl4aiGate = new BoundedSemaphore(
  "crawl4ai",
  providerConfig.crawl4ai.maxInFlight,
  providerConfig.crawl4ai.maxQueue,
  providerConfig.crawl4ai.queueTimeoutMs,
);
const crawl4aiCircuit = circuit("crawl4ai", providerConfig.crawl4ai);

export function runLocalSearchProvider<T>(
  provider: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const control = localSearchProviderControl(provider);
  return singleflight(`${provider}:${key}`, async () => {
    // Do not consume a finite provider queue slot when the circuit is known to
    // be open. execute() checks again after admission to handle races.
    control.circuit.assertAvailable();
    return control.gate.run(() => control.circuit.execute(fn));
  });
}

// Compatibility export for the existing SearXNG adapter and callers. The
// generic local-provider control path above retains the former key, queue, and
// circuit behavior for this provider.
export function runSearxng<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return runLocalSearchProvider("searxng", key, fn);
}

export function localSearchProviderControlSnapshot(provider: string) {
  const control = localSearchProviderControl(provider);
  return {
    ...control.gate.snapshot(),
    circuit: control.circuit.snapshot(),
  };
}

export function runCloudflareQuickAction<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return singleflight(`cloudflare:${key}`, async () => {
    // Circuit pre-check comes before the token bucket so an unhealthy provider
    // consumes neither a future rate token nor an active-request permit.
    cloudflareCircuit.assertAvailable();
    await cloudflareRate.acquire();
    return cloudflareGate.run(() => cloudflareCircuit.execute(fn));
  });
}

export function runCrawl4ai<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`crawl4ai:${key}`, async () => {
    const pressure = crawl4aiHostPressure.snapshot();
    if (pressure.state === "critical") {
      throw new LocalLoadShedError(
        pressure.state,
        pressure.availablePercent,
        pressure.availableMb,
      );
    }

    crawl4aiCircuit.assertAvailable();
    const execute = () =>
      crawl4aiCircuit.execute(fn, {
        // Crawl4AI uses null as its established "could not produce content"
        // result. Count that toward local-provider health without changing the
        // existing adapter contract seen by the fetch cascade.
        isFailureResult: (result) => result === null,
      });

    // Under degraded host memory, one local-browser operation may start only
    // if the slot is immediately free. New queueing is shed so a temporary
    // Cloudflare outage cannot build a backlog of future Chromium work.
    if (pressure.state === "degraded") {
      return crawl4aiGate.runIfAvailable(execute);
    }

    return crawl4aiGate.run(execute);
  });
}

export function providerControlSnapshot() {
  const searxngControl = localSearchProviderControl("searxng");
  return {
    searxng: {
      ...searxngControl.gate.snapshot(),
      circuit: searxngControl.circuit.snapshot(),
    },
    cloudflare: {
      ...cloudflareGate.snapshot(),
      rate: cloudflareRate.snapshot(),
      circuit: cloudflareCircuit.snapshot(),
    },
    crawl4ai: {
      ...crawl4aiGate.snapshot(),
      circuit: crawl4aiCircuit.snapshot(),
      hostPressure: crawl4aiHostPressure.snapshot(),
    },
  };
}
