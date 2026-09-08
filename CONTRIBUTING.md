# Contributing to UltraSearch MCP

Thanks for helping improve UltraSearch MCP.

## Principles

- Keep the server local-first and operator-controlled.
- Never log API keys, tokens, cookies, or Authorization headers.
- Keep hosted provider calls explicit.
- Prefer small, testable changes.
- Preserve MCP schema compatibility unless a breaking change is documented.

## Development setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

## Pull requests

Include a clear problem statement, focused patch, tests, and docs for user-facing changes.

## Provider changes

Provider integrations need a documented key name, config path, timeout, HTTP status handling, and mocked tests.

## Documentation style

Be concise. Avoid hype. Avoid em dashes. Include copy-paste examples.
