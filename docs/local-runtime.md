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

The observation projection keeps reporting `lifecycle: unavailable`, and its
`start`, `stop`, `restart`, `reconcile`, `repair`, and `adopt_container`
operations keep returning `lifecycle_unavailable`: that module never mutates a
runtime.

## Managed runtime lifecycle

Managed lifecycle control lives in `src/control-plane/runtime-lifecycle.ts`
and is reached through `ultrasearch-mcp runtime <operation>` with the
operations `provision`, `start`, `stop`, `restart`, `status`, `repair`, and
`cleanup`. The managed runtime binds `127.0.0.1:18099`, starts the recorded
interpreter detached with a strict allowlisted child environment, verifies
`GET /` readiness and the single-listener/one-owner invariant before reporting
`running`, stops only the recorded process after re-verifying its identity, and
deletes the managed root with proof. The default managed root is
`%LOCALAPPDATA%\UltraSearch\runtime`; a caller may stage a disposable root and
pass it explicitly.

The single-listener invariant requires exactly one listener, on the recorded
loopback address `127.0.0.1` and owned by the recorded child PID. `::1` is not
normalized, so any other reported address - `0.0.0.0`, `::`, or a routable
address - refuses with `listener_invariant_violated` and the just-started child
is stopped before the refusal is raised. The spawned PID is persisted as a
`starting` record before any inspection, so an inspector failure after the
spawn still leads to a bounded terminate/force stop and a persisted
`spawn_failed` refusal instead of an orphaned child.

Every refusing mutating operation (`provision`, `start`, `stop`, `restart`,
`repair`, `cleanup`) persists `failed` with `lastRefusal {code, at, detail}`
before it raises, while this run holds the single-writer root lock. Refusals
raised before the lock is acquired (isolation, unsupported platform, a live
lock) write nothing, a refusal never creates state artifacts where no record
exists, and a corrupt record is never overwritten. Read-only status and a
`reconcile` that only reads persist nothing. Cleanup verifies the marker and
the isolation guard before it creates any lock or state artifact, so a refused
cleanup leaves an unmanaged directory byte-identical.

The isolation guard refuses a drive root, the home root itself (compared
case-insensitively on Windows), a root inside the UltraSearch installation, a
git working tree, and a reparse point - including a junction or symlink among
the root's existing ancestor components. Descendants of the home root such as
`%LOCALAPPDATA%` and `%TEMP%` roots stay permitted. The product cannot name an
arbitrary repository by path; that residual is covered by install-root
containment, the root-is-git-worktree check, and the gate-run staging
discipline.

The managed lifecycle is Windows-first: process and listener identity
verification is implemented for Windows, and on any other platform every
operation - including the read-only `status` and `reconcile` - refuses with
`unsupported_platform`. The additive `managedRuntime` projection in doctor and
status maps that refusal (and every other unavailable projection) to `null`
rather than failing the status result; `cleanup` on an already-absent root
still returns `already_absent` without touching the host.

The managed lifecycle verifies and patches a caller-staged root only:
automated acquisition, interpreter creation, and package installation stay out
of product code. There is no resident watcher, no auto-restart, and no OS
service registration. Managed sidecars beyond the pinned SearXNG runtime,
Tauri Desktop, and container orchestration remain excluded from the current
runtime contract.

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
