# Configuration

UltraSearch resolves configuration through the shared typed Control Plane. The
schema in `src/config/schema.ts` is the source of configuration shape,
defaults, and diagnostic redaction metadata.

## Precedence

For every current configuration field, the resolver applies:

1. An explicit operation or request override supplied by the caller.
2. Process environment, including MCP host-projected configuration.
3. The user JSON configuration file.
4. A selected profile overlay.
5. Schema defaults.

Legacy environment aliases and legacy JSON fields are compatibility forms
inside their respective layers. They do not add a second precedence system.

Default config path: `~/.config/ultrasearch-mcp/config.json`.

Custom config path:

```bash
ULTRASEARCH_CONFIG=/path/to/config.json ultrasearch-mcp
```

Config file strings can reference environment variables with `${NAME}` or `${NAME:-fallback}`.

## Common settings

| Purpose | Canonical JSON path | Compatibility input |
| --- | --- | --- |
| Local endpoint | `localSearch.endpoint` | `ULTRASEARCH_SEARXNG_URL`, `search.searxngUrl` |
| Runtime observation | `runtime.mode` | `ULTRASEARCH_RUNTIME_MODE` |
| Routing mode | `routing.mode` | `ULTRASEARCH_ROUTING_MODE`, `search.routingMode` |
| Profile | top-level `profile` | `ULTRASEARCH_PROFILE` |
| Hosted fallback | `search.hostedFallback` | `ULTRASEARCH_HOSTED_FALLBACK_ENABLED`, `ULTRASEARCH_PROVIDER_ORDER`, `ULTRASEARCH_HOSTED_FALLBACK_MIN_RESULTS` |
| Engine-filter escalation | `search.hostedFallback.withEngineFilter` | `ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER`, `HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER`, `search.fallbackWithEngineFilter` |
| Cache | `cache` | `ULTRASEARCH_CACHE_*` values and supported cache aliases |
| Firecrawl | `remoteFetch.firecrawl` | `ULTRASEARCH_FIRECRAWL_*`, `providers.firecrawl` |

The default local endpoint is `http://127.0.0.1:8099`. The default routing
mode is `local_first`.

The profiles `local`, `hybrid`, `hosted`, and `offline` select
`local_only`, `hybrid`, `hosted_only`, and `offline_fetch_only` respectively.
An explicitly configured mode in an operation, environment, or user file
overrides the profile.

`doctor` and `status --json` expose resolved values, source attribution,
profile selection, routing policy, and redacted configuration posture.

## Runtime observation

`runtime.mode` defaults to `external_endpoint`. Its accepted values are
`external_endpoint`, `operator_compose`, and `unavailable`.
`operator_compose` identifies an operator-owned runtime; it does not grant the
CLI or Control Plane authority to start, stop, repair, reconcile, or adopt a
runtime. `unavailable` disables runtime observation.

`ULTRASEARCH_RUNTIME_MODE` is the sole environment input for this field. There
is no legacy runtime-mode alias. Runtime status is observation-only and accepts
only safe HTTP(S) loopback endpoint bases before it requests `/healthz`.
Unsafe endpoint output is redacted in diagnostics without changing the
effective configuration.

## Engine-filter escalation

`search.hostedFallback.withEngineFilter` is a boolean and defaults to `false`.
It permits best-effort hosted escalation only when a caller explicitly supplied
a SearXNG engine filter. It does not override routing-mode restrictions,
hosted provider enablement, BYOK credentials, or budget controls, and it does
not change `hosted_only` behavior.

The compatibility environment names are
`ULTRASEARCH_HOSTED_FALLBACK_WITH_ENGINE_FILTER` and
`HOSTED_SEARCH_FALLBACK_WITH_ENGINE_FILTER`. The legacy user configuration
alias is `search.fallbackWithEngineFilter`; when both JSON forms occur in the
same user configuration, the canonical
`search.hostedFallback.withEngineFilter` value wins.

## Firecrawl

Firecrawl is an optional explicitly configured remote BYOK fetch/crawl
escalation. It is not primary search, a local-only baseline requirement, or a
noob managed runtime v1 dependency. The Control Plane default is disabled with
an empty URL and API key. For diagnostic status, Firecrawl is configured only
when it is enabled and has both a URL and API key. A local endpoint is
supported only as an advanced explicit override.

## Provider keys

| Provider | Canonical variable | Legacy alias | Config path |
| --- | --- | --- | --- |
| TinyFish | `ULTRASEARCH_TINYFISH_API_KEY` | `TINYFISH_API_KEY` | `providers.tinyfish.apiKey` |
| Exa | `ULTRASEARCH_EXA_API_KEY` | `EXA_API_KEY` | `providers.exa.apiKey` |
| Parallel | `ULTRASEARCH_PARALLEL_API_KEY` | `PARALLEL_API_KEY` | `providers.parallel.apiKey` |
| Brave | `ULTRASEARCH_BRAVE_API_KEY` | `BRAVE_SEARCH_API_KEY`, `BRAVE_API_KEY` | `providers.brave.apiKey` |
