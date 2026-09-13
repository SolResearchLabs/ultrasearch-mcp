# Deployment

## Local package

Release target: available once `@solresearchlabs/ultrasearch-mcp` is published to npm. The commands below are the intended install steps after publication.

```bash
npm install -g @solresearchlabs/ultrasearch-mcp
ultrasearch-mcp doctor
ultrasearch-mcp
```

## Docker

```bash
cp examples/env.example .env
docker compose -f examples/docker-compose.minimal.yml up --build
```

## Production checklist

- Keep provider API keys server-side.
- Use a cache backend if budget guardrails are enabled.
- Keep HTTP transport behind access control.
- Set provider budgets before enabling paid fallback.
- Run `ultrasearch-mcp doctor` after configuration changes.
