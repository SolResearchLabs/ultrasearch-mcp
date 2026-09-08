# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories when available. Do not open a public issue for secrets exposure, request smuggling, SSRF bypasses, token leakage, or provider billing bypasses.

Include a reproduction path, affected version or commit SHA, expected impact, and safe logs with secrets removed.

## Security design goals

- Provider API keys stay server-side.
- Logs must never include API keys or bearer tokens.
- Hosted provider calls are controlled by explicit configuration and budget guardrails.
- Fetch tools guard against private and internal network targets.
- HTTP transport should be placed behind network controls, a reverse proxy, or an auth gateway.
