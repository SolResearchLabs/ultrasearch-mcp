# Routing Modes

UltraSearch's Control Plane resolves exactly five routing modes, and Core
enforces the resulting policy in the search path. `local_first` is the
default. The active modes are:

## `local_only`

Core uses the local search provider, initially SearXNG, and never invokes
hosted search. A hard local failure is returned as a local failure, and zero
local results remain zero; neither outcome creates a hosted fallback.

## `local_first`

Core tries local search first. It may try hosted BYOK search only after a hard
local failure or zero usable local results. A local response with any result,
direct answer, or infobox is usable for this decision. A weak but usable local
result set returns without a hosted top-up.

Any hosted attempt still requires the configured hosted-search policy,
available BYOK provider credentials, and a budget decision. An explicit
SearXNG engine filter suppresses hosted fallback unless the operator enables
the canonical `search.hostedFallback.withEngineFilter` best-effort
engine-filter escalation setting.

## `hybrid`

Core uses local search first. A weak local result, as measured by the
configured hosted fallback minimum-results threshold or the absence of a
direct answer or infobox, can trigger one sequential hosted follow-up. A
successful hosted response supplements the local result set: local results
remain first, duplicate URLs are removed by exact URL with the first result
retained, and local answer or infobox metadata remains intact. The existing
route records the hosted provider and `fallback: true` for this successful
hosted escalation.

Hybrid is sequential supplement or fallback behavior. It does not perform
blind parallel hosted-provider fanout, and query expansion does not create
hosted requests for expanded variants.

## `hosted_only`

Core skips the local search provider and uses configured, enabled BYOK hosted
search. Search queries can leave the machine through the selected provider.
This mode does not start, repair, or otherwise manage a local runtime. If no
hosted provider can produce a result, the search result is empty.

## `offline_fetch_only`

Core performs no live search, cache access, hosted search, query expansion, or
network fetch. Phase 002 does not yet have an offline archive search source,
so it returns the structured diagnostic
`offline_source_unavailable` without making a live call.

## Scope of mode enforcement

Phase 002 applies these modes to Core search behavior. Firecrawl is not a
search provider in any mode; it remains explicit remote fetch and crawl
escalation. Existing fetch and crawl adapter behavior, runtime supervision,
and local archive backends are outside this routing implementation and remain
separate future work.
