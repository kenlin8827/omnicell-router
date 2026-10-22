# ADR-0012: L2-Decision-Emitted Thinking Effort (Decision Completeness)

## Status

Implemented — 2026-10-21. Scope: the L2 decision layer's decision output grows from `{tier}` to `{tier, effort}`, and the trace/result contract gains effort provenance (`effortSource`). Routing cascade = ADR-0001; effort vocabulary and honesty rules = ADR-0003; experience table = ADR-0011; session ratchet = ADR-0002.

## Context

The auto-routing decision layer decided only WHERE a prompt goes (tier), never HOW DEEP the served model should think (effort) — half a decision: a prompt decided hard enough for the pro tier could still run at the provider's own default (frequently no thinking at all), silently wasting the routing decision. Meanwhile the effort vocabulary (ADR-0003) had exactly four ways to acquire a level, and all four — the client field, a route-entry hit, retry escalation, the model's `defaultEffort` — inject by MUTATING `request.reasoning_effort` before the orchestrator reads it. The trace's `requestedEffort` therefore could not distinguish a client ask from a gateway decision: an honesty gap (the gateway's choice masqueraded as the client's).

Design constraints surfaced in review:

1. **Cost** — a decision layer-decided level spends thinking tokens the client never asked to spend; the feature must be opt-in.
2. **Cache hygiene** — the decision cache key (`provider::model::state`) must not resurrect decision layer effort after the operator turns the feature off.
3. **Feedback loop** — decision layer effort flows into the experience table via the existing `l2_confident` write-back; revision must be bidirectional or the table becomes a one-way cost ratchet.
4. **Degraded semantics** — `reasoningDegraded` compares served-rank against the EFFECTIVE ask; when the gateway authored the ask, the trace must still say so.

## Decision

### 1. The decision layer answers TWO questions in ONE call

System One `questions` is a map (`protocols/systemone/types.ts`): the decision layer now asks `tier` (existing) plus `effort` (a `choice` over the full 6-level `EFFORT_LADDER`, `none` included — "no thinking" is a legitimate judgment) in a single decision call — zero extra upstream latency, both native and converted paths iterate the whole map already. The effort question is asked ONLY when the client omitted `reasoning_effort`: an explicit client value is never second-guessed, and omitting the question keeps the answer space minimal. Effort-parse failure never sinks a good tier answer (partial success: tier kept, effort dropped).

### 2. `effortSource` — the ask's provenance is a first-class fact

`EffortSource = 'client' | 'l2-decision' | 'entry' | 'escalation' | 'default'`. The orchestrator snapshots the client's wire value before any injection and attributes each later mutation to its site. The value rides `ExecutionResult.effortSource` (surfaced as `X-OCR-Thinking-Source`), `ExecutionTrace.execution.effortSource`, and the routing `reasonParams`. `requestedEffort` keeps its established meaning — the EFFECTIVE ask the effort machinery served against — while `effortSource` says WHOSE ask it was. `reasoningDegraded` = served-rank < effective-ask-rank regardless of source: a decision layer-decided level clamped by capability is degraded exactly like a client ask (ADR-0003 honesty rules apply to the gateway's own decisions too).

### 3. Config gate — `classifier.layer2.effortDecision` (default FALSE)

L2-decided effort spends thinking tokens nobody explicitly ordered, so the feature is opt-in. The decision-cache namespace splits on the flag (`systemone` vs `systemone+effort`): toggling the gate can never resurrect a stale effort answer from a cache entry recorded under the other mode.

### 4. Effort floats per turn — never ratcheted

The session ratchet pins TIER for model-identity coherence (ADR-0002); effort stays a per-turn judgment with no monotonic floor. A pro-pinned session asked a trivial follow-up is served by the pinned pro model at a low effort — coherence of WHO answers, freedom of HOW DEEP. Decision effort confidence is trace metadata only; it never feeds the ratchet, the retry ladder, or any threshold.

### 5. The experience table learns effort bidirectionally

The existing `l2_confident` write-back already records the served `actualEffort` (ADR-0011 §2) — with decision-decided effort in play, entries gain effort through that SAME path; no new writer is added to the whitelist. Same-source overwrite revises an entry DOWN as readily as up (a fresh confident judgment replaces a stale one), so the table cannot act as a one-way cost ratchet on decision layer error. `correction` rows stay sticky exactly as ADR-0011 froze them (accepted failure evidence outranks prediction; a human edit is the escape hatch), and retry-escalation semantics are untouched — it remains a within-conversation failure ladder whose effort steps ride the same clamp machinery.

## Consequences

- `auto` + `effortDecision: true` = the gateway decides {where, how deep} per prompt; the console's Think column and the `X-OCR-Thinking-Source` header attribute every served level to its author.
- Default off = zero behavior or cost change without operator action; client-explicit requests are bit-identical in every mode.
- Graceful degradation: a decision layer that omits or garbles the effort answer yields `effort: undefined` — the turn behaves exactly as before this ADR.
- Tests: `layer2-systemone` (dual-question contract, parse tolerance, cache namespace split), `reasoning-effort-e2e` (decision layer injection, client precedence, source attribution on the trace), `trace-persistence` (source survives the disk round-trip), `ocr-headers` (the new header).
