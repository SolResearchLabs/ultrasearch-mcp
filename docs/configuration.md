# Configuration

UltraSearch MCP reads configuration from environment variables and an optional JSON config file.

## Precedence

1. `ULTRASEARCH_*` environment variables.
2. Legacy environment aliases.
3. JSON config file.
4. Built-in defaults.

Default config path: `~/.config/ultrasearch-mcp/config.json`.

Custom config path:

```bash
ULTRASEARCH_CONFIG=/path/to/config.json ultrasearch-mcp
```

Config file strings can reference environment variables with `${NAME}` or `${NAME:-fallback}`.

## Provider keys

| Provider | Canonical variable | Legacy alias | Config path |
| --- | --- | --- | --- |
| TinyFish | `ULTRASEARCH_TINYFISH_API_KEY` | `TINYFISH_API_KEY` | `providers.tinyfish.apiKey` |
| Exa | `ULTRASEARCH_EXA_API_KEY` | `EXA_API_KEY` | `providers.exa.apiKey` |
| Parallel | `ULTRASEARCH_PARALLEL_API_KEY` | `PARALLEL_API_KEY` | `providers.parallel.apiKey` |
| Brave | `ULTRASEARCH_BRAVE_API_KEY` | `BRAVE_SEARCH_API_KEY`, `BRAVE_API_KEY` | `providers.brave.apiKey` |
