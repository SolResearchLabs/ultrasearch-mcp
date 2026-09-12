# Hosted search providers

Hosted providers are optional BYOK search providers. Core consumes the
resolved Control Plane policy before it invokes them. They are backup fuel for
local-first search, not the product identity.

Default order: `tinyfish,exa,parallel,brave`.

```bash
ULTRASEARCH_HOSTED_FALLBACK_ENABLED=auto
ULTRASEARCH_PROVIDER_ORDER=tinyfish,exa,parallel,brave
```

`auto` enables hosted fallback only when at least one provider is configured.
`true` and `false` force the setting. The configured order is respected within
each budget-health class.

With `local_first`, hosted search runs only after a hard local failure or zero
usable local result. A weak but usable local response does not get a hosted
top-up. With `hybrid`, a weak local response can trigger a sequential hosted
follow-up; it does not create blind parallel provider fanout. `hosted_only`
skips local search and uses the configured hosted providers as the primary
search path.

## TinyFish

```bash
ULTRASEARCH_TINYFISH_API_KEY=...
ULTRASEARCH_TINYFISH_LOCATION=CA
```

## Budgets

Each provider can have a monthly unit budget. Units are operator-defined and
stored in the configured cache backend.

```bash
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_MONTHLY_UNITS=50
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_UNITS_PER_REQUEST=1
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_WARN_PERCENT=80
ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN=false
```

An unset monthly limit disables that provider's budget. Healthy and uncapped
providers run before near-limit providers; unknown budget health is allowed
only when the configured fail-open policy permits it; exhausted providers are
skipped. Status reports the budget and provider-control snapshots without
making authenticated hosted-provider diagnostic calls.

## Firecrawl

Firecrawl is explicit optional remote BYOK fetch/crawl escalation, not the
hosted search-provider order or primary search. It is not required for
`local_only` and is not part of the noob managed runtime v1. Configure it with
`ULTRASEARCH_FIRECRAWL_URL` and `ULTRASEARCH_FIRECRAWL_API_KEY`, or with
`remoteFetch.firecrawl.url` and `remoteFetch.firecrawl.apiKey` in the JSON
config file. The legacy `providers.firecrawl` JSON shape remains a
compatibility input. A local Firecrawl endpoint is an advanced explicit
override only.
