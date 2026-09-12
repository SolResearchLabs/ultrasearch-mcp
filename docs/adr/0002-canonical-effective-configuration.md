# ADR 0002: Canonical Effective Configuration

## Status

Accepted, 2026-09-09.

## Decision

The future typed `src/config/schema.ts` contract defines the canonical
effective-configuration resolver. Resolution order is request override,
process environment and MCP host projection, user configuration file, selected
profile overlay, then schema defaults.

Existing `ULTRASEARCH_*` environment variables, JSON configuration, and MCP
host configuration remain compatibility inputs during migration.

The contract is locked in `FULL-PACKAGE-001`; live resolver and CLI/Control
Plane adoption are deferred to `FULL-PACKAGE-002`.

## Consequences

`FULL-PACKAGE-002` must have clients and generated configuration surfaces use
the same schema contract where practical. Its effective-config reporting must
record value provenance while schema-classified secrets remain redacted.
