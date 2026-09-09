# Changelog

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
