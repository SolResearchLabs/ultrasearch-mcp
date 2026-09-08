# UltraSearch MCP

Production-grade web research for MCP clients.

UltraSearch MCP gives Claude Desktop, VS Code, Cursor, Codex, and self-hosted MCP clients a local web research server with search, fetch, crawl, summarization, provider provenance, cache resilience, and budget guardrails.

<!-- mcp-name: io.github.solresearchlabs/ultrasearch-mcp -->

## Install paths

### Claude Desktop

Best end-user path after the first GitHub Release:

1. Download `ultrasearch-mcp-v0.1.0.mcpb` from Releases.
2. Double-click it or drag it into Claude Desktop.
3. Enter your own SearXNG URL or hosted provider API keys in the extension UI.
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
ULTRASEARCH_SEARXNG_URL=http://localhost:8080 npx -y @solresearchlabs/ultrasearch-mcp
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

## Tools

- `search`
- `search_and_fetch`
- `search_and_summarize`
- `fetch_url`
- `crawl_site`
- `domain_stats`
- `clear_cache`

## Configuration

Package users bring their own keys. Keys belong in their MCP host UI, OS keychain, Docker secret store, shell environment, or local config file. Do not put secrets in this repository.

Use `ULTRASEARCH_*` environment variables, legacy aliases, or a JSON config file at `~/.config/ultrasearch-mcp/config.json`. Environment variables win. Config strings support `${ENV_NAME}` placeholders.

```bash
ultrasearch-mcp init-config > ~/.config/ultrasearch-mcp/config.json
ultrasearch-mcp doctor
```

## Release status

This repository starts fresh from a curated source snapshot. It does not carry the development git history of the upstream fork or private deployment repo.
Current stage: `0.1.0`, first clean OSS release candidate.

## Persistent plan

Read [docs/one-click-release-plan.md](docs/one-click-release-plan.md) before changing install, package, registry, or release behavior.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
