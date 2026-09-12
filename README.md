# UltraSearch MCP

Production-grade web research for MCP clients.

UltraSearch MCP gives Claude Desktop, VS Code, Cursor, Codex, and self-hosted MCP clients a local web research server with search, fetch, crawl, summarization, provider provenance, cache resilience, and budget guardrails.

<!-- mcp-name: io.github.solresearchlabs/ultrasearch-mcp -->

## Product contract

UltraSearch is local-first by default. Its first local search provider uses
`http://127.0.0.1:8099`; hosted search providers are optional BYOK backups.
The shared Control Plane is the production configuration owner for MCP, CLI,
and Core search routing. It resolves compatibility inputs into one typed
configuration, supplies a policy to Core, and provides redacted diagnostics.

The Full Package contracts define the current boundaries between Core, the
Control Plane, MCP, CLI, Desktop, and the local runtime:

- [Architecture](docs/architecture.md)
- [Control Plane](docs/control-plane.md)
- [Routing modes](docs/routing-modes.md)
- [Local runtime](docs/local-runtime.md)
- [Security model](docs/security-model.md)
- [Release policy](docs/release-policy.md)

## Install paths

### Claude Desktop

Best end-user path after the first GitHub Release:

1. Download the latest `ultrasearch-mcp-*.mcpb` from Releases.
2. Double-click it or drag it into Claude Desktop.
3. Enter your own SearXNG URL or optional hosted provider API keys in the extension UI.
4. Start using UltraSearch tools.

Until the release artifact exists, use the raw Claude config in `examples/claude-desktop.json`.
### VS Code, Cursor, and Copilot

Use the prompt-based config in `examples/vscode-mcp.json`. It uses host input variables so API keys are not hardcoded into the file.

### npm

```bash
npx -y @solresearchlabs/ultrasearch-mcp doctor
```

Local SearXNG only:

```bash
ULTRASEARCH_SEARXNG_URL=http://127.0.0.1:8099 npx -y @solresearchlabs/ultrasearch-mcp
```

Hosted fallback:

```bash
ULTRASEARCH_HOSTED_FALLBACK_ENABLED=true \
ULTRASEARCH_PROVIDER_ORDER=tinyfish,exa,parallel,brave \
ULTRASEARCH_TINYFISH_API_KEY=your_key_here \
npx -y @solresearchlabs/ultrasearch-mcp
```

### Docker

```bash
cp examples/env.example .env
docker compose -f examples/docker-compose.minimal.yml up --build
```

HTTP mode has no built-in auth. Bind locally or protect it at the network layer.

For technical Docker, Compose, and externally managed SearXNG paths, use
`http://127.0.0.1:8099` as the host-facing local search endpoint. Internal
container ports may differ.

## Tools

- `search`
- `search_and_fetch`
- `search_and_summarize`
- `fetch_url`
- `crawl_site`
- `domain_stats`
- `clear_cache`

## Configuration

Package users bring their own keys. Keys belong in their MCP host UI, OS
keychain, Docker secret store, shell environment, or local config file. Do not
put secrets in this repository.

The production resolver applies explicit operation overrides, environment or
MCP-host-projected values, user configuration, a selected profile, and schema
defaults in that order. Environment variables, JSON configuration, and MCP
host values remain supported compatibility inputs; they do not create separate
configuration or routing rules.

Use `ULTRASEARCH_*` environment variables, legacy aliases, or a JSON config
file at `~/.config/ultrasearch-mcp/config.json`. Config strings support
`${ENV_NAME}` placeholders.

```bash
ultrasearch-mcp init-config > ~/.config/ultrasearch-mcp/config.json
ultrasearch-mcp doctor
ultrasearch-mcp status --json
```

`doctor` and `status` read the same non-mutating, redacted Control Plane
status result. They make bounded local endpoint and cache checks, but do not
make authenticated hosted-provider diagnostic calls.

Runtime status is observation-only. `runtime.mode` defaults to
`external_endpoint`; `operator_compose` remains operator-owned, and
`unavailable` disables runtime observation. A status call may make one bounded
`GET` request to `/healthz` only for a safe HTTP(S) loopback endpoint. Unsafe
endpoint diagnostics are redacted. The Control Plane has no lifecycle executor,
and managed sidecars, Tauri Desktop, container management, and release work
remain excluded from this contract.

## Release status

This repository starts fresh from a curated source snapshot. It does not carry the development git history of the upstream fork or private deployment repo.
Current stage: `0.1.2`, first public release candidate after Claude Desktop runtime hardening.

## Persistent plan

Read [docs/one-click-release-plan.md](docs/one-click-release-plan.md) before changing install, package, registry, or release behavior.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
