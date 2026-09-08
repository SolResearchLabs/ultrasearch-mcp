# Transports

UltraSearch MCP supports local stdio and HTTP transport.

## Stdio

Stdio is the default and best choice for local MCP clients.

```bash
ultrasearch-mcp
```

## HTTP

```bash
ULTRASEARCH_TRANSPORT=http \
ULTRASEARCH_HTTP_HOST=0.0.0.0 \
ULTRASEARCH_HTTP_PORT=3001 \
ultrasearch-mcp
```

HTTP transport has no built-in authentication. Put it behind network controls or an auth gateway.
