# Claude Desktop MCPB Install

The preferred Claude Desktop path is the `.mcpb` bundle from GitHub Releases.

User flow:

1. Download `ultrasearch-mcp-v0.1.0.mcpb` from the release.
2. Double-click the file or drag it into Claude Desktop.
3. Review the requested tools and permissions.
4. Enter only the settings you want to use.
5. Start a new Claude chat and use UltraSearch.

## Configuration fields

Claude Desktop should show these fields from `mcpb/manifest.json`:

- SearXNG URL
- Enable hosted fallback
- Provider order
- TinyFish API key
- Exa API key
- Parallel API key
- Brave API key
- TinyFish location

API key fields must be marked sensitive in the manifest.

## Key model

Package users bring their own keys. The keys are stored by the MCP host or local system, not by Sol Research Labs and not in this repository.

## Developer fallback

Before a GitHub Release exists, developers can use the raw stdio config in `examples/claude-desktop.json` or run `pnpm mcpb:pack` locally after validation.
