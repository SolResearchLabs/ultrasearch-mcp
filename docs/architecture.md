# UltraSearch Architecture

UltraSearch is a local-first research system with one shared research engine.
The architecture separates product behavior from the clients that expose it.

## Layers

1. **Core** owns research behavior: search, fetch, crawl, summarization,
   cache, budgets, provenance, and route outcomes.
2. **Control Plane** will own effective configuration, profiles, local-runtime
   lifecycle, status, doctor, repair, provider checks, and client integration.
3. **MCP** adapts Control Plane and Core capabilities to the MCP protocol.
4. **CLI** is the reference technical Control Plane client.
5. **Desktop** is a future thin Tauri client of the Control Plane.
6. **Local Runtime** provides local providers and supporting services.

When adopted in `FULL-PACKAGE-002`, clients will not implement their own
routing, configuration resolution, runtime lifecycle, status, or repair
policy. Core will not own client installation or runtime lifecycle decisions.

## Provider roles

SearXNG is the first `LocalSearchProvider`. It is an interchangeable local
provider, not the product identity. The canonical first local endpoint is
`http://127.0.0.1:8099`.

Core reaches local search through `src/search-providers/local.ts`. That
boundary owns provider-neutral search items, metadata cards, request filters,
and capability declarations; the current registry binds it to the SearXNG
adapter in `src/search-providers/searxng.ts`. Core forwards a filter and
surfaces engine metadata only when the active provider declares support for
them. The SearXNG adapter translates its native request and response into the
neutral contract, while the Core compatibility edge retains the established
SearXNG result and route shapes. The current configuration keeps the
provider-neutral `localSearch.endpoint` contract, while the established SearXNG
environment and JSON compatibility inputs continue to resolve that endpoint.

Hosted search providers are explicit user-supplied, bring-your-own-key backup
providers. They are subject to routing mode, budget decisions, and route
disclosure. They do not define UltraSearch's default identity.

Firecrawl is an explicitly configured remote fetch and crawl escalation. It is
not primary search, is not required for local-only behavior, and is not part of
the managed local runtime in v1.

## Product direction

The normal-user target is a managed native local runtime. Docker, Podman,
Compose, and externally managed SearXNG remain technical and server paths.
Those paths must use the same Control Plane contract as other clients.

The current MCP server is an existing client surface. This document defines the
shared product boundary. The schema, profile, and routing contracts are locked
now; live effective-configuration resolution, CLI/Control Plane adoption, and
search-router enforcement are deferred to `FULL-PACKAGE-002`.
