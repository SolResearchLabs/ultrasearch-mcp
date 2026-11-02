# ADR 0004: Cost-Aware Hosted Search Ladder

## Status

Accepted, 2026-11-02.

## Context

Production research showed that a single scraped/metasearch upstream is not a reliable primary discovery layer for sustained agent traffic. The previous hosted fallback registry also allowed budget health to reorder providers, which could move a paid provider ahead of a still-usable free provider.

UltraSearch needs a deterministic search ladder that optimizes for reliability first and marginal cost second, while preserving independent provider circuits, hard budget caps, and explicit route provenance.

## Decision

The default hosted provider order is:

1. TinyFish
2. Parallel
3. Brave
4. Tavily
5. You.com
6. DeepSeek Search
7. Exa

The intended economic tiers are:

- TinyFish: free primary hosted search when configured.
- Parallel, Brave, Tavily, You.com: free-credit / free-tier pool. Operators should set hard monthly budget caps to their actual free allowance.
- DeepSeek Search: low-cost paid rescue.
- Exa: premium semantic rescue.

Provider order is authoritative. Budget state is a gate, not a reordering signal. A provider that is healthy or near its configured limit remains in its configured position. A provider is skipped only when it is unconfigured, hard-budget exhausted, or its budget is unverifiable under fail-closed policy.

No blind provider fanout is introduced. Searches remain sequential and stop at the first non-empty provider result.

Local routing modes remain unchanged. The hosted ladder is used when Core selects hosted search under local_first, hybrid, or hosted_only policy.

## Provider-specific policy

DeepSeek uses the raw Search API at `POST /v1/tools/search`, requests structured search results, and does not request page content by default. Site, language, and time constraints are encoded through DeepSeek-supported query operators.

Tavily uses basic search depth by default so one search consumes one credit. It does not request generated answers or raw page content.

You.com uses the Web Search REST API without extraction by default, so the adapter receives snippets without triggering full-page extraction costs.

TinyFish, Parallel, Brave, Tavily, You.com, DeepSeek, and Exa each retain their own circuit breaker, concurrency gate, and optional Valkey-backed hard budget.

## Deployment contract

Production configuration should set hard caps for providers whose free allowance is finite. A recommended starting posture is:

- Parallel: cap at the account's current free monthly request allowance.
- Brave: cap at the account's current free monthly search allowance.
- Tavily: cap at the account's current free monthly basic-search credit allowance.
- You.com: cap according to the active account credit grant or paid budget.
- DeepSeek: set an explicit operator spend cap in request units if desired.
- Exa: retain a conservative premium-provider cap.

TinyFish's published free plan is rate-limited rather than expressed as a monthly request allowance, so provider 429s are handled through its existing circuit/retry boundary rather than inventing a monthly quota.

## Consequences

A near-limit free provider cannot be silently displaced by a healthy paid provider.

The first successful provider still determines route provenance and caching.

Operators can override provider order, but an override is an explicit economic-policy decision rather than a side effect of budget health.

Search quality remains provider-dependent. This ADR does not claim that a cheaper provider is always better, only that paid escalation should happen after configured cheaper capacity has actually failed or become unavailable.
