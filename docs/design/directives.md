# Escalation Directives — `@ocr-*`

Operator/user reference for the explicit escalation surface defined by
[ADR-0011](../adr/0011-route-entries-and-escalation-directives.md) §4–§6. Implementation:
`backend/src/pipeline/directives.ts` (pure functions) wired in `backend/src/pipeline/orchestrator.ts`
(§1.0 scrub, §4A tier axis, effort axis after the model-default pin).

## 1. Grammar

| token (default prefix) | effect (this turn only) |
| --- | --- |
| `@ocr-tier-up` | tier + 1 (`lite → plus → pro → ultra`) |
| `@ocr-tier-down` | tier − 1 |
| `@ocr-effort-up` | thinking effort + 1 (`none → low → medium → high → xhigh → max`) |
| `@ocr-effort-down` | thinking effort − 1 |
| `@ocr-tier-lite` / `plus` / `pro` / `ultra` | pin the turn to that tier |
| `@ocr-effort-none` … `@ocr-effort-max` | pin the turn to that thinking level |
| `@ocr-continue` | no axis effect — continue the previous reply (the directive-only message is dropped) |

- Namespace: `<prefix><suffix>`, where `prefix` is `directives.prefix` (default `@ocr-`) and
  `suffix` is one of the reserved words — the four steps, `continue`, the tier pins
  (`tier-lite` … `tier-ultra`), the effort pins (`effort-none` … `effort-max`). A token is any
  `[a-z0-9_-]+` run after the prefix; unknown tokens are scrubbed and ledgered
  (`directive_unknown`). Matching is case-insensitive (the ledger reports lower-case).
- **Why the prefix is configurable**: `ocr` is a common industry acronym, so an OCR-domain prompt
  can legitimately contain `@ocr-pipeline` / `@ocr-v2` — and with a fixed namespace that text would
  be silently deleted. Relocate it (`directives.prefix: '@onecast-'`) and `@ocr-…` becomes ordinary
  prose again. Allowed shape: `@` + lower-case slug + trailing separator (`-`, `_`, `.`, `:`),
  3–32 chars; invalid values fall back to the default at load. A word-character left boundary
  keeps prose that merely contains the substring (`alice@ocr-corp.com`) out of the namespace.
  Moving the prefix turns previously written tokens back into text and costs one prompt-cache miss.
- `directives.enabled: false` disables BOTH halves (no scrub, no effect) — the tokens then reach
  the upstream as plain text. Both keys are hot-applied on console save.
- Placement: anywhere inside the text of the **last** `user` message — inline, prefix, suffix, or
  on its own line. A line that becomes blank because the token was removed is dropped entirely, so
  the prompt reads as if the directive had never been typed.
- Multiplicity: step tokens on the same axis net out in textual order (`up` then `down` = 0).
  Different axes stack (`@ocr-tier-up @ocr-effort-up` moves both).
- Pin vs step: a pin names an absolute level and OUTRANKS steps on its axis (the last pin wins);
  the outranked steps are ledgered as `ignoredSteps`. A pin may sit below the automatic decision —
  that is an explicit downgrade, and `direction` in the ledger says which way it went. Pins are
  the reason a session ceiling never traps you: the ratchet caps AUTOMATIC escalation only.
- No prompt at all (`@ocr-continue`, or any directive alone): the message is dropped and the chain
  ends on the previous assistant turn. With a bare axis token that is "just continue, but
  stronger"; with `@ocr-continue` it is the neutral continue — the tier/effort the turn would
  otherwise have served stay untouched. With no history at all the request fails loud with
  HTTP 400.

```
@ocr-tier-up rewrite this SQL join so it uses the covering index

explain the CAP theorem
@ocr-effort-down
```

## 2. What always happens (SCRUB)

Every request, every message, every role (system / developer / user / assistant / tool), every
text part:

1. every `<prefix>…` token is removed, **known or not** (a typo such as `@ocr-tier-upx` must not
   leak upstream, and is reported as `directive_unknown`);
2. a line emptied only by the removal is deleted; a message left with no content is dropped;
3. the scrubbed chain is what feeds prompt hashing, snippets, traces, upstream capture and the
   forwarded payload.

Consequence: the upstream request is byte-equivalent to one that never carried a directive, so the
prompt-prefix cache stays stable across turns, and resending history can never resurrect an old
directive's effect.

## 3. What only sometimes happens (APPLY)

Effective only when ALL of the following hold:

| condition | why |
| --- | --- |
| the token sits in the **last** user message | positional-only → repeat sends are idempotent |
| that message came from the **client** (not a tool result) | a fetched page must not be able to force upgrades |
| the turn is auto-routed (`sessionMode === 'ratchet'`) | an explicit client choice already decided |

When the client named a model, forced a tier, or chose a combo, the directive is ignored and the
ledger records `directive_ignored { cause: 'explicit_choice' }`.

## 4. Scope: the turn, not the session

- **Tier** is applied AFTER the monotonic ratchet, so it never raises `session.maxTier`, never
  re-pins the session, and never leaks into later turns. On a tier-directive turn the session pin
  is deliberately not followed — otherwise the directive would be a no-op for every established
  session.
- **Effort** baseline = the effective ask already in play: the client's value, else the
  experience-table hit / L2 injection, else the served model's `defaultEffort`. So the step is
  relative to what the turn would otherwise have served — symmetric with the tier axis, which steps
  from the post-ratchet decision. The result is capability-clamped (degraded-or-equal, the same rule
  as the rest of the effort machinery) and written before model matching so an effort-aware pick can
  honour it. Provenance becomes `effortSource: 'directive'` (surfaced as
  `X-OCR-Thinking-Source: directive`).
- Clamps: tier ∈ `[lite, ultra]`, effort ∈ `[none, max]`; a clipped step is reported as
  `clamped: true` in the ledger and `reasoningDegraded` is computed against the directive's ask.

## 5. Precedence

```
client-explicit model / force_tier / combo   (highest — directive ignored)
@ocr-* directive
L2 decision layer (tier; effort above the floor)
experience table (l2_confident / human rows)
L0 rules
plus baseline
```

## 6. Interaction with the rest of the system

| subsystem | interaction |
| --- | --- |
| experience table | a directive turn is hashed on the scrubbed prompt (no double rows) but **never** written back; a pure "continue" turn has no prompt identity at all, so it cannot hit or rewrite a row |
| session ratchet | untouched by construction (overlay applied after it) |
| L2 decision layer | tier proposals keep their monotonic "up only" behaviour; `classifier.layer2.effortFloor` (default `low`) bounds the model's own effort answer, clamped values are ledgered as `effort_change` |
| resilience / failover | unaffected — the directive only changes the requested tier/effort, so breaker filtering, in-place retry and cross-tier escalation behave normally |
| combos | bypass — no directive applies |

## 7. Audit

`data/routing-ledger.jsonl` (hash-only, append-only, 64 MB cap):

| kind | detail |
| --- | --- |
| `directive_applied` | `axis`, `from`, `to`, `delta`, `changed`, `clamped` (+ `model` on the effort axis) |
| `directive_ignored` | `cause: 'explicit_choice'`, `sessionMode`, `tokens` |
| `directive_unknown` | `token`, `role` |
| `effort_change` | `source: 'l2-decision'`, `baseline: 'floor'`, `from`, `to`, `floor` |

The console shows the effect of a directive turn in the request-detail reason line
(`directive.tier_up`, `directive.tier_down`, `directive.effort_up`, `directive.effort_down`) and in
the Think column's "Asked by: @ocr directive".

## 8. Failure modes and edges

- **A client that mangles markup** (strips `@…` from outgoing text) never triggers a directive —
  it degrades to plain routing, never to a wrong route.
- **Both axes on one turn**: the tier directive owns the reason line; the effort overlay rides
  `reasonParams.effort`.
- **Ceiling**: `@ocr-tier-up` at ultra (or `@ocr-effort-up` at max) is a ledgered no-op
  (`changed: false, clamped: true`), never an error.
- **Model without explicit effort control**: an explicit **empty** support set
  (`supportedReasoningEfforts: []`, `supportsReasoningEffort: false`) makes effort directives
  no-ops. A model declaring **neither** field is different: the step is still raised into the
  request, then honestly degraded by the executor (`reasoningDegraded`, `actualEffort: 'none'`).
- **Directive-only history entries**: older directive-bearing messages in the resent history are
  scrubbed and never applied again.
