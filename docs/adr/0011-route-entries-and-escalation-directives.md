# ADR-0011: Route-entry Experience Table and Explicit Escalation Directives

## Status

Implemented — 2026-10-21. **Revised 2026-12**: the automatic repeated-prompt escalation ladder
(`retry-escalation.ts`, `SessionRetryState`, the `correction` write-back, the
`routeEntries.escalateOnRetry` knob) was deleted and replaced by the explicit `@ocr-*` directive
surface described in §4–§6. The experience table (§1–§3) is unchanged. Routing cascade =
ADR-0001; sessions/ratchet = ADR-0002; decision layer effort = ADR-0012; entry-mode autonomy =
ADR-0014.

## Context

Layer 1 and the learning flywheel are gone (ADR-0001), so the gateway keeps memory in exactly
one place: a per-prompt experience table. That part works — a recurring developer prompt is
served at the tier that served it well, without paying for a decision-layer call.

The first revision also added an automatic escalation ladder: a re-sent identical prompt was
read as "this answer wasn't good enough" and climbed effort → tier. In production that heuristic
carried four defects that no amount of tuning removed, because they are semantic, not
parametric:

1. **Repeat ≠ dissatisfaction.** Regenerate ("give me another version"), a double-send, and a
   client-side retry button all produce byte-identical repeats. None of them necessarily wants a
   more expensive model, and the gateway pays for the guess in real money.
2. **The signal's scope did not match the effect's scope.** The user expressed an opinion about
   ONE answer; the tier step rode the ratchet, so it became a session-wide ceiling. Every later,
   unrelated question was billed at the escalated tier.
3. **The length floor was language-blind.** `≥20 characters` is ~3 English words but a whole
   Chinese sentence, so a typical correction in the product's primary language ("still not right,
   do it again") was silently filtered as noise.
4. **The `correction` write-back used the weakest evidence for the strongest write.** "The next
   message had a different prompt" cannot distinguish acceptance from abandonment from ordinary
   conversation flow, yet it wrote a `confidence: 1.0` row that outranked `l2_confident`.

Explicit control fixes all four by construction: the user states the intent, the effect is
scoped to the turn, and nothing is inferred.

## Decision

### 1. RouteEntry — one row per normalized prompt

`{ promptHash, tier, effort?, source, confidence, sessions[≤20 LRU], hitCount, createdAt,
updatedAt, snippet? }`, persisted whole-file at `<envRoot>/data/route-entries.json` (2s debounced
save; a crash loses at most the debounce window). `promptHash` = sha256 prefix (16 hex) of the
whitespace-collapsed prompt. Directives are scrubbed out of the chain BEFORE hashing (§4), so a
directive-bearing turn hashes exactly like its directive-free twin. `snippet` = first 200 chars,
display/edit aid only, gated by `routeEntries.snippetEnabled` (default ON — same
default-visible + explicit-opt-out stance as session `attachOrigin`; the flag gates NEW snippets
and never deletes stored ones). Storage bound: `maxEntries` (default 5000), LRU eviction by
`updatedAt` — **human rows are exempt** (operator intent outranks capacity pressure).

### 2. Write whitelist — two producers, nothing else

- `l2_confident`: a Layer 2 judgment at/above 0.85 confidence, recorded POST-success with the
  tier that ACTUALLY served (failover/cascade truth beats intent). Schema-cascade turns are
  skipped — the lite lead owns those tier outcomes. When the decision layer also decided the
  effort (ADR-0012), the SERVED `actualEffort` rides the same write.
- `human`: a console edit. Confidence 1.0 and IMMUNE to automatic rewrite — operator intent
  outranks observed evidence; delete the row instead.

Priority: `human > l2_confident` (`route-entries.ts` SOURCE_RANK). Rows persisted by the retired
`correction` producer are folded into `l2_confident` at load (they are ordinary learned routes
now; no dead source label survives on the console).

**Directives never write back.** A manual override is a decision, not statistical experience —
baking it into the table would turn one user's one-off cost decision into everyone's routing.

### 3. Cascade position — lookup before the decision layer

`L0 rules → experience lookup → L2 decision layer → plus baseline`. An entry hit short-circuits
L2 (the table IS a prior judgment; `layerUsed: 'entry'`, reasonCode `entry.hit`) and applies the
entry's `effort` unless the client sent an explicit one. Explicit choices (`force_tier` —
including mode-forced ones, named models, combos) skip the table entirely.

### 4. `@ocr-*` directives — vocabulary and the scrub contract

Two forms per axis, one configurable namespace (`<prefix><suffix>`):

| token (default prefix) | effect |
| --- | --- |
| `@ocr-tier-up` | tier + 1 for this turn |
| `@ocr-tier-down` | tier − 1 for this turn |
| `@ocr-effort-up` | effort + 1 for this turn |
| `@ocr-effort-down` | effort − 1 for this turn |
| `@ocr-tier-lite` / `@ocr-tier-plus` / `@ocr-tier-pro` / `@ocr-tier-ultra` | PIN the turn to that tier |
| `@ocr-effort-none` … `@ocr-effort-max` (6 levels) | PIN the turn to that thinking level |
| `@ocr-continue` | NO axis effect — continue the previous reply |

STEP is relative to what the turn would otherwise have served. PIN names the destination
outright — and that is the form the session ceiling makes necessary: the ratchet bounds AUTOMATIC
escalation per session (ADR-0002/ADR-0014), so "I know I want ultra, now" must be expressible in
one token instead of counting `-up` presses (which still works: steps net out, so two `-up` equal
`tier-ultra` unless a clip intervenes). Both forms share one property: they act on the turn,
never on the session.

A PIN is a manual override, so it may point BELOW the automatic decision — that is an explicit
downgrade, legal only on user instruction (section 6), and ledgered with `direction: 'down'` so
the console can show whose judgement landed. When a pin and steps share an axis, the LAST pin
wins and the steps are recorded as `ignoredSteps` / `ignoredCause: 'pin_wins'` — never silently
dropped. A pinned effort is capability-clamped exactly like a client's explicit
`reasoning_effort` (degraded-or-equal, reported as `clamped`), because a pin is an absolute ask,
not a direction.

`@ocr-continue` sits outside the axes: a content-level token with NO tier/effort effect — its
entire semantics are the scrub plus the directive-only drop (below). Alone on the last user
message the turn continues the previous assistant reply at the unchanged level; the ledger
marks it `axis: 'continue'` so a promptless turn stays auditable.

**The namespace is configurable** (`directives.prefix`, default `@ocr-`). `ocr` is a common
industry acronym: an OCR-domain prompt may legitimately say `@ocr-pipeline` or `@ocr-v2`, and a
reserved namespace that collides with the customer's own domain vocabulary cannot be mitigated by
wording alone — it has to be relocatable without a code change. Validation is a closed shape —
`@` + lower-case slug + a trailing separator (`-`, `_`, `.`, `:`), 3–32 chars — so
`<prefix><suffix>` stays unambiguous; anything else falls back to the default at load (a bad
value must never silently widen or narrow what the gateway rewrites). Tokens are matched with a
word-character left boundary, so ordinary prose that merely CONTAINS the substring
(`alice@ocr-corp.com`) is outside the namespace. Relocating the prefix turns previously written
tokens into ordinary text (they are no longer scrubbed) and costs exactly one prompt-cache miss.
`directives.enabled: false` is a kill switch: no scrub AND no effect — the tokens then travel as
plain text. Both keys are hot-applied on console save (`pipeline/directive-gate.ts`).

Both contracts are unconditional and stateless (`pipeline/directives.ts`):

**SCRUB — every request, every message.** Every `<prefix>…` token is removed from EVERY role
(system / developer / user / assistant / tool) and every text part; a line that became blank only
because of the removal is dropped; a **user** message left with no content at all is dropped
(system / assistant / tool messages survive even when fully emptied). The
upstream-facing payload must be byte-equivalent to one that never carried a directive, so the
vendor never sees a reserved word and the prefix cache stays stable across turns. Unknown
`@ocr-*` tokens are scrubbed too (a typo must not leak) and reported to the ledger. The scrubbed
chain is what feeds hashing, snippets, traces and capture.

A message left with nothing but directives ("just continue") is dropped entirely; the chain then
ends on the previous assistant turn, which IS the continue semantic. Such a turn carries no prompt
identity of its own, so it can neither hit nor rewrite an experience row.

**APPLY — positional.** Only the LAST client-authored `user` message may act, and only for THAT
turn. This is what makes repeat sends idempotent: clients resend the whole history every turn, so
an effect read from any earlier message would re-escalate on every request. Tool results,
assistant text and system prompts are scrubbed but NEVER effective — otherwise a fetched web page
could force tier upgrades (cost amplification). Multiple tokens on one axis net out in order
(`up` then `down` = 0).

Operator-facing syntax reference: `docs/design/directives.md`.

### 5. Directive scope, clamps and precedence

- **Tier** is applied AFTER the session ratchet: a directive is a per-turn overlay, so it never
  raises `session.maxTier` and never re-pins the session (the turn is the signal's scope). On a
  directive tier turn the session pin is deliberately not followed, otherwise the directive would
  be a no-op for every established session.
- **Effort** baseline = the effective ask in play at that point — the client's own value, else the
  experience-table hit / L2 injection, else the served model's `defaultEffort`. The step is
  therefore relative to what the turn WOULD have served (the same symmetry as the tier axis, which
  steps from the post-ratchet decision, not from an absolute tier); the result is capability-clamped
  with the same degraded-or-equal rule as the rest of the effort machinery.
  It is written before model matching so an effort-aware pick can honour it; provenance becomes
  `effortSource: 'directive'`.
- Clamps: tier ∈ [lite, ultra], effort ∈ [none, max]. Clipped steps are reported as
  `clamped: true` in the ledger. A pin cannot be out of range (the vocabulary *is* the range),
  but it can be capability-clamped on the effort axis.
- Pin vs step on one axis: the pin wins, the ignored steps are counted (`ignoredSteps`), and both
  forms may coexist in one message.
- Precedence (high → low): client-explicit `model` / `force_tier` / combo → `@ocr-*` directive →
  L2 dynamic (tier, and effort above the floor) → experience table → L0 rules → plus baseline. An
  explicit client choice outranks a directive (`directive_ignored {cause: 'explicit_choice'}`).
- A directive-only prompt that would leave the chain with no user message at all is a loud 400.

### 6. Automatic machinery never steps down

Tier: L0 rules, the experience table and the L2 decision layer may only RAISE a turn above its
baseline (the existing monotonic ratchet, ADR-0002/ADR-0014). Downgrading is reserved for the
explicit `@ocr-tier-down` / `@ocr-effort-down` levers. Rationale is asymmetric harm: an over-served
turn costs money (visible, bounded, reversible), an under-served turn costs answer quality
silently. A classifier judging "this is not worth that much money" needs budget and priority
context it structurally does not have — that is a policy call, and policies belong to the
operator and the user.

Effort keeps one bounded exception: `classifier.layer2.effortDecision` may assign a level below
the model's `defaultEffort`, but never below `classifier.layer2.effortFloor` (default `low`). The
effort question is only asked when the client omitted the field, so a client-explicit ask is never
overridden at all; a floor clamp is ledgered as `effort_change`. Effort has no session state and
never invalidates a prompt-prefix cache, which is why it is safe to bind this way and a tier
downgrade is not.

### 7. Config and the ledger

`routeEntries: { enabled (default true), snippetEnabled (default true), maxEntries (default 5000) }`
— hot-applied on every console save. The retired `escalateOnRetry` key is stripped at load so it
cannot round-trip into a saved config. `directives: { enabled (default true), prefix (default
`@ocr-`) }` — validated at load by `resolveDirectivePrefix` and hot-applied through
`pipeline/directive-gate.ts`, because the namespace is a per-request scrub contract and a stale
copy would silently stop scrubbing the namespace the operator just changed.
`classifier.layer2: { …, effortDecision, effortFloor }`.

The `routing-ledger` (`<envRoot>/data/routing-ledger.jsonl`, append-only, prompt HASHES only,
64 MB cap + one warn) records: `entry_hit`, `entry_write`, `directive_applied` (axis, mode
`pin`/`step`, token, direction, from/to, delta, clamped, ignoredSteps), `directive_ignored`
(cause), `directive_unknown` (token), `effort_change`
(L2 floor clamp). Pure observability — never read back for routing.

## Consequences

- Escalation is now deterministic, idempotent and auditable: one token in, one step out, for one
  turn. Re-sending the same history five times produces five identical turns.
- Removed with the heuristic: the three-condition detector, the A3 capability jump, the
  `correction` write-back (and its sticky priority), the shadow-mode knob, and the two
  length-based skip paths. `SessionRetryState` / `recordTurnOutcome` are gone; sessions no longer
  carry retry bookkeeping.
- Cost control stays explicit: the only automatic upward pressure is the ratchet plus L2, and the
  only downward levers are `@ocr-tier-down` / `@ocr-effort-down` (per turn) and the session TTL.
- Known edge: a client whose own protocol swallows `@ocr-*` (e.g. it strips markup from outgoing
  text) simply never triggers a directive — it degrades to plain routing, never to a wrong one.
- Tests: `directives` (scrub/apply pure functions, prefix validation/relocation, pin semantics
  and pin-over-step precedence), `route-entries` (store semantics), `route-escalation-e2e`
  (orchestrator integration: per-turn scope, idempotence, injection defence, explicit-choice
  precedence, relocated prefix and the `enabled: false` kill switch, absolute pins including a
  pin below the ratchet ceiling, ledger).
