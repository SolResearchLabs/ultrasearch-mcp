# Security Model

UltraSearch is local-first by default. The Control Plane resolves whether Core
can use local or hosted search; hosted search and remote extraction are
explicit opt-in capabilities.

## Keys and configuration

Provider credentials are supplied by the user through an MCP host UI, OS
keychain, Docker secret store, shell environment, or local configuration file.
No shared hosted key ships with UltraSearch.

`src/config/schema.ts` classifies fields that may appear in diagnostics.
Control Plane diagnostics recursively replace every schema-classified
sensitive value with `[redacted]` before serializing status. The source
configuration is not mutated. The current schema classifies
`remoteFetch.firecrawl.apiKey` as sensitive; later sensitive fields receive
the same behavior by being classified in the schema.

`doctor` and `status` emit the redacted configuration values with their source
attribution. They do not print raw provider credentials.

## Network disclosure and budgets

Core enforces `local_only`, `local_first`, `hybrid`, `hosted_only`, and
`offline_fetch_only` for search. `local_only` prevents hosted search;
`offline_fetch_only` returns a diagnostic without a live search request; and
`hosted_only` can send search queries to a configured BYOK provider.
`local_first` allows hosted search only after a hard local failure or zero
usable local result, while `hybrid` can make a sequential hosted follow-up for
a weak local result.

Hosted providers remain subject to their enabled policy, configured user
credentials, provider controls, and budget state. Their budget snapshots are
included in redacted status output without making authenticated provider
diagnostic calls.

Firecrawl is explicit remote fetch and crawl escalation, not primary search.
It is disabled by default and is not a local-only baseline requirement or a
noob managed runtime v1 dependency. A local Firecrawl URL is an advanced
explicit override. Phase 002 search routing does not make Firecrawl a search
provider.

## Diagnostics and fetch protections

`doctor` and `status` are non-mutating. They probe a loopback local endpoint's
`/healthz` path with a one-second bound and perform a non-mutating cache check.
They do not probe a non-loopback endpoint and do not make authenticated hosted
provider requests.

Direct URL fetching remains subject to SSRF, redirect, size, timeout, and
policy gates. A remote extraction provider is not a way to bypass those
controls. Fetch and crawl adapter changes are outside Phase 002, so routing
mode selection does not itself reconfigure those existing adapters.

## Operating boundaries

HTTP transport has no built-in authentication. Operators bind it locally or
protect it at the network layer. The Control Plane managed local runtime
lifecycle starts only the recorded interpreter of a caller-staged root, on
loopback `127.0.0.1:18099`, with a strict allowlisted child environment and a
per-start generated `SEARXNG_SECRET` that is never persisted; it stops only the
recorded process after re-verifying the process identity, and it deletes the
managed root with proof. Before reporting `running` it asserts exactly one
listener on the recorded loopback address owned by the recorded child PID, so a
wildcard (`0.0.0.0`) or foreign-owned listener refuses and the just-started
child is stopped. The spawned PID is persisted as a `starting` record before
any inspection, so a failing inspector cannot orphan an unrecorded child, and a
refusing mutating operation persists `failed` with its typed refusal code and
detail. The isolation guard refuses a reparse point (junction or symlink) as
the managed root or as any existing ancestor component. There is no resident
watcher, no auto-restart, and no OS service registration; on a non-Windows host
every lifecycle operation, including read-only status, refuses with
`unsupported_platform`.

Runtime supervision beyond those on-demand operations, managed sidecars other
than the pinned runtime, container management, Tauri setup, and release
operations remain future work. Those clients must consume the same Control
Plane instead of creating separate route or security policy.
