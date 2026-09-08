# UltraSearch MCP

Production-grade web research for MCP clients.

UltraSearch MCP combines local SearXNG search, hosted fallback providers, fetch and crawl tools, provider provenance, cache resilience, and budget guardrails behind one clean Model Context Protocol server.

## Highlights

- MCP tools for search, search and fetch, URL fetch, summarization, crawling, cache clearing, and domain stats.
- Local-first search through SearXNG.
- Hosted fallback providers for TinyFish, Exa, Parallel, and Brave.
- Provider provenance in structured output.
- Budget guardrails for paid hosted search providers.
- Redis, Valkey, or Dragonfly compatible cache support.
- Stdio for local clients and HTTP for server deployments.

## Quick start

```bash
npm install -g @solresearchlabs/ultrasearch-mcp
ultrasearch-mcp doctor
```

Local SearXNG only:

```bash
ULTRASEARCH_SEARXNG_URL=http://localhost:8081 ultrasearch-mcp
```

TinyFish fallback:

```bash
ULTRASEARCH_HOSTED_FALLBACK_ENABLED=true \
ULTRASEARCH_PROVIDER_ORDER=tinyfish,exa,parallel,brave \
ULTRASEARCH_TINYFISH_API_KEY=... \
ultrasearch-mcp
```

## Configuration

Use `ULTRASEARCH_*` environment variables, legacy aliases, or a JSON config file at `~/.config/ultrasearch-mcp/config.json`. Environment variables win. Config strings support `${ENV_NAME}` placeholders.

```bash
ultrasearch-mcp init-config > ~/.config/ultrasearch-mcp/config.json
ultrasearch-mcp doctor
```

## MCP client example

```json
{
  "mcpServers": {
    "ultrasearch": {
      "command": "npx",
      "args": ["-y", "@solresearchlabs/ultrasearch-mcp"],
      "env": {
        "ULTRASEARCH_SEARXNG_URL": "http://localhost:8081",
        "ULTRASEARCH_HOSTED_FALLBACK_ENABLED": "true",
        "ULTRASEARCH_PROVIDER_ORDER": "tinyfish,exa,parallel,brave",
        "ULTRASEARCH_TINYFISH_API_KEY": "${ULTRASEARCH_TINYFISH_API_KEY}"
      }
    }
  }
}
```

## Tools

`search`, `search_and_fetch`, `fetch_url`, `search_and_summarize`, `crawl_site`, `clear_cache`, and `domain_stats`.

## Docker

```bash
cp examples/env.example .env
docker compose -f examples/docker-compose.minimal.yml up --build
```

## Release status

This repository starts fresh from a curated source snapshot. It does not carry the development git history of the upstream fork or private deployment repo.

Current stage: `0.1.0`, first clean OSS release candidate.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
