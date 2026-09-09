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

## 2026-09-08 hygiene cleanup checkpoint

Removed an internal temporary helper script from `scripts/` so the public repo keeps only product and maintainer-facing release scripts.

Next release lane:

1. Confirm MCPB manifest shape against the latest Claude Desktop behavior on a real install.
2. Add GitHub release workflow to attach `.mcpb`, checksums, and npm pack dry-run output.
3. Add optional Docker image publish workflow to GHCR.
4. Add MCP Registry publish checklist using `server.json` after npm package publish.
5. Run final tag gate before `v0.1.0`.

## 2026-09-08 release workflow checkpoint

Implemented:

- `.github/workflows/release.yml` for tag and manual release dry runs.
- `scripts/validate-release-metadata.mjs` to enforce package, `server.json`, MCPB manifest, npm entry, tag version, and secret metadata alignment.
- `docs/release-notes/v0.1.0.md` for the first draft release body.
- `release-assets*/` ignored in `.gitignore`.

Workflow behavior:

- On `v*` tag push, build release assets and create a draft GitHub Release.
- On manual dispatch, run the same release artifact path without creating a draft by default.
- GHCR push is manual-only through `push_ghcr=true`.
- No npm publish and no MCP Registry publish happen in this workflow.
Local validation:

- YAML lint: PASS.
- Release metadata validator: PASS for `v0.1.0`.
- Dash hygiene scan: PASS.
- `pnpm install --frozen-lockfile`: PASS.
- `pnpm exec tsc --noEmit`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: PASS, 61 files, 651 tests, no type errors.
- `pnpm build`: PASS.
- `npm publish --dry-run --access public`: PASS.
- `npm pack --pack-destination release-assets-local`: PASS.
- MCPB validate, pack, clean, and info: PASS.
- Docker build tag `ultrasearch-mcp:release-workflow-local`: PASS.
- Docker MCP label JSON readback: `io.github.solresearchlabs/ultrasearch-mcp`.
Local artifact hashes:

- npm tarball: `9b26949ccf7de3abc5a1efd64a180be0e7962c96a25ba2d9771ed2dac776245a`.
- MCPB bundle: `e1ef7beb6f44f6048f6717fdc0721234bba37682740c766d4580ddbadfd371b1`.
- Docker image ID file: `f7df294241899fd9e0e9a44a5d97e1c9a3c0c55d95b55eef2ebb386c3a2456d8`.

Next release lane:

1. Commit and push the release workflow checkpoint.
2. Confirm normal public CI.
3. Run manual `Release` workflow dispatch with `create_draft_release=false` and `push_ghcr=false`.
4. If the dry-run workflow is green, test the `.mcpb` artifact in Claude Desktop.
5. Only after manual MCPB install passes, cut `v0.1.0` tag.

## 2026-09-08 public release workflow dry run

Public checkpoint commit:

- Commit: `e276b1904affc44da621217c5d7d1c84ec5d6fb6`.
- Normal CI run: `34291054157`, completed success.
- Manual Release workflow run: `34291192554`, completed success.
- Release job: `Build release artifacts`, completed success.

Release dry-run behavior confirmed:

- Installed dependencies.
- Validated release metadata.
- Ran test and build.
- Prepared npm release assets.
- Built MCPB artifact.
- Built Docker image.
- Generated checksums.
- Uploaded workflow artifact `ultrasearch-mcp-0.1.0-release-assets`.
- GHCR push skipped because `push_ghcr=false`.
- Draft GitHub Release skipped because `create_draft_release=false`.

Artifact readback:

- Artifact ID: `10081434499`.
- Artifact digest: `sha256:5f9feac1718c2eb94766810b3e3c79bb1bf7e90ef80a0add1a3f067a8711b913`.
- Artifact expires: `2026-10-08T23:35:17Z`.
Next release gate:

1. Download the release artifact from run `34291192554`.
2. Test `ultrasearch-mcp-0.1.0.mcpb` in Claude Desktop.
3. If MCPB install passes, cut tag `v0.1.0`.
4. Let tag workflow create the draft GitHub Release.
5. Publish npm and MCP Registry only after final human approval.

## 2026-09-08 Claude Desktop discovery probe fix

Real Claude Desktop MCPB install surfaced a host compatibility blocker:

- Claude Desktop installed the MCPB UI path, but Cowork and Code shared-pool sessions failed startup.
- Error class: version negotiation failed during `server/discover` probe.
- Main legacy session could start, but the shared-pool path treated the in-place probe failure as fatal.

Fix chosen:

- Keep the v1 SDK for the v0.1.0 release lane.
- Do not attempt the larger SDK v2 migration inside the release cut.
- Add a stdio preflight wrapper that answers a first-message `server/discover` request with a valid no-modern-versions result.
- Then hand the same stdio stream to the existing v1 SDK server for normal initialize-based MCP.

Validation after fix:

- `pnpm exec tsc --noEmit`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: PASS, 61 files, 651 tests, no type errors.
- `pnpm build`: PASS.
- Raw `server/discover` probe: PASS, returns JSON-RPC result with `supportedVersions: []`.
- v1 SDK stdio client smoke: PASS, 7 tools listed.
- v2 auto-negotiating stdio client smoke: PASS, negotiated `legacy`, 7 tools listed.
- Rebuilt MCPB: PASS.

Fixed local test artifact:

- Path: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-discovery-fix.mcpb`
- SHA-256: `a2863be4ba25e7b01df030911e636169fe6f2145cc2050de934caf9be348ef17`

Next gate:

- Remove the old UltraSearch MCP extension from Claude Desktop.
- Install the fixed MCPB artifact.
- Confirm Cowork and Code sessions start without the version negotiation error.

## 2026-09-08 fixed release artifact dry run

Pushed compatibility fix:

- Commit: `ac55781cbbb102051a9541625fd6d92a24845bd8`
- Message: `fix: support Claude discovery probe`
- CI run: `34294904832`, completed success

Release dry run after compatibility fix:

- Run: `34295037285`, completed success
- Head SHA: `ac55781cbbb102051a9541625fd6d92a24845bd8`
- GHCR push: skipped intentionally
- Draft GitHub Release: skipped intentionally

Fixed public artifact:

- Artifact name: `ultrasearch-mcp-0.1.0-release-assets`
- Artifact id: `10082831449`
- Artifact digest: `sha256:904b8880ab93667899c24ff514ef457dca48fc8ed437c2e382970e10363763b2`
- CI MCPB SHA-256: `8678098a7cf8a9b1304711261b6db75a381b34d59ca105ac1edb112f337273e3`
- Desktop CI artifact path: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-ci-discovery-fix.mcpb`

Remaining gate:

- Uninstall old UltraSearch MCP extension from Claude Desktop.
- Install the CI-built discovery fix MCPB from Desktop.
- Confirm the Cowork and Code version negotiation error is gone.

## 2026-09-08 Claude Desktop fast bootstrap fix

The first discovery probe fix was insufficient in real Claude Desktop. The host still logged:

- Cowork and Code startup failed during `server/discover` version negotiation.
- Claude classified the era probe as legacy, but the shared-pool path still treated the in-place probe close as fatal.

Root cause found:

- The v1 SDK server was able to answer `server/discover`, but only after heavy module imports and runtime initialization.
- Claude's shared-pool probe can close before that response window.
- A 750 ms concurrent probe reproduced the issue with zero discovery responses.
- A stricter 150 ms probe also failed before the bootstrap refactor.

Fix chosen:

- Keep v1 SDK for the v0.1.0 lane.
- Make `src/index.ts` a minimal stdio bootstrap with no heavy app imports before the first stdio read.
- Answer first-message `server/discover` immediately with `supportedVersions: []` and `capabilities: {}`.
- Pause stdin after the first line so a fast follow-up `initialize` is preserved.
- Move heavy server startup to `src/server-entry.ts` and import it only after the probe response.
- Add `scripts/smoke-stdio-bootstrap.mjs` and run it in CI and Release workflows.

Local validation after fast bootstrap:

- `package.json` BOM cleanup: PASS.
- `pnpm install --frozen-lockfile`: PASS.
- `pnpm exec tsc --noEmit`: PASS.
- `pnpm lint`: PASS.
- `pnpm test`: PASS, 61 files, 651 tests, no type errors.
- `pnpm build`: PASS.
- `scripts/smoke-stdio-bootstrap.mjs`: PASS.
- 150 ms `server/discover` response: PASS.
- 300 ms `server/discover` response: PASS.
- 750 ms `server/discover` response: PASS.
- Same-pipe `server/discover` plus `initialize`: PASS.
- SDK stdio client tool list: PASS, 7 tools.
- MCPB `info`, `unpack`, and manifest validation: PASS.
- MCPB `verify`: expected unsigned dry-run failure.
- Docker build: PASS.
- Docker MCP label JSON readback: `io.github.solresearchlabs/ultrasearch-mcp`.

Fixed local test artifact:

- Path: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-fast-bootstrap.mcpb`
- SHA-256: `02b716b1d6bfa2652fd55003f6427c3319f3471a8272836a4be88e6f1384f073`

Next gate:

1. Commit and push the fast bootstrap fix.
2. Confirm public CI on the exact commit.
3. Run Release workflow dry run with `create_draft_release=false` and `push_ghcr=false`.
4. Download the CI-built MCPB artifact.
5. Install that artifact in Claude Desktop and confirm Cowork and Code startup.

## 2026-09-08 Claude MCPB placeholder and Firecrawl surface fix

Real Claude Desktop retest changed the failure from version-negotiation text to plain `Connection closed`, which proves the fast bootstrap moved the failure past the first `server/discover` race but did not complete the host gate.

Additional host UI findings:

- Claude showed optional empty user-config substitutions as literal `${user_config...}` environment values.
- Hosted fallback was enabled while only TinyFish had a concrete key.
- Firecrawl existed in the code path but was missing from the MCPB and registry configuration surfaces.

Fix applied:

- Treat unresolved MCPB `${user_config.*}` placeholder strings as unset runtime config values.
- Add tests proving unresolved placeholder env values do not count as provider keys.
- Expose Firecrawl in `mcpb/manifest.json` and `server.json`.
- Add canonical aliases `ULTRASEARCH_FIRECRAWL_URL` and `ULTRASEARCH_FIRECRAWL_API_KEY` while preserving legacy `FIRECRAWL_*` aliases.
- Add blank defaults for optional sensitive MCPB fields so hosts have a clean empty value to substitute.
- Expand the stdio bootstrap smoke to run with hosted fallback enabled and unresolved optional placeholder env values.

Validation:

- JSON parse for `package.json`, `server.json`, and `mcpb/manifest.json`: PASS.
- Typecheck: PASS.
- Lint: PASS.
- Runtime config tests: PASS.
- Full test suite: PASS, 61 files, 653 tests, no type errors.
- Build: PASS.
- Stdio bootstrap smoke: PASS.
- Release metadata validate `v0.1.0`: PASS.
- MCPB stage and manifest validate: PASS.
- MCPB info, unpack, and unpacked manifest validate: PASS.
- MCPB verify: expected unsigned dry-run failure only.
- Secret scan for TinyFish-shaped keys in repo files: PASS.

Local test artifact:

- Path: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-firecrawl-placeholder-fix.mcpb`
- SHA-256: `24d92720ebdd07c1daf4ab5a64d862c2672bf3eafc9098e545f7f3bac5272173`

Next gate:

- Install the new Firecrawl/placeholder-fix MCPB in Claude Desktop.
- If Cowork and Code still fail with plain `Connection closed`, stop patching shims and do the full SDK v2 server migration through `@modelcontextprotocol/server` + `serveStdio`.

## 2026-09-09 - SDK v2 stdio hybrid for Claude Cowork/Code

Claude Desktop continued to fail Cowork/Code startup after the fast legacy-discovery shim and Firecrawl/placeholder hardening. The log changed to plain `Connection closed`, with Claude still marking the server as legacy and closing after initialize.

Implemented the next release-gate fix:

- Added `@modelcontextprotocol/server@2.0.0` for stdio serving.
- Added `@modelcontextprotocol/client@2.0.0` for modern stdio smoke coverage.
- Upgraded root `zod` to `^4.5.4` so v2 tool schemas are native.
- Kept HTTP on the proven v1 SDK transport path for v0.1.0.
- Added `src/stdio-entry.ts` using v2 `serveStdio`.
- Kept `src/index.ts` as a tiny bootstrap so a claimed `server/discover` probe receives `supportedVersions: ["2026-07-28"]` inside 150 ms before heavy imports.
- Adapted existing v1-style tool registration to v2 stdio without rewriting tool handlers.

Local validation before commit:

- install, typecheck, lint, tests: PASS, 61 files and 653 tests.
- build: PASS.
- stdio smoke: PASS for 150 ms, 300 ms, 750 ms claimed `server/discover`, v2 SDK client, and v1 SDK client.
- npm publish dry run and npm pack dry run: PASS.
- MCPB pack, clean, info, unpack, validate: PASS.
- Docker build: PASS.
- Docker MCP label: PASS.
- tracked TinyFish-shaped secret scan, JSON parse, dash hygiene, and diff whitespace: PASS.

Local test MCPB copied to Desktop: `ultrasearch-mcp-0.1.0-sdkv2-stdio-local.mcpb`, SHA-256 `0bf41a8e19fb1f4d9fb6d66b1a0d2fb3d109c84788d822d355de3f1641ba6237`.

Public validation after SDK v2 stdio hybrid commit:

- Commit: `f038dda8320579349dc65fd910e05ea353b5186d`.
- Public CI run: `34308641253`, conclusion `success`.
- Public Release dry run: `34308792780`, conclusion `success`.
- Release artifact name: `ultrasearch-mcp-0.1.0-release-assets`.
- Release artifact id: `10087639940`.
- Release artifact digest: `sha256:0cfb61387024f39360e15bf32bbf2d1d9f195e76e0ec85e993babed803250388`.
- Downloaded artifact checksum verification: PASS for all `SHA256SUMS.txt` entries.
- CI-built MCPB copied to Desktop as `ultrasearch-mcp-0.1.0-ci-sdkv2-stdio.mcpb`.
- CI-built MCPB SHA-256: `8c4420e9eaa9e84e8bad2e5adf464bd9312bbd9a4429d1e2dcb2e4fe3e410e54`.

Next human gate: remove the old UltraSearch extension from Claude Desktop and install the CI-built SDK v2 stdio MCPB from Desktop. If Claude still closes Cowork/Code, inspect Claude extension logs around `03:54Z+` and do not tag v0.1.0.

## Claude Desktop modern tools/list replay fix - 2026-09-09

User retest of `ultrasearch-mcp-0.1.0-ci-sdkv2-stdio.mcpb` changed the failure again:
Claude now reports `Era probe verdict: modern (sibling answered server/discover)`, then starts a session, sends `tools/list`, and closes.

Root cause found by on-disk reproduction:
the fast bootstrap answered `server/discover` itself, but did not replay that same discover request into SDK v2.
SDK v2 therefore never initialized the real process as a modern 2026 session before Claude sent `tools/list`.

Fix:
- replay the initial modern `server/discover` line into SDK v2 `serveStdio`
- suppress SDK v2's duplicate discover response to the client
- keep the fast bootstrap response for Claude's tight sibling probe window
- add a permanent `claude_modern_tools_list` smoke that sends modern discover followed by same-process modern `tools/list`

Local validation:
- typecheck, lint, tests, build: PASS
- `server/discover` at 150/300/750 ms: PASS, `supportedVersions=["2026-07-28"]`
- `claude_modern_tools_list`: PASS, 7 tools
- v2 SDK stdio client: PASS, 7 tools
- v1 SDK stdio client: PASS, 7 tools
- npm publish dry run and npm pack dry run: PASS
- MCPB validate, pack, clean, info, unpack validate: PASS
- Docker build and MCP registry label: PASS
- tracked TinyFish-shaped secret scan, JSON parse, dash hygiene, diff check: PASS

Local test artifact:
`C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-modern-replay-fix-local.mcpb`
sha256: `193ba126e2e459de4f4f2d12f1c1b511523e43019470035bc4fa430a4d9fd69e`

Public CI and release dry run for modern replay fix - 2026-09-09:

- commit: `82feefb428c2542688aefe56957cd9dde588aa69`
- CI run: `34310780877`, conclusion `success`
- Release dry run: `34310906108`, conclusion `success`
- Release steps completed: metadata validation, test/build, `smoke-stdio-bootstrap`, npm dry run, npm pack, MCPB validate/pack/clean/info, Docker build, Docker MCP label, checksums, artifact upload
- GHCR push: skipped intentionally
- draft GitHub Release: skipped intentionally
- artifact id: `10088355536`
- artifact digest: `sha256:8f961c42de7b620a0022f87a60d87725e6352895347b9848a0cea4c69a2d6b34`
- CI MCPB desktop copy: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-ci-modern-replay-fix.mcpb`
- CI MCPB sha256: `6bc1903d0a84a8af72f52049553561bcb1d0a82373815c8a7b14e43855db6e59`

Next gate: install the CI MCPB in Claude Desktop and confirm whether the Cowork/Code shared-pool session stays connected after `tools/list`.

## Claude Desktop hoisted MCPB install fix - 2026-09-09

Claude Code disk inspection found the installed Claude Desktop extension was still the earlier SDK v2 stdio local bundle, not the newer replay-fix CI bundle. It also found the crash source was MCPB packaging, not protocol handling: `mcpb pack` flattened pnpm symlinks so `@modelcontextprotocol/server` could not resolve `@modelcontextprotocol/core` at runtime inside Claude Desktop.

Fix:
- change `scripts/build-mcpb.mjs` to install production dependencies with `--node-linker=hoisted`
- keep the SDK v2 stdio replay fix unchanged
- ignore local MCPB install artifacts and backup folders

Local packaging proof:
- `pnpm mcpb:stage`: PASS
- packed MCPB: `mcpb.mcpb`
- packed MCPB sha256: `397a66f8b391e9af34ac352344f1088e8e20337f449877460b692fe0caf01c3b`
- packed size: 12,263,080 bytes
- unpacked layout contains `node_modules/@modelcontextprotocol/core/dist/index.mjs`: PASS
- unpacked layout contains `node_modules/@modelcontextprotocol/server/dist`: PASS
- `@modelcontextprotocol/server` import from the unpacked bundle: PASS

Claude Desktop disk install proof:
- unsupported disk replacement used only after backing up the existing UltraSearch extension state
- installed registry hash updated to `397a66f8b391e9af34ac352344f1088e8e20337f449877460b692fe0caf01c3b`
- installed extension contains top-level `@modelcontextprotocol/core`: PASS
- Claude Desktop log after replacement shows `Era probe verdict: modern`, `Message from client: method="tools/list"`, then `Message from server: id=0 result` at `2026-09-09T05:07:23.219Z` and again at `2026-09-09T05:09:16.754Z`

Next release gate:
- commit this packaging fix
- run public CI
- run Release workflow dry run
- download CI-built MCPB and confirm its bundle layout has top-level `@modelcontextprotocol/core`
- prefer GUI install for final validation, but same-version test installs may require uninstall or cache clear because Claude Desktop keys the local extension by id and version

## Public hoisted MCPB dry run and Claude Desktop install proof - 2026-09-09

Commit:
- `0976a5968680c008725b57a8a1467fc109621027`
- message: `fix: hoist MCPB production dependencies`

Public validation:
- CI run: `34313988953`, conclusion `success`
- Release dry run: `34314244266`, conclusion `success`
- release artifact id: `10089501428`
- release artifact digest: `sha256:6b86c9639583c2c28e2c49f69d32f049f77bca61d72e6c800cd74de595f5c0e1`
- release steps completed: metadata validation, test/build, MCPB build, Docker build, checksums, artifact upload
- GHCR push: skipped intentionally
- draft GitHub Release: skipped intentionally

CI artifact verification:
- downloaded artifact: `ultrasearch-mcp-0.1.0-release-assets`
- checksum verification against `SHA256SUMS.txt`: PASS for all files
- CI MCPB: `ultrasearch-mcp-0.1.0.mcpb`
- CI MCPB sha256: `105f3427ccfb2c35b6d760b7f5acecf1dd4aa273bdfd8aa5e93bdde9bb337007`
- archive layout contains `node_modules/@modelcontextprotocol/core/dist/index.mjs`: PASS
- archive layout contains `node_modules/@modelcontextprotocol/server/dist`: PASS
- archive layout contains `build/src/index.js` and `build/src/stdio-entry.js`: PASS
- Desktop copy: `C:\Users\Aryan\Desktop\ultrasearch-mcp-0.1.0-ci-hoisted-replay-fix.mcpb`

Claude Desktop disk install proof:
- installed extension registry hash updated to `105f3427ccfb2c35b6d760b7f5acecf1dd4aa273bdfd8aa5e93bdde9bb337007`
- installed payload contains top-level `@modelcontextprotocol/core`: PASS
- Claude Desktop log after CI artifact install shows `Era probe verdict: modern`, `Server started and connected successfully`, `Message from client: method="tools/list"`, and `Message from server: id=0 result`
- no recent `Connection closed` or `Server disconnected` error lines were emitted after the CI artifact install window

Release decision:
- the Claude Desktop Cowork/Code startup blocker is resolved for the CI-built hoisted MCPB artifact
- next gate is tag/release preparation, signing decision, npm publish approval, and MCP Registry publish approval
