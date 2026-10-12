# ADR-0010: Routing Decision Cache (Layer 2 Judge Result Reuse)

## Status

Accepted — 2026-10-07
Related: [ADR-0006 Session Ratchet](0006-monotonic-session-ratchet-and-prefix-fingerprinting.md) (in-session stickiness; this ADR covers cross-session reuse), [ADR-0001](0001-purge-fuzzy-semantic-cache.md) (response-level caching stays removed — **out of scope for this ADR**).

## Context

In this project's vocabulary, "routing cache" = **a cache of routing decisions**, not a response cache. Two existing mechanisms already cover most cases:

- Session ratchet (ADR-0006): locks `pinnedModel` within a session, sticky across turns — already shipped;
- Layer 1 local classifier: regex/intent probing, <2ms, zero network — needs no cache.

The remaining gap: **the Layer 2 semantic judge** (`backend/src/router/layer2-judge.ts`) issues one external model call per tier verdict (`timeoutMs` default 2000ms + token cost), while the verdict for the same conversation context is deterministic — repeated requests pay the price again for nothing.

## Decision

Build an LRU+TTL decision cache inside `Layer2Judge.evaluate()`:

1. **Cache key** = `${provider}::${model}::sha256(userText)` (userText is the concatenated text of the last 4 turns built inside evaluate; after a provider/model change, old entries naturally miss);
2. **Cache value** = `{ targetTier, confidence, reason }` (rawResponse is not stored, saving memory); on a hit, `reason` is prefixed with `[Decision Cache]`, visible in ExecutionTrace.routing.reason;
3. **Only successful Layer 2 decisions are cached** (null/timeout/exception are not written); Layer 1 is not cached;
4. **Configuration**: `Layer2JudgeConfig.decisionCache: { enabled (default true), ttlSeconds (default 1800), maxEntries (default 500) }`; changes take effect on gateway restart;
5. **Observability**: `Layer2Judge.getCacheStats()` → `{ entries, hits, misses, hitRatio }`, aggregated into the `routingCache` section of `GET /api/ui/cache-stats`, displayed on the CachePage.

## Risks / Boundaries

- **The cost of a wrong verdict is a suboptimal route** (off-tier), never content pollution — this is the essential difference from the response cache rejected by ADR-0001, and the risk is an order of magnitude lower;
- Same text with a switched user intent (resending identical text) hits the same decision — the decision is a classification value, not content; acceptable;
- Unit-test coverage: same-text hit / different-text miss / TTL expiry / LRU eviction / provider/model mismatch.

## Consequences

- Repeated Layer 2 verdicts cost zero network and zero tokens; since Layer 2 itself triggers only when Layer 1 is inconclusive, the benefit concentrates on repeated/similar contexts after the first verdict;
- If Layer 2 later moves to embedding-based inputs, the key construction must be upgraded in sync (an extension point is kept in `buildCacheKey`).
