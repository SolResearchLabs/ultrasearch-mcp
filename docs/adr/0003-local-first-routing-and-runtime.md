# ADR 0003: Local-First Routing and Runtime

## Status

Accepted, 2026-09-09.

## Decision

`local_first` is the future schema's default routing mode. The canonical first
local endpoint is `http://127.0.0.1:8099`. SearXNG is the first
`LocalSearchProvider`, not the product identity.

The modes are `local_only`, `local_first`, `hybrid`, `hosted_only`, and
`offline_fetch_only`. Hosted providers are BYOK backups. Firecrawl is explicit
remote fetch/crawl escalation.

The routing contract is locked in `FULL-PACKAGE-001`; live search-router
enforcement is deferred to `FULL-PACKAGE-002`.

## Consequences

Normal users are targeted by a future managed native runtime. Docker, Compose,
and externally managed SearXNG remain technical or server paths. When the
future router is adopted, version one hybrid behavior will supplement or fall
back sequentially and will not issue blind parallel hosted requests.
