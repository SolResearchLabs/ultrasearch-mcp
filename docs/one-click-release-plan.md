# One Click Release Plan

This is the persistent product plan for turning UltraSearch MCP from a good OSS source repo into a polished MCP package.

## Goal

A user should not need to understand the repo to use UltraSearch MCP.

Target flow:

1. Pick an install surface.
2. Enter their own provider keys in the host UI or local config.
3. Use the tools in Claude, VS Code, Cursor, Codex, or Docker MCP.

The repo is source and trust. The product is the install artifact.

## Current standard

Research basis as of 2026-09-08:

- MCP Registry uses `server.json` metadata and public package artifacts.
- npm package ownership is linked through `package.json#mcpName`.
- MCPB gives Claude Desktop a one-click local install path.
- MCPB `user_config` lets the host show settings and mark API keys as sensitive.
- VS Code MCP configs support `inputs` so keys are prompted and stored securely.
- Docker MCP has catalog, profile, gateway, and local secret commands.

## Product surfaces

### P0: Registry and package identity

Ship:

- `package.json#mcpName`
- `server.json`
- npm package dry run
- Docker OCI MCP label

Success condition:

- `server.json` and `package.json#mcpName` agree on the same server name.
- npm package contents include only release-safe files.
- Docker image carries the MCP server name label.
### P1: One-click Claude Desktop

Ship:

- `mcpb/manifest.json`
- `scripts/build-mcpb.mjs`
- packaged `.mcpb` artifact in GitHub Releases

User flow:

1. Download `.mcpb` from the release.
2. Double-click it or drop it into Claude Desktop.
3. Enter SearXNG URL or provider keys in the extension UI.
4. Start using UltraSearch tools.

Success condition:

- Claude install UI exposes friendly config fields.
- API key fields are marked sensitive.
- No manual JSON editing is required for Claude Desktop.
### P2: VS Code, Cursor, and Copilot

Ship:

- `examples/vscode-mcp.json`
- `examples/cursor-mcp.json` if Cursor needs a distinct shape
- README path that says copy this config or install from registry when available

User flow:

1. Add the MCP config to their user or workspace MCP config.
2. Host prompts for provider keys through `inputs`.
3. UltraSearch runs through `npx` or the local package.

Success condition:

- No API key is hardcoded in the example.
- Sensitive values use host input placeholders.
### P3: Docker MCP and self-hosted

Ship:

- OCI image at `ghcr.io/solresearchlabs/ultrasearch-mcp`
- MCP Registry `oci` package entry after image publish
- Docker examples that keep secrets outside the repo

User flow:

1. Install through Docker MCP Toolkit or Docker Compose.
2. Store keys in Docker secret storage or local env.
3. Connect the MCP client through Docker MCP Gateway or HTTP mode.

Success condition:

- Docker setup is documented without committed secrets.
- HTTP mode warns that auth is not built in.
## Key model

Package users bring their own keys. Keys are entered into their MCP host, OS keychain, Docker secret store, shell environment, or local config file.

Do not require users to put keys in this repository.

## Execution order

1. Add registry identity and `server.json`.
2. Add host-native examples for VS Code and Claude.
3. Add MCPB build path.
4. Run package dry run and inspect tarball contents.
5. Run local stdio and Docker MCP smoke.
6. Tag only after CI and package inspection are green.
