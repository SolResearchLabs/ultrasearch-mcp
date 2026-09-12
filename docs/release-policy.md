# Release Policy

UltraSearch packages must preserve the local-first product contract and must
not contain user credentials.

## Release boundary

No npm publish, MCP Registry publish, container registry push, tag, public
release, deployment, or cloud mutation occurs without explicit owner approval.
This policy applies independently to MCP, CLI, Docker, and future desktop
artifacts.

## Required release evidence

Before an approved release, record the package version and commit, changed
paths, validation commands and exit codes, package-content inspection, and
credential-pattern scan. Verify that product defaults, generated examples,
MCPB configuration, runtime documentation, and the canonical schema agree on
`http://127.0.0.1:8099`.

After `FULL-PACKAGE-002` adopts the router, release validation must confirm
the five routing modes and their user-visible disclosures. It must show that
hosted providers remain BYOK backups and that Firecrawl is optional remote
fetch/crawl escalation.

## Artifact policy

Artifacts ship documentation and configuration examples with empty credential
fields or non-sensitive placeholders. They do not ship shared API keys, tokens,
authorization headers, user configuration, logs, or support reports containing
credentials.

The release story may describe only implemented behavior. Planned managed
runtime and desktop capabilities remain clearly identified as future work until
they are implemented, tested, and accepted.
