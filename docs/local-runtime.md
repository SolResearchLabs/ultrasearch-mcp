# Local Runtime

UltraSearch defaults to local-first research. The first local search provider
is SearXNG behind the `LocalSearchProvider` boundary.

The boundary is implemented in `src/search-providers/local.ts`. It provides
provider-neutral search items, metadata cards, filter requests, and capability
declarations. Core applies an engine filter and emits engine metadata only when
the active provider declares those capabilities. The current registry binds the
neutral contract to the SearXNG adapter while preserving SearXNG route
provenance, engine metadata, error messages, and endpoint configuration
behavior. Adding a different local provider remains future work.

## Canonical endpoint

The default local search endpoint is:

```text
http://127.0.0.1:8099
```

Historic `localhost:8081` configuration remains only as compatibility or an
explicit user override and is not a default.

The endpoint remains the provider-neutral `localSearch.endpoint` value. The
canonical `ULTRASEARCH_SEARXNG_URL` and legacy `SEARXNG_URL` environment inputs,
plus the documented legacy JSON `search.searxngUrl` input, still resolve this
same endpoint for the current SearXNG adapter.

## Runtime ownership

The current Control Plane observes a runtime that is already owned outside
UltraSearch. Its canonical `runtime.mode` defaults to `external_endpoint`.
The accepted values are:

- `external_endpoint`: an endpoint managed outside UltraSearch;
- `operator_compose`: an operator-managed runtime; and
- `unavailable`: no configured runtime observation.

The operator owns any runtime lifecycle, configuration, and repair work.
UltraSearch has no lifecycle executor in this contract. Its `start`, `stop`,
`restart`, `reconcile`, `repair`, and `adopt_container` operations report that
the lifecycle is unavailable.

Managed sidecars, Tauri Desktop, and container orchestration remain excluded
from the current runtime contract.

## Status observation

Each explicit status observation may issue one bounded `GET` request to
`/healthz`. It first accepts only an HTTP(S) loopback base on `127.0.0.1`,
`localhost`, or `::1`, without credentials, a query, or a fragment. The
request has a one-second timeout, refuses redirects, and has no retry, polling,
search, cache write, or lifecycle side effect.

Unsafe endpoints are not requested. Diagnostics show `runtime.endpoint` as
`null`; the local-search endpoint and configuration diagnostics show
`[redacted]`. This redaction does not change the effective configuration held
by the Control Plane.
