# Architecture Decision Records (ADR)

> 🇨🇳 Chinese translation index & docs: [Chinese Version](./zh-CN/README.md).

This project adopts Architecture Decision Records (ADR) to document key architectural decisions, motivations, context, and trade-offs, ensuring long-term consistency and traceability.

> **Corpus reset 2026-10-15:** the historical numbering (0001–0021) was intentionally purged
> (commit 285e913 and successors). This tree is re-derived from CURRENT CODE FACT — every
> record describes shipped behavior, not the evolution that reached it. Cross-cutting
> vocabulary contracts: breaker states `CLOSED/HALF_OPEN/OPEN` live at the
> `CircuitBreaker` layer only; model-level aggregation reads capability terms
> `available/recovering/unavailable` (ADR-0004); the historical
> `ModelRef/ModelIdentity` type names never shipped and must not be reintroduced
> (ADR-0003).

## ADR Index

| ID | Title | Status | Date | Core Summary |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-routing-pipeline.md) | Routing Pipeline — Cascaded Tier Decision, Judge Cache | **Implemented** | 2026-10-21 | layer0 explicit choices / layer2 judge cascade / hardcoded plus baseline; response caching banned, decisions cached; quality-first shipped defaults |
| [ADR-0002](./0002-sessions.md) | Sessions — Identity, Ratchet, Pin Eviction, Credential Affinity | **Implemented** | 2026-10-15 | 7-layer zero-header identity; monotonic ratchet; pin evicted by config∨health with landing guard + write-back; affinity = forced-failover-only, no switch-back |
| [ADR-0003](./0003-model-addressing-and-tier-membership.md) | Model Addressing & Tier Membership | **Implemented** | 2026-10-15 | one resolution ladder (alias→id→variant→bare name→combo→classifier); members list = sole membership authority; combos self-owned pools; per-key access at 4 layers; effort honesty rules |
| [ADR-0004](./0004-resilience-and-health.md) | Resilience — Taxonomy, Breakers, Health View, Shaping | **Implemented** | 2026-10-15 | 7-class taxonomy with scoped trips; consuming gate vs non-consuming peek; live rule tree with contractual OFF-semantics; `ModelHealthView` capability vocabulary; per-env breaker memory vs global flags; rate-limit = separate axis |
| [ADR-0005](./0005-execution-topology.md) | Execution Topology — Direct, Single Choke Point | **Implemented** | 2026-10-15 | pure direct execution; boot pool from defs-file+store+catalog (unroutable → reported exclusion, never abort); `executeCandidatePool` as the one funnel; two-stage retry economics; SSE re-chunking; compression family + pre-compression fingerprint; measured cost, no savings theater |
| [ADR-0006](./0006-credential-store.md) | Credential Store — Capabilities, Key-Hash Identity | **Implemented** | 2026-10-15 | two adapters + readonly variant; branch on capabilities never kind; sqlite-read/HTTP-write; evidence-ladder factory, per-boot sticky; push-only convergence + authWriteDisabled; sha256(key) identity anchors breaker/suspect/affinity; OAuth excluded at every door |
| [ADR-0007](./0007-environments-and-bootstrap.md) | Environments — Book-Sets, Restart Switching, Export/Import | **Implemented** | 2026-10-15 | one directory layout, no legacy branch; OCR_ENV>pointer>default (customPath ≠ env lever); switch = controlled restart (PORT/HOST rules differ per child kind); 'ocr-env' envelope, redact-by-default, closed whitelist, guarded import; trash-based delete; sandbox reset |
| [ADR-0008](./0008-protocol-surfaces-and-capture.md) | Protocol Surfaces & Capture | **Implemented** | 2026-10-15 | one dispatch table for native+MITM legs; four inbound aliases only; full-capture MITM posture; requestCapture = HTTP-exchange events (2–4/turn), credential values redacted, default-off byte-identical; systemone two-gate capture + honest probability wording; responses.persist restart-amnesia bound |
| [ADR-0009](./0009-quota-probing.md) | Quota Tracking — Layered Knowledge, Declarative Probing | **Implemented** | 2026-10-15 | coverage ships with the release, activation follows credentials; four layers (header-harvest reserved / declaration table / code adapters / operator table); 12-construct DSL, five banned classes structurally unspellable; iron rules bind only operator config; probe failure ≠ quota failure; display-only, routing-gating banned; quota_events ledger at the breaker join point |
| [ADR-0010](./0010-provider-def-ownership.md) | Provider Definition Ownership — OCR Defs File, opencode.jsonc Materialized | **Implemented** | 2026-10-19 | connection defs own truth in `<ocrHome>/custom-providers.json` (shape-preserving jsonc port, parser unchanged); opencode.jsonc leaves the truth chain — sync-client materialization target (defs push write-only, reload self-heal survives); boot pool source swap; one-shot jsonc import with marker; v1 keys-only; page de-opencode-ized |
| [ADR-0011](./0011-route-entries-and-retry-escalation.md) | Route-entry Experience Table & Retry Escalation | **Implemented** | 2026-10-21 | persistent per-prompt memory (human-editable, snippet opt-out); write whitelist human > correction > l2_confident; entry hit short-circuits the judge; repeated-prompt ladder effort+1 → tier+1 (A3 capability jump); routing-ledger hash-only audit; shadow mode via escalateOnRetry |
| [ADR-0012](./0012-judge-emitted-thinking-effort.md) | Judge-Emitted Thinking Effort — Decision Completeness | **Implemented** | 2026-10-21 | judge answers {tier, effort} in ONE System One call (effort question only when client omitted); `effortSource` provenance (client/judge/entry/escalation/default) on trace + X-OCR-Thinking-Source; per-turn float, never ratcheted; experience table learns effort bidirectionally; cache namespaces on the gate; `classifier.layer2.effortDecision` default OFF |
