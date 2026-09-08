# Agent Guide

This repository is the clean public release repo for UltraSearch MCP.

Before doing work:

1. Read `RELEASE_TRACK.md`.
2. Run `git status --short`.
3. Preserve the clean public product boundary.
4. Do not import private deployment history or files.
5. Do not commit secrets or secret-shaped values.

## Product boundary

This repo should contain the reusable MCP server, docs, examples, tests, and release automation.

This repo should not contain CBHR deployment paths, private GitHub secret materialization, LibreChat stack wiring, or production host workflows.

## Style

- Prefer concise, plain English.
- Do not use em dashes.
- Keep docs beautiful and operator-friendly.
- Prefer `ULTRASEARCH_*` variables in new docs.
- Preserve legacy env aliases only for migration compatibility.
## Validation before push

Run the local validation stack before pushing:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

Also run:

```bash
ultrasearch-mcp doctor
ultrasearch-mcp init-config
```

For Docker changes, run a Docker build and record the result in `RELEASE_TRACK.md`.

## Secrets

Use placeholder examples only. Never paste real provider keys into docs, tests, issues, logs, or examples.
