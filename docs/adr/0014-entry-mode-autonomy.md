# ADR-0014: Entry-Mode Autonomy — Tier & Effort Switching Matrix

- **Status**: Implemented
- **Date**: 2026-10-21
- **Related**: ADR-0001 (routing pipeline), ADR-0002 (sessions/ratchet), ADR-0003 (model addressing), ADR-0011 (retry escalation), ADR-0012 (judge effort)

## Context

A gateway serves several entry modes on one wire: the `auto` cascade, the tier-forced aliases
(`auto-lite/plus/pro/ultra`), the global routing-mode lever (`routing.mode: cost|quality`),
client-sent `router_options.force_tier`, explicitly named models (full id / `#variant` / bare
upstream name), and configured combos. Each mode carries a different client intent — but every
tier/effort mutation the gateway can perform (session ratchet, retry ladder, schema-assertion
cascade, cross-tier pool tail) must know WHICH intents authorize it. A 2026-10-21 audit found
three paths where a FORCED tier was silently crossed (details in §History); this ADR freezes the
corrected matrix as a contract.

## Decision — the autonomy matrix

| Entry mode | Tier may move by gateway judgment? | Effort may be inferred? | Session interaction |
| :--- | :--- | :--- | :--- |
| `auto` / `default` / unregistered names (classifier) | **YES** — full autonomy | YES (judge, entry table, retry ladder) | `'ratchet'` — upgrade, downgrade interception, pin read/follow |
| Forced tier: `auto-*` alias, `routing.mode` lever, `router_options.force_tier` | **NO** — the forced tier is a contract | NO inference (client value / variant pin / model spec only) | `'explicit'` — recorded, proposal NEVER rewritten downward; a forced tier ABOVE the peak is a sanctioned ceiling rise (re-pins the session, as any upgrade); at/below the peak the pin in another tier is neither followed nor rewritten (untouched for later auto turns); zombie ids repair to the forced tier's healthy head; the empty-tier degraded landing still follows |
| Explicit model (full id / `#variant` / bare name) | **NO** — the named model serves; failover within its tier only | NO inference (same as forced tier) | `'explicit'` — plus pin write-back when the named model served |
| Combo | **NO** — the composition is authoritative | NO | `'bypass'` — no session entity, no pin, no ceiling |

### What counts as a tier move (all gated to the auto family)

- **Monotonic session ratchet interception** — `session.sticky` / `session.ratchet` /
  `session.preserved` rewrites (session-manager `applyRatchet`, `allowIntercept`).
- **Retry-escalation ladder** — `retry.effort` / `retry.tier` (ADR-0011); `retryEligible` =
  detection ∧ `!comboId` ∧ `!explicitModel` ∧ `!force_tier`.
- **Schema-assertion lite-lead cascade** — 5A/5B: lite first, assert, escalate to
  `fallback.escalateTier` on failure. Arms only for the auto family; both directions are tier
  moves (lite-lead serves BELOW a forced plus; the escalation leg serves ABOVE a forced lite).
- **Cross-tier pool escalation tail** — `executeCandidatePool({ allowEscalate })` appends plus
  candidates behind an exhausted lite chain. Arms only for the auto family
  (`!explicitModel ∧ !force_tier ∧ tierCrossPolicy='allow_escalate' ∧ tier='lite'`).

### What is NOT autonomy (applies in every mode)

- **Capability clamps** — effort maps and `resolveServedEffort` translate the ask to what the
  serving model supports (`reasoningDegraded` honesty, ADR-0012). Translation, not judgment.
- **Model `defaultEffort`** — serving a model at its own declared default level (ADR-0012
  `effortSource: 'default'`) is the model's spec, not an inference about the request.
- **In-tier failover** — breaker-driven candidate walks never leave the tier pool; attempt caps
  per mode (auto: configured budget; explicit/combo: chain length).

## Rationale

1. **A forced choice is a routing decision the client already made.** Silently crossing it is
   the same invisible billing/model drift the combo fail-fast contract exists to forbid
   (ADR-0003) — in BOTH directions: a forced plus must not be lite-led into cheaper models, and
   a forced lite must not escape into plus on an outage or a schema failure. Fail loud instead.
2. **The ratchet protects auto conversations, not client-authored choices.** A forced alias
   mid-conversation is a one-turn override: at or below the session peak it never downgrades
   or rewrites anything (a later bare `auto` turn still rides the peak); a forced tier ABOVE
   the peak is a sanctioned ceiling rise (re-pins like any upgrade).
3. **Observability stays honest.** Forced turns carry the `explicit.model` / `forced` reason
   vocabulary — never a tier-judgment code with a badge (ADR-0001 §4 explicit-model honesty).

## Implementation anchors

- `orchestrator.ts` §3B `retryEligible`; `routeAutoDecision` entry gate (`!force_tier`);
  `RouterEngine.routeAsync` forced early-return (judge unreachable for forced tiers).
- `orchestrator.ts` §4 `sessionMode` resolution — `explicitModel || force_tier → 'explicit'`.
- `orchestrator.ts` §5 cascade gate (`!explicitModel ∧ !comboId ∧ !force_tier`);
  direct-path `allowEscalate` tail gate; combo `needsSchemaValidation: false`.
- `session-manager.ts` `applyRatchet({ allowIntercept })` — explicit mode records without
  rewriting; bypass never calls it.

## History

- 2026-10-21: audit found forced tiers crossed by the schema cascade (both directions), the
  plus pool tail, and ratchet interception; all three gates closed and
  `retry.test.ts` rewritten to encode the contract (auto entry-hit lite keeps the tail;
  forced lite fails loud).
- 2026-10-21: pin-follow refinement — a forced turn follows the session pin only within the
  forced tier (KV affinity), repairs zombie ids to the forced tier's healthy head, and keeps
  the empty-tier degrade landing; a pin living in another tier is neither followed nor
  rewritten (`pin-eviction.test.ts` cross-tier-move assertion updated accordingly).
