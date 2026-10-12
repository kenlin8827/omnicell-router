# ADR-0016: requestCapture — System One Leg Capture and the Capture/Dataset Split

## Status

Proposed — 2026-10-12. Layer: surface. Scope: capture. Domain: observability.
Rewritten the same day to the final approved tree (Decision Outcome).
This record's earlier passes — client-leg opt-in via
`capture.systemoneEnabled`, the `capture.l2DecisionEnabled` namespace
move, and the intermediate (NEVER-SHIPPED) name
`requestCapture.systemone.clientEnabled` — are SUPERSEDED by this rewrite
and preserved as history in
Key-lineage & ambiguity guard.
Supersedes ADR-0014 §4's capture-records limb (SUPERSEDED for the client
leg, EXTENDED for the judge leg) and §5's dataset limb as written (key,
default, cap). ADR-0014 is Implemented and immutable; this record carries
the supersession, and ADR-0015's "Amendment to ADR-0014" section carries a
pointer to this final tree.

## Context and Problem Statement

Operators run ONE capture/observability console for the whole gateway.
Every other HTTP surface emits exchange events into it — chat, anthropic
and responses, on both transports (native `/v1` and the MITM leg,
ADR-0015). `POST /v1/systemone` was the sole exception, silent by
ADR-0014 §4 (pinned verbatim in Key-lineage & ambiguity guard). In a
console that otherwise shows everything, a first-class surface invisible
on the capture page confused operators: decision traffic had to be
audited elsewhere, or not at all. Read in context, the §4 silence was v1
scope discipline, not an anti-observability stance. The default posture
should be what the operator sees when they change nothing; the CHOICE,
though, belongs to the operator.

The day's history, compressed honestly:

1. First pass: opt-in client-leg capture behind `capture.systemoneEnabled`
   (default OFF) — answered the console blindness, kept one `capture:`
   umbrella.
2. Second pass (the "B-case" namespace move): the decision-sampling knob
   of ADR-0014 §5 moved out of `classifier` into
   `capture.l2DecisionEnabled`, chained behind three `capture.*`
   switches.
3. That move revealed a deeper ambiguity: `capture.*` hosted TWO
   different persistence semantics. HTTP-exchange capture is an archive
   (dir, retention, total-size cap, sanitized headers, the capture
   page); the flywheel training dataset is ONE capped jsonl of
   (state, answer, tier) samples — distillation raw material, never on
   the capture page. One namespace had come to mean two subjects, and a
   dataset knob under the capture umbrella implied something false:
   that samples are capture records.
4. Final restructure: separate by SUBJECT. `requestCapture:` = request /
   HTTP exchange logging, nothing else. `classifier.layer2.collectEnabled`
   = dataset sampling, nothing else. And exchange capture additionally
   gains one leg §4 never addressed: the Layer 2 judge's internal
   upstream call.

The problem: split the two persistence semantics by subject, give the
operator per-leg control over systemone exchange capture, and keep a
config-silent deployment seeing exactly the ADR-0014 §4 posture.

## Decision Drivers

- Control belongs to the operator; defaults preserve the privacy master.
- One namespace, one meaning: where a key lives states WHAT persists.
- Default-safe: zero config change = zero exchange events.
- Structural guarantees over conventions — types, loud load-time warns,
  invariant tests (the ADR-0015 way).
- Console coherence: no invisible first-class surface; every recorded leg
  is disclosed by name (`purpose` marker).
- Migration honesty: every retired key warns once and names exactly one
  successor.

## Considered Options

### A. Keep both semantics under one `capture:` umbrella (day pass 2)

**Pros**

- Single privacy chain: master → surface → detail, one namespace.
- No third rename for the dataset knob.

**Cons**

- Two persistence subjects in one namespace — cures the blindness by
  institutionalizing the ambiguity the move had just exposed.
- `capture.l2DecisionEnabled` (dataset) would collide with the judge-leg
  capture knob forever: same words, different subject.
Rejected (this rewrite unwinds exactly this state).

### B. Split by subject: `requestCapture:` + `collectEnabled` (chosen)

**Pros**

- Each namespace means exactly one thing: exchange logging vs dataset
  sampling.
- Knobs live beside their subject; gates shrink to their real chains.
- A leg sub-node gives per-leg operator control with defaults that
  disclose fully once the master flips.

**Cons**

- Third key name for the dataset knob within two days (lineage table +
  load-time warns carry it; the keys are day-old).
- Two similarly-named final knobs (`collectEnabled` vs
  `systemone.l2DecisionEnabled`) need an explicit ambiguity guard.

### C. Revert the dataset knob to `classifier.layer2.decisionCapture`

**Pros**

- Zero delta against ADR-0014 §5 as written.

**Cons**

- Puts the word "capture" back on a non-capture subject — the exact
  ambiguity being cured. Rejected.

## Decision Outcome

Chosen option: "B. Split by subject", because a namespace must mean one
thing. The governing principle for every key and default below: CONTROL
BELONGS TO THE OPERATOR, DEFAULTS PRESERVE THE PRIVACY MASTER.

The final approved tree (frozen contract, 2026-10-12):

```yaml
requestCapture:                     # renamed from `capture:` — request
  enabled: false                    # capture ONLY (one meaning per
                                    # namespace). Privacy master: opt-in,
                                    # default unchanged.
  retentionDays: 7                  # archive members: names, defaults
  maxTotalMB: 512                   # and semantics all unchanged — only
  maxBodyBytes: 65536               # the section heading moved.
  dir: ~/.opencode-router/capture
  systemone:                        # surface master + judge-leg sub-switch
    enabled: true                   # System One SURFACE MASTER — off
                                    # silences BOTH legs: client-direct
                                    # /v1/systemone and MITM-leg HTTP
                                    # exchange events (former
                                    # capture.systemoneEnabled; the
                                    # intermediate `clientEnabled` never
                                    # shipped) AND the judge leg below.
    l2DecisionEnabled: true         # SUB-switch (effective only when
                                    # systemone.enabled is true): NEW: the
                                    # Layer-2 router judge's internal
                                    # systemone decision calls recorded as
                                    # upstream-leg http-exchange events,
                                    # attached to the OUTER routed request's
                                    # trace/session, purpose='l2-judge'.
                                    # Adds the judge's wire call only —
                                    # subject-orthogonal to the client leg.
                                    # NOT a client request;
                                    # off = silent today-behavior.
classifier.layer2:
  enabled: true                     # the judge runs at all — orthogonal
                                    # feature switch, untouched here.
  collectEnabled: false             # TRAINING DATASET knob (former
                                    # classifier.layer2.decisionCapture,
                                    # briefly capture.l2DecisionEnabled):
                                    # (state, answer, tier) ->
                                    # data/layer2-decisions.jsonl.
                                    # Single-key gate, hot-applied, 64MB
                                    # hard cap then stop-write + one
                                    # warn. NOT capture; NOT on the
                                    # capture page.
```

### Decision 1 — `capture:` renamed to `requestCapture:` (load-time migration)

- The section hosts request/HTTP exchange logging ONLY; the name states
  what lands: exchange records of requests.
- Members keep their identity: `enabled`, `retentionDays`,
  `maxTotalMB`, `maxBodyBytes`, `dir` — same defaults, same semantics.
- Load-time section migration: a legacy `capture:` section is mapped at
  load into `requestCapture:` and emits a LOUD one-time warn:
  - plain members map by name (`capture.enabled` →
    `requestCapture.enabled`, and the other archive members likewise);
  - `capture.systemoneEnabled` →
    `requestCapture.systemone.enabled` (the surface master; a parsed
    never-shipped intermediate `requestCapture.systemone.clientEnabled`
    folds onto `enabled` defensively), named in the warn;
  - `capture.l2DecisionEnabled` → `classifier.layer2.collectEnabled`,
    with the ambiguity-guard wording of Key-lineage & ambiguity guard.
- Console-save strips legacy: a config saved from the console carries
  the final tree only — one warn, one migration, no permanent compat
  layer.
- `requestCapture.enabled` remains the privacy master: default `false`;
  flipping it is the opt-in act.

### Decision 2 — `requestCapture.systemone` group (surface master + judge sub)

- `systemone.enabled` (default `true`): the System One SURFACE MASTER —
  off silences BOTH legs at once. When on, its leg is the FULL-CHAIN HTTP
  exchange events of client-direct `POST /v1/systemone` and of the MITM leg
  claiming `/systemone` — client request, the surface's own upstream call
  (native passthrough / synthesized conversion), gateway response — on both
  transports (the ADR-0015 seam). Former `capture.systemoneEnabled`; the
  intermediate name `clientEnabled` never shipped to any live config.
- Effective gate, client leg:
  `requestCapture.enabled && requestCapture.systemone.enabled`.
- The group knobs default `true` because the capture MASTER is the opt-in act:
  flipping `requestCapture.enabled` yields complete disclosure of the
  surface, not a second hunt for switches. Partial-default legs would
  reintroduce invisible traffic under an explicit "capture on" decision.
- Type seam (the ADR-0015 surface table): `DecisionSurface.capture`
  widens from the literal `false` to the literal `'configurable'` —
  capture on this surface is resolved at runtime from config, never by
  accident. `ChatSurface.capture` stays `true`.

### Decision 3 — judge-leg capture (new capability)

- What: the Layer 2 router judge's internal systemone decision calls
  (`runSystemoneDecision`) are recorded as UPSTREAM-LEG http-exchange
  events.
- Where they attach: the OUTER routed request's trace/session — the
  client request whose routing invoked the judge. NOT a client request:
  the judge is not a surface and gets no standalone record.
- Every such event carries `purpose='l2-judge'`.
- Effective gate: `requestCapture.enabled &&`
  `requestCapture.systemone.enabled` (surface master) &&
  `requestCapture.systemone.l2DecisionEnabled` (sub — effective only under
  the surface master). Off = silent
  today-behavior: zero judge-leg exchange events.
- This EXTENDS §4's record class rather than restoring the client limb:
  §4 excluded capture for the HTTP surface; the judge's internal wire
  traffic never had a capture story at all.
- Race-loser honesty: the judge's `timeoutMs` can lose the Layer 1 /
  Layer 2 race while the wire call keeps running — providers own their
  AbortControllers, so the converted path cannot be cancelled mid-flight
  (ADR-0014 §5). Capture records wire reality, not race outcome: BOTH
  real calls may be recorded, the winner's and the loser's. The dataset
  path keeps its race-winner-only rule; the two sinks differ on purpose.

### Preserved limbs (carried from pass 1, keys renamed)

- Gate ordering, client leg: parse-400 and access-gate 403/404 produce
  NO events; capture emits after the gates, mirroring the chat surfaces.
- Sanitization: the shared capture recorder's header sanitizer applies on
  both legs — credential-shaped values (`authorization` and friends)
  land as `[REDACTED]`; bodies are capped by `requestCapture.maxBodyBytes`.
- Storage: exchange events land ONLY in the `requestCapture` archive
  (dir / retentionDays / maxTotalMB); nothing from Decision 3 is written
  to `data/layer2-decisions.jsonl`, and no dataset sample appears on the
  capture page.
- Enforcement layers: config default (master OFF), the `'configurable'`
  type literal, and invariant tests. The existing zero-event guard
  (`backend/tests/forward-proxy-systemone.test.ts`, "systemone capture
  exemption") stays green as a DEFAULT-OFF guard; on-path tests pin
  sanitized headers (`authorization: [REDACTED]`, e2e) and, on the judge
  leg, `purpose='l2-judge'` events.

## Key-lineage & ambiguity guard

Every key this decision moved, oldest first — the full chain, no silent
renames:

| subject | chain (oldest → final) | semantics |
| --- | --- | --- |
| dataset sampling | `classifier.layer2.decisionCapture` → `capture.l2DecisionEnabled` → `classifier.layer2.collectEnabled` | (state, answer, tier) → capped jsonl; training raw material |
| client-leg exchange | `capture.systemoneEnabled` → (`requestCapture.systemone.clientEnabled` — never shipped) → `requestCapture.systemone.enabled` | HTTP exchange events, both transports; the surface master silences both legs |
| judge-leg exchange | (none — new) → `requestCapture.systemone.l2DecisionEnabled` | upstream-leg http-exchange events, `purpose='l2-judge'`; sub-switch effective only under the surface master |

### Ambiguity guard — two similarly-named final knobs

`classifier.layer2.collectEnabled` and
`requestCapture.systemone.l2DecisionEnabled` are DIFFERENT switches,
and this record pins the distinction so no reader ever merges them:

- `collectEnabled` = dataset sampling → `data/layer2-decisions.jsonl`;
  training flywheel; invisible on the capture page.
- `systemone.l2DecisionEnabled` = exchange capture → the capture
  archive and page; HTTP events of the judge's wire calls.
- Retired-key warns point dataset-old keys (`classifier.layer2.`
  `decisionCapture`, `capture.l2DecisionEnabled`) ONLY at
  `collectEnabled`, with explicit warn text stating that
  `requestCapture.systemone.l2DecisionEnabled` is a DIFFERENT switch —
  never offered as their successor.

### Supersession of ADR-0014 §4 and §5 (ADR-0014 itself untouched)

§4 — the capture-records limb. Pinned sentence
(`docs/adr/0014-systemone-protocol-gateway.md`, §4):

> Deliberately out of v1 scope: circuit-breaker tripping and outcome recording (alias resolution READS breaker availability to gate the tier pick, but never trips or records on this surface), FinOps accounting, trace/flywheel/capture records and decision caching; native upstream 4xx/5xx statuses are mirrored to the caller.

Status: the words `trace/flywheel/capture records` are SUPERSEDED as to
`capture records` on the client-facing HTTP surface, FULL-CHAIN (Decision 2), and
EXTENDED — not merely restored — on the judge leg, whose upstream wire
traffic §4 never addressed (Decision 3). The remaining §4 exclusions
stay binding, restated here so nothing drifts:

- circuit-breaker tripping and outcome recording — still excluded;
- FinOps accounting — still excluded;
- trace/flywheel/session records — still excluded;
- decision caching on this surface — still excluded;
- upstream-leg exchange events OF A CLIENT REQUEST — NO LONGER excluded
  (same-day chain-completion): a captured surface request is FULL-CHAIN,
  the native passthrough / synthesized conversion call recorded with the
  surface's own identity (no purpose tag — unambiguous within its turn).
  Decision 3 governs the judge's separate internal calls.

§5 — the dataset limb. Pinned sentence (§5):

> Opt-in decision capture (`classifier.layer2.decisionCapture`, default OFF): judged (state, answer, tier) pairs land in `data/layer2-decisions.jsonl` — the raw material for distilling a native decision model and for calibrating converted confidence. Recorded only on the race-winner path; nothing consumes the file yet.

Status: the limb is SUPERSEDED AS WRITTEN — the key is retired (chain
above), and a 64MB
hard cap added (stop-write + one warn); the default REMAINS OFF — samples
carry conversation state, opt-in preserved. The feature survives intact:
same pairs, same sink file, same race-winner-only recording rule. 0014
§5 stays exactly as written, as history; ADR-0014 is Accepted/Implemented
and immutable — it is not edited.

Supersession map, in full:

- 0014 §4 — capture-records limb: SUPERSEDED for the client leg,
  EXTENDED for the judge leg; every other §4 exclusion stays binding.
- 0014 §5 — the dataset limb: SUPERSEDED as written (key + default +
  cap); the feature survives at `classifier.layer2.collectEnabled`.
- ADR-0016's own earlier passes — `capture.systemoneEnabled` opt-in and
  the `capture.l2DecisionEnabled` move: SUPERSEDED by this rewrite; the
  chains are preserved above.
- ADR-0015's "Amendment to ADR-0014" stated this limb "REMAINS
  binding"; overtaken — that section carries a one-line pointer to this
  final tree.

## Defaults disclosure

| key | default | effect |
| --- | --- | --- |
| `requestCapture.enabled` | `false` | privacy master, opt-in, unchanged default — a config-silent deployment emits zero exchange events (the 0014 §4 posture survives exactly) |
| `requestCapture.systemone.enabled` | `true` | System One surface MASTER — off silences BOTH legs; when on, captured surface requests are FULL-CHAIN (client exchange pair + the surface's upstream call pair) |
| `requestCapture.systemone.l2DecisionEnabled` | `true` | judge-leg exchange events (`purpose='l2-judge'`) whenever the capture master AND the surface master are ON |
| `classifier.layer2.collectEnabled` | `false` | dataset sampling opt-in (conversation state in samples); when ON, the judge's decisions are written to the dataset file (single-key gate — NOT behind the capture master) |

- Dataset cap: `data/layer2-decisions.jsonl` hard-caps at 64MB, then
  stop-write + exactly one warn. A bounded flywheel file, not an
  archive; retention settings do not apply to it.
- All knobs are hot-applied — the capture master, the `systemone` surface
  master, its judge sub and `collectEnabled`. No restart-snapshotting
  anywhere in this tree.
- Disclosure honesty: flipping the capture master ON enables BOTH systemone
  legs by default (surface master and sub both default ON). An operator
  wanting the surface's own legs without judge-call capture sets
  `l2DecisionEnabled: false`; one silencing the whole surface sets
  `systemone.enabled: false`.
- Migration cost: every key in play was born 2026-10-11/12 (ADR-0014 §5
  and this record's passes); live-config impact is negligible, and the
  loud load-time warns cover any drift.

## Consequences

**Positive**

- systemone shows in the capture console like every other HTTP surface.
- One namespace, one meaning: `requestCapture` is exchange logging; the
  dataset knob lives beside the classifier it serves.
- Per-leg operator control; defaults that disclose fully once the master
  flips.
- Judge-leg visibility is net-new: routing decisions become auditable
  end-to-end, with honest race-loser disclosure.
- Enforcement stacks: config default + type literal + load-time
  migration warns + invariant tests.

**Negative / Risks**

- Two similarly-named l2 knobs now exist; the ambiguity guard is a
  standing tax on docs, warns and review.
- Group knobs default `true`: the capture-master flip enables both legs. A stale
  mental model from pass 1 (default-OFF surface switch) would
  under-disclose. Documented above.
- Enabling lands client state snapshots and judge wire traffic on disk
  (headers sanitized; bodies capped by `requestCapture.maxBodyBytes`) —
  same risk class as chat capture, over more traffic.
- `collectEnabled` stays default OFF (0014 §5 posture kept — samples carry
  conversation state): opt-in single key; when on, 64MB cap, stop-write +
  one warn, hot-applied.
- Surface capture is full-chain (client pair + upstream pair): per-request
  event volume doubles on that surface — bounded by maxTotalMB/retention.
- Test limbs to keep green: the default- and explicit-OFF zero-event
  guards; on-path full-chain + sanitized-header pins; `purpose='l2-judge'`
  event pins; race-loser recording honesty pins.
