# ADR 0001: Core and Control Plane Boundary

## Status

Accepted, 2026-09-09.

## Decision

Core owns research behavior. Control Plane owns lifecycle, configuration,
profiles, status, doctor, repair, runtime coordination, and client
integration. MCP, CLI, and future Tauri Desktop are clients of those layers.

## Consequences

Routing and configuration logic cannot be duplicated in a client. The CLI is
the reference Control Plane client, and Desktop remains a thin client.
