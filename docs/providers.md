# Hosted search providers

Hosted providers are optional. They are used when local SearXNG returns too few useful results and hosted fallback is enabled.

Default order: `tinyfish,exa,parallel,brave`.

```bash
ULTRASEARCH_HOSTED_FALLBACK_ENABLED=true
ULTRASEARCH_PROVIDER_ORDER=tinyfish,exa,parallel,brave
```

## TinyFish

```bash
ULTRASEARCH_TINYFISH_API_KEY=...
ULTRASEARCH_TINYFISH_LOCATION=CA
```

## Budgets

Each provider can have a monthly unit budget. Units are operator-defined and stored in the configured cache backend.

```bash
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_MONTHLY_UNITS=50
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_UNITS_PER_REQUEST=1
ULTRASEARCH_TINYFISH_SEARCH_BUDGET_WARN_PERCENT=80
ULTRASEARCH_HOSTED_SEARCH_BUDGET_FAIL_OPEN=false
```

## Firecrawl

Firecrawl is used by crawl/fetch fallback paths, not the hosted search-provider order. Configure it with `ULTRASEARCH_FIRECRAWL_URL` and `ULTRASEARCH_FIRECRAWL_API_KEY`, or with `providers.firecrawl.url` and `providers.firecrawl.apiKey` in the JSON config file.
