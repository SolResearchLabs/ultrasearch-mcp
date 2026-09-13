# Control Plane

The Control Plane is the production owner of effective configuration,
diagnostics, profiles, and routing policy. Core owns the execution of search
behavior. MCP and CLI consume the Control Plane result; neither layer
interprets routing precedence independently.

## Canonical configuration

`src/config/schema.ts` is the canonical typed schema. The shared resolver
adapts existing environment variables, MCP-host-projected values, and JSON
configuration into that schema and resolves every Phase 002 field in this
order:

1. An explicit operation or request override supplied by the caller.
2. Process environment, including values projected by an MCP host.
3. The user configuration file.
4. The selected profile overlay.
5. Schema defaults.

The resolver returns both values and their source attribution. Existing
`ULTRASEARCH_*` names, legacy aliases, and legacy JSON fields remain
compatibility inputs; they do not establish a separate precedence model.

## Profiles

Profiles are lower-precedence overlays on the schema. The available profiles
are `local`, `hybrid`, `hosted`, and `offline`, which select the corresponding
routing mode. Select one with `ULTRASEARCH_PROFILE` or the top-level `profile`
field in user configuration.

When no higher-precedence mode is present, the default is `local_first`. The
default local search endpoint is `http://127.0.0.1:8099`.

## Status and diagnostics

`ultrasearch-mcp doctor` and `ultrasearch-mcp status` consume the same
Control Plane status object. Both accept `--json`; human output is a stable
key-value view of the same data.

The status object includes:

- resolved configuration values, source attribution, and selected profile;
- the Core routing policy;
- local search endpoint and cache state;
- an observation-only runtime projection with mode, ownership, observation,
  unavailable lifecycle, timestamp, safe endpoint, and bounded diagnostic;
- an additive read-only `managedRuntime` projection with managed state,
  endpoint, port, recorded pid, generation, ownership, and verification facts,
  or `null` when no managed runtime record is available or the projection is
  unavailable (missing record, corrupt state, refused root, or a non-Windows
  host, where the lifecycle module refuses with `unsupported_platform`);
- configured hosted providers, provider-control snapshots, and hosted-budget
  snapshots; and
- Firecrawl's classification and configuration posture without exposing its
  API key.

Status is read-only. Each explicit status observation can issue one bounded
`GET` request to a loopback local endpoint's `/healthz` route, with a
one-second bound and redirect refusal. Only HTTP(S) endpoints on `127.0.0.1`,
`localhost`, or `::1` without credentials, query, or fragment are eligible.
A non-loopback or malformed endpoint is reported as `not_probed`, without a
request. Status has no retry, polling, search, cache write, or authenticated
hosted-provider diagnostic call.

## Redaction

Diagnostic rendering recursively follows the schema metadata. A
schema-classified sensitive field is replaced with `[redacted]` in status
output without changing the resolved in-memory configuration. This lets new
sensitive nested fields gain the same protection by declaring their schema
classification rather than adding separate client-specific masking rules.

The runtime projection applies the same external boundary to unsafe local
endpoints: `runtime.endpoint` is `null`, while the local-search endpoint and
configuration diagnostics render `[redacted]`.

## Current and future responsibilities

MCP configuration exports, CLI `doctor` and `status`, provider controls,
hosted budgets, and Core search all consume the shared resolver in Phase 002.
Core receives the resolved routing policy and enforces it during search.

The Control Plane owns a managed local runtime lifecycle in
`src/control-plane/runtime-lifecycle.ts`, reached through
`ultrasearch-mcp runtime <operation>` (`provision`, `start`, `stop`, `restart`,
`status`, `repair`, `cleanup`). It verifies and patches a caller-staged root
through the existing provisioning helper, starts the pinned runtime on
`127.0.0.1:18099` under a strict allowlisted child environment, verifies
readiness and the single-listener/one-owner invariant (one listener, bound to
the recorded loopback address, owned by the recorded child PID), stops only the
recorded process after identity re-verification, and deletes the managed root
with proof. Its refusals are typed and fail closed: every refusing mutating
operation persists `failed` with `lastRefusal {code, at, detail}` while it
holds the single-writer root lock, and cleanup verifies the marker before
creating any lock or state artifact. The lifecycle is Windows-first: on any
other platform every operation, including read-only `status` and `reconcile`,
refuses with `unsupported_platform`, and the additive doctor/status projection
reports that as `null` instead of failing the status result.

There is no resident watcher, no auto-restart, and no OS service registration.
Automated acquisition, interpreter creation, and package installation remain
outside product code. Runtime supervision beyond those on-demand operations,
managed sidecars other than the pinned runtime, container management, Tauri
Desktop, and release operations remain excluded. They may become future
clients of this same Control Plane rather than separate configuration or
routing implementations.
