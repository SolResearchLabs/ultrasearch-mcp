# UltraSearch MCP Release Track

This file is the persistent release checkpoint for agents and maintainers. Keep it current when making release-facing changes.

## Repo truth

- Public repo: `SolResearchLabs/ultrasearch-mcp`
- Package: `@solresearchlabs/ultrasearch-mcp`
- First release target: `v0.1.0`
- Import mode: clean snapshot import, no old git history
- Imported source snapshot: `SolResearchLabs/searxng-mcp@ea2306c1d1897666b2fbb7b8a7f1b226333ccdb4`
- Private deployment repo remains separate: `SolResearchLabs/UltraSearch`

## Release scope

UltraSearch MCP is a production-grade web research MCP server. The public repo contains the reusable MCP product, not the CBHR deployment control plane.

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

## Validation status

Last local Windows validation:

- `pnpm install --frozen-lockfile`: PASS
- `pnpm exec tsc --noEmit`: PASS
- `pnpm lint`: PASS
- `pnpm test`: PASS, 61 files, 651 tests, no type errors
- `pnpm build`: PASS
- `ultrasearch-mcp doctor`: PASS with redacted secrets
- dash hygiene scan for em dash, en dash, and minus sign: PASS

Pending before first public release tag:

- Docker build validation
- Local MCP protocol smoke from this repo
- Optional live TinyFish smoke through this repo
- GitHub Actions CI readback after initial push
- npm publish dry run
- final v0.1.0 release notes

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

Legacy aliases are accepted where useful, but new docs should prefer `ULTRASEARCH_*`.

## Safety rules

- Never commit secrets.
- Never print full API keys in tests, docs, CI, or doctor output.
- HTTP transport has no built-in auth. Bind locally or protect at the network layer.
- Hosted fallback should be opt-in and budgeted.
- Keep private deployment workflows out of this repo.
## Next agent start here

1. Read this file.
2. Run `git status --short`.
3. Run `pnpm lint && pnpm test && pnpm build`.
4. Run Docker build validation.
5. Run MCP protocol smoke.
6. Commit and push only after validation is green.
7. After push, read back public CI status before planning the npm release.

## Last known working tree

The repo was created public and empty first, then populated locally from a curated snapshot. The initial public commit is pending until Docker and MCP smoke are green.

## 2026-09-08 checkpoint

Additional validation completed after the initial track file was created:

- Docker build: PASS
- Docker image tag: `ultrasearch-mcp:release-smoke`
- Docker build arg: `GIT_SHA=local-release-smoke`
- Docker build output manifest list: `sha256:509e82b14246a6a84b0e4859b18bf4bc2e29f3422fd64306112e9012ae1f5023`
- Docker HTTP MCP smoke: PASS
- MCP initialize over HTTP: PASS, protocol `2024-11-05`
- MCP tools list over HTTP: PASS, 7 tools
- Tools returned: `clear_cache`, `crawl_site`, `domain_stats`, `fetch_url`, `search`, `search_and_fetch`, `search_and_summarize`

Remaining before release planning:

- Initial public commit and push
- Public GitHub Actions CI readback
- Optional live TinyFish smoke in this new repo once a repo or org secret is available
- npm publish dry run

## 2026-09-08 public push checkpoint

Initial public commit:

- Commit: `941bc9a74c4a33fb85f43cb85c0067ecd609cd62`
- Message: `Initial UltraSearch MCP release import`
- Files: 164
- Insertions: 24762
- Push target: `SolResearchLabs/ultrasearch-mcp main`

Public CI readback for initial commit:

- Workflow: `CI`
- Run: `34274303003`
- Status: completed
- Conclusion: success
- Head SHA: `941bc9a74c4a33fb85f43cb85c0067ecd609cd62`

Current next step after this checkpoint commit:

- Add live TinyFish smoke for this public repo after placing a repo or org secret named `ULTRASEARCH_TINYFISH_API_KEY` or `TINYFISH_API_KEY`.
- Run `npm pack --dry-run` and inspect package contents before the first npm release.
