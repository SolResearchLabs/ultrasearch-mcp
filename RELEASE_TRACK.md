# UltraSearch MCP Release Track

This file is the persistent release checkpoint for agents and maintainers. Read it first when resuming this repo.

## Repo truth

- Public repo: `SolResearchLabs/ultrasearch-mcp`
- Package: `@solresearchlabs/ultrasearch-mcp`
- First release target: `v0.1.0`
- Import mode: clean snapshot import, no old git history
- Imported source snapshot: `SolResearchLabs/searxng-mcp@ea2306c1d1897666b2fbb7b8a7f1b226333ccdb4`
- Private deployment repo remains separate: `SolResearchLabs/UltraSearch`

## Product boundary

UltraSearch MCP is a production-grade web research MCP server. This public repo contains the reusable MCP product, not the CBHR deployment control plane.

In scope:

- MCP search, fetch, crawl, summarize, cache, and domain stats tools
- SearXNG primary search
- Hosted fallback providers: TinyFish, Exa, Parallel, Brave
- Provider provenance in structured MCP output
- Hosted provider budget guardrails
- Local JSON config with environment interpolation
- `ULTRASEARCH_*` canonical environment variables
- Legacy environment aliases for migration
- Docker examples and local package examples

Out of scope:

- CBHR production host paths
- Private GitHub secret materialization
- LibreChat-specific Docker networks
- Internal deploy request workflows
- Private API keys or secret values

## Configuration contract

Canonical variables:

- `ULTRASEARCH_CONFIG`
- `ULTRASEARCH_TRANSPORT`
- `ULTRASEARCH_HTTP_HOST`
- `ULTRASEARCH_HTTP_PORT`
- `ULTRASEARCH_SEARXNG_URL`
- `ULTRASEARCH_CACHE_URL`
- `ULTRASEARCH_PROVIDER_ORDER`
- `ULTRASEARCH_HOSTED_FALLBACK_ENABLED`
- `ULTRASEARCH_TINYFISH_API_KEY`
- `ULTRASEARCH_EXA_API_KEY`
- `ULTRASEARCH_PARALLEL_API_KEY`
- `ULTRASEARCH_BRAVE_API_KEY`
- `ULTRASEARCH_TINYFISH_LOCATION`

Legacy aliases are accepted where useful. New docs should prefer `ULTRASEARCH_*`.

## Validation completed

Local Windows validation:

- `pnpm install --frozen-lockfile`: PASS
- `pnpm exec tsc --noEmit`: PASS
- `pnpm lint`: PASS
- `pnpm test`: PASS, 61 files, 651 tests, no type errors
- `pnpm build`: PASS
- `ultrasearch-mcp doctor`: PASS with redacted secrets
- `ultrasearch-mcp init-config`: PASS
- dash hygiene scan for em dash, en dash, and minus sign: PASS
- old private lineage grep outside notice and this track file: PASS
- secret-shaped grep excluding lock/domain metadata: PASS

Docker and MCP validation:

- Docker build: PASS
- Docker image tag: `ultrasearch-mcp:release-smoke`
- Docker build arg: `GIT_SHA=local-release-smoke`
- Docker build output manifest list: `sha256:509e82b14246a6a84b0e4859b18bf4bc2e29f3422fd64306112e9012ae1f5023`
- Docker HTTP MCP smoke: PASS
- MCP initialize over HTTP: PASS, protocol `2024-11-05`
- MCP tools list over HTTP: PASS, 7 tools
- Tools returned: `clear_cache`, `crawl_site`, `domain_stats`, `fetch_url`, `search`, `search_and_fetch`, `search_and_summarize`

Public CI milestones:

- Initial code commit: `941bc9a74c4a33fb85f43cb85c0067ecd609cd62`
- Initial code CI run: `34274303003`, completed success
- Track checkpoint commit: `ccf7654d44dc1021979e9ee3f8eb31001c7c9fac`
- Track checkpoint CI run: `34274503535`, completed success

## Remaining before release planning

- Run live TinyFish smoke locally with a maintainer-provided environment variable or config file. Package users supply their own keys at runtime through local env or config.
- Run `npm pack --dry-run` and inspect package contents before first npm release.
- Decide whether to publish Docker image now or after npm package smoke.
- Draft final `v0.1.0` release notes.

## Safety rules

- Never commit secrets.
- Never print full API keys in tests, docs, CI, or doctor output.
- HTTP transport has no built-in auth. Bind locally or protect at the network layer.
- Hosted fallback should be opt-in and budgeted.
- Keep private deployment workflows out of this repo.

## Next agent start here

1. Read this file.
2. Run `git status --short`.
3. Run `pnpm lint && pnpm test && pnpm build` if code changed.
4. Run Docker build validation if Docker or package scripts changed.
5. Run MCP protocol smoke if transport or package entrypoint changed.
6. Commit and push only after validation is green.
7. After push, read back public CI status before planning the npm release.

## 2026-09-08 one-click product plan

User correction accepted: UltraSearch MCP is a package, not a hosted key service. Users bring their own keys through their MCP host, local env, Docker secret store, or local config.

Research-backed release direction:

- MCP Registry: publish metadata with `server.json` after package artifact is public.
- npm: package identity must match `server.json` through `package.json#mcpName`.
- Claude Desktop: ship `.mcpb` for one-click install and host-managed sensitive fields.
- VS Code, Cursor, and Copilot: ship input-variable examples so users are prompted for keys.
- Docker: ship OCI image and Docker secret oriented docs.

Persistent plan file:

- `docs/one-click-release-plan.md`
Implemented in this pass:

- Added `server.json` registry metadata draft.
- Added `package.json#mcpName`.
- Added Docker MCP Registry OCI label.
- Added `mcpb/manifest.json` with Claude user config and sensitive API key fields.
- Added `scripts/build-mcpb.mjs` staging script.
- Added `examples/vscode-mcp.json` using host input variables.
- Reframed README around install paths, not manual repo cloning.

Next validation:

1. JSON parse for manifests and examples.
2. `pnpm install --frozen-lockfile`.
3. `pnpm lint && pnpm test && pnpm build`.
4. `pnpm mcpb:stage`.
5. `npm pack --dry-run` inspection.
6. Docker build.
7. Push only after green checks.

## 2026-09-08 one-click implementation checkpoint

Implemented and validated:

- `server.json`: JSON parse PASS.
- `package.json#mcpName`: matches `server.json` name.
- Docker OCI label: `io.modelcontextprotocol.server.name=io.github.solresearchlabs/ultrasearch-mcp`.
- `mcpb/manifest.json`: MCPB CLI validation PASS.
- `examples/vscode-mcp.json`: JSON parse PASS and uses input variables for secrets.
- `scripts/build-mcpb.mjs`: stages a bundle with build output, production dependencies, domains data, README, license, and notice.
- `docs/one-click-release-plan.md`: persistent product plan added.

Validation results:

- `pnpm install --frozen-lockfile`: PASS.
- `pnpm exec tsc --noEmit`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: PASS, 61 files, 651 tests, no type errors.
- `pnpm build`: PASS.
- `pnpm mcpb:stage`: PASS.
- `npx @anthropic-ai/mcpb validate dist/mcpb`: PASS.
- `npx @anthropic-ai/mcpb pack dist/mcpb dist/ultrasearch-mcp-v0.1.0.mcpb`: PASS.
- `npx @anthropic-ai/mcpb clean dist/ultrasearch-mcp-v0.1.0.mcpb`: PASS.
- MCPB SHA-256 after clean: `0cceaa3c7a1e832b92488eebdb661c5e88e25db303bc232ee0e0d763654b0622`.
- `npm pack --dry-run`: PASS, 144 files, 109.3 kB package, 384.0 kB unpacked.
- Docker build tag `ultrasearch-mcp:one-click`: PASS.
- Docker manifest list: `sha256:41d0fe1be45068f179dde03d2f8e19d3b5a3e90bf0d8f3bd670db23df1564f8a`.

Remaining before public v0.1.0 tag:

- Push this checkpoint and confirm GitHub Actions CI.
- Test MCPB in Claude Desktop manually.
- Optional live TinyFish smoke using maintainer local env/config only.
- Publish npm package, then publish MCP Registry metadata.
- Decide whether to publish GHCR image in v0.1.0 or v0.2.0.
