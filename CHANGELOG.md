# Changelog

## 0.2.0

Feature release: shared Control Plane foundation, provider-neutral local search, and a managed local runtime lifecycle.

- Added the shared Control Plane foundation: typed effective configuration, profiles, policy, and `status`/`doctor` diagnostics, with five routing modes and `local_first` as the default.
- Added the provider-neutral local search boundary, currently bound to the SearXNG adapter.
- Added the Windows provisioning patch and provisioning helper. The patch is an external artifact and is verified at provision time before it is applied.
- Added the Control Plane managed local runtime lifecycle through `ultrasearch-mcp runtime`: provision, start, stop, restart, status, repair, and cleanup for a runtime bound to loopback `127.0.0.1:18099`.
- Repaired the hermeticity test so the suite is insensitive to ambient credential variables.
- Added aggressive runtime, route, and platform test matrices.
- Hardened the release path: the release workflow is manual-dispatch only, and release-facing claims are guarded against implemented behavior.

## 0.1.2

Reliability release candidate.

- Added clear hosted-fallback diagnostics when SearXNG is down and hosted providers fail.
- Surfaces invalid TinyFish credentials as a provider authorization error instead of a generic fetch failure.
- Keeps the Claude Desktop startup, hoisted MCPB dependency layout, lazy tool-listing, and bounded tool-call hardening from the 0.1.1 candidate.

## 0.1.1

Reliability release candidate for Claude Desktop MCPB installs.

- Replayed modern `server/discover` into the MCP v2 server while suppressing duplicate discovery output.
- Packed MCPB production dependencies with hoisted `node_modules` so Desktop can resolve transitive MCP packages.
- Added bounded MCP tool execution and DNS lookup deadlines so tool calls return before host bridge timeouts.
- Lazy-loaded heavy tool handlers so `tools/list` stays fast on cold hoisted MCPB startup.
- Added smoke coverage for modern discovery, same-process `tools/list`, and tool timeout behavior.
## 0.1.0

Initial clean OSS release candidate.

- Fresh public repository with no imported development git history.
- Rebranded package as `@solresearchlabs/ultrasearch-mcp`.
- Added `ULTRASEARCH_*` configuration names with legacy aliases.
- Added JSON config file support with environment interpolation.
- Added redacted `doctor` and `init-config` CLI commands.
- Included TinyFish, Exa, Parallel, and Brave hosted search providers.
- Included SearXNG primary search, fetch tools, crawl tools, cache support, provider provenance, and budget guardrails.
