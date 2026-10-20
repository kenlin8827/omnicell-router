# ADR-0011: Route-entry Experience Table and Retry Escalation

## Status

Implemented — 2026-10-21. Scope: the persistent routing memory that replaced the deleted learning flywheel (ADR-0001 rewrite), and the repeated-prompt escalation ladder. Routing cascade = ADR-0001; conversation/session policy = ADR-0002.

## Context

With Layer 1 and the flywheel deleted, the gateway had no memory between conversations: every auto request re-derived its tier from scratch (judge or plus baseline), and a user dissatisfied with an answer had no automatic recourse. Two cheap, honest signals were being discarded:

1. **Cross-conversation**: "this exact prompt was served at tier X before" — a persistent, hand-editable experience table beats re-judging the same bytes.
2. **Intra-conversation**: "the user re-sent the SAME prompt" — the only reliable dissatisfaction signal available at the gateway (thumbs-down buttons belong to clients). One repeat = "think deeper"; more repeats = "get a stronger model".

## Decision

### 1. RouteEntry — one row per normalized prompt

`{ promptHash, tier, effort?, source, confidence, sessions[≤20 LRU], hitCount, createdAt, updatedAt, snippet? }`, persisted whole-file at `<envRoot>/data/route-entries.json` (2s debounced save; crash loses at most the debounce window). `promptHash` = sha256 prefix (16 hex) of the whitespace-collapsed prompt — the same normalization feeds the retry detector. `snippet` = first 200 chars of the prompt, display/edit aid only, gated by `routeEntries.snippetEnabled` (default ON — the same default-visible + explicit-opt-out privacy stance as session `attachOrigin` and the retired flywheel's `logUserPrompt`; the flag gates NEW snippets, never deletes stored ones). Storage bound: `maxEntries` (default 5000), LRU eviction by `updatedAt`.

### 2. Write whitelist — three producers, nothing else

- `l2_confident`: a Layer 2 judgment at/above 0.85 confidence, recorded POST-success with the tier that ACTUALLY served (failover/cascade truth beats intent). Schema-cascade turns are skipped — the lite lead owns those tier outcomes.
- `correction`: an escalated retry that the user ACCEPTED. Acceptance is observable exactly one way: a LATER message with a different prompt hash ("moved on"). Satisfied-and-left never writes back — accepted bounded loss. Confidence 1.0 (executed evidence).
- `human`: a console edit. Confidence 1.0 and IMMUNE to automatic rewrite — operator intent outranks observed evidence; delete the row instead.

Priority: `human > correction > l2_confident` — a row never loses certainty (`route-entries.ts` SOURCE_RANK).

### 3. Cascade position — lookup before the judge

`L0 rules → experience lookup → L2 judge → plus baseline`. An entry hit short-circuits L2 (the table IS a prior judgment; `layerUsed: 'entry'`, reasonCode `entry.hit`) and applies the entry's `effort` unless the client sent an explicit one. Explicit choices (`force_tier` — including the mode-forced ones, named models, combos) skip the table entirely.

### 4. Retry ladder — three conditions, monotonic steps

Detection (all three, `retry-escalation.ts`): the previous COMPLETED turn succeeded + the prompt is ≥ 20 normalized chars + the hash matches. Failed turns leave no retry-state trace, so technical resends never count.

Ladder (from what ACTUALLY served last turn):

| attempt | action |
| --- | --- |
| 1 | same tier, effort + 1 (written into `reasoning_effort`; the existing effort machinery translates/clamps) |
| 2+ | tier + 1, effort falls back to default |
| ceiling | ultra, then no proposals |

Capability ceiling (frozen decision A3): when the pinned model cannot serve the next effort level, the +1 step would clamp to a no-op — the planner JUMPS STRAIGHT to tier + 1 (`cause: effort_ceiling`). The pin itself is never broken for an effort step. Tier steps flow through the normal monotonic ratchet (upgrade = sanctioned re-pin, ADR-0002); sticky-strategy sessions flatten tier proposals by design (operator chose stability). Attribution rides `reasonParams.retry` + `attempt` (the ratchet's session.* reasonCode rewrite preserves merged params).

### 5. Shadow mode and the ledger

`routeEntries.escalateOnRetry: false` = shadow mode: detection and recording continue, nothing acts. The `routing-ledger` (`<envRoot>/data/routing-ledger.jsonl`, append-only, prompt HASHES only, 64 MB cap + one warn) records every lifecycle event: `retry_detected`, `entry_hit`, `entry_write`, `escalation`, `correction`. It is the flywheel's replacement as audit trail — pure observability, never read back for routing.

### 6. Config

`routeEntries: { enabled (default true), snippetEnabled (default true), escalateOnRetry (default true), maxEntries (default 5000) }` — hot-applied on every console save (decision-capture pattern). `enabled: false` freezes the subsystem: no lookup, no writes, no ledger.

## Consequences

- Repeated dissatisfaction self-heals within one conversation; the fix persists across conversations (and survives restarts via the JSON file).
- The console `/route-entries` page makes every learned row browsable and hand-editable — the "memory is observable and human-editable" requirement, verbatim.
- Honesty edges: a satisfied user who leaves writes nothing back (the table keeps the pre-escalation tier until a correction lands); a user who rephrases instead of repeating still counts as acceptance.
- Tests: `route-entries` (store semantics), `retry-escalation` (detection + ladder), plus the existing ratchet/orchestrator suites for the integration seams.
