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

const searxngGate = new BoundedSemaphore(
  "searxng",
  providerConfig.searxng.maxInFlight,
  providerConfig.searxng.maxQueue,
  providerConfig.searxng.queueTimeoutMs,
);
const searxngCircuit = circuit("searxng", providerConfig.searxng);

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

export function runSearxng<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return singleflight(`searxng:${key}`, async () => {
    // Do not consume a finite provider queue slot when the circuit is known to
    // be open. execute() checks again after admission to handle races.
    searxngCircuit.assertAvailable();
    return searxngGate.run(() => searxngCircuit.execute(fn));
  });
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
  return {
    searxng: {
      ...searxngGate.snapshot(),
      circuit: searxngCircuit.snapshot(),
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
