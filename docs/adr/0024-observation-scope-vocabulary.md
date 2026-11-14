# ADR-0024: Observation Scope Vocabulary — Five Layers, No Twin Names

Date: 2026-11-14
Status: **Implemented** — the ladder, the write-time turn identity, the
`exchanges[]` read plane and the data cutover below all exist in code and are
pinned by tests. This record is the single target-state contract; it carries no
transitional clauses, no retained legacy spellings and no derived fallbacks.
Governs: `docs/design/glossary.md`, `backend/src/observability/request-identity.ts`,
`backend/src/observability/http-exchange.ts`, `backend/src/capture/recorder.ts`,
`backend/src/capture/turn-boundary.ts`, `backend/src/session/session-row.ts`,
`backend/src/session/session-manager.ts`, `backend/src/trace/tracker.ts`,
`frontend/src/i18n/locales/*.ts`, `frontend/src/pages/SessionsPage.tsx`,
`frontend/src/pages/CapturesPage.tsx`.

> **Change discipline.** Every rename moves in the SAME commit as its code
> change, with comments, test titles, ADR prose and both locale trees swept
> together (cleanup contract). A rename that leaves a stale word behind in any
> of those surfaces is an incomplete change.

## Context

The same words used to name different scopes on different planes, and the
ambiguity produced defensive comments and contradictory counts:

- `turn` had three readings: the capture plane's *inference turn* (the 2-4
  events joined by one `requestId`), the console *Turns* column (user prompts),
  and the session entity's `turnCount` (every request). ADR-0023 (same day)
  used `turn` for the ADMISSION unit.
- `exchange` had three granularities: one request/response pair, a single
  event, and the whole capture feature.
- The turn boundary itself was a read-plane heuristic (`userPromptSummary`
  presence plus message counts): it changed with the read window, could not be
  joined, and could not be audited. A layer nobody can key on is not a layer.
- ADR-0021's original ladder drew a caller trace value above gateway requests,
  reading correlation as containment.

This record closes all of it: the ladder is fixed, the turn boundary is
materialized as a write-time attribute, the read plane reads it instead of
deriving it, and every twin name is renamed in the same movement.

## Decision

### 1. The ladder

| Layer | Definition | Identity | Written at | Industry analogue |
| :--- | :--- | :--- | :--- | :--- |
| `session` | Largest write-time container: the gateway-owned conversation entity | `sessionId` | write time | `gen_ai.conversation.id`, `anthropic.session.id` |
| `turn` | ONE user prompt plus every request it drove; a tool-loop continuation does NOT open a new turn | `turnIndex` per `sessionId` — an ATTRIBUTE, not an id | write time (admission gate) | conversational turn (the "one turn, many requests" branch) |
| `request` | ONE inbound client request plus every HTTP leg it caused | `requestId` | write time | server span + its descendant client spans |
| `exchange` | ONE HTTP request and its response on ONE leg | `exchangeId` + `attempt` | write time | one HTTP message exchange (RFC 9110) |
| `event` | ONE phase record (`request` or `response`) of one exchange | `id` (`evt_…`), `phase` | write time | a phase/span event |

Short form: `session ⊃ turn ⊃ request ⊃ exchange ⊃ event`.

Two honesty rules ship with the ladder. First, `session`, `request`,
`exchange` and `event` are independent write-time ENTITIES with their own id;
`turn` is a write-time ATTRIBUTE (`turnIndex`), never an entity — there is no
`turnId`, no turn table, no turn archive record. Second, an `exchange` is a
pair, never a container: `client ↔ gateway` and `gateway ↔ upstream` are two
different HTTP requests and therefore two different exchanges. A request owns
2–N exchanges: the client pair, every upstream failover attempt, and the
Layer-2 decision pair (`purpose: 'l2-decision'`, routed as an upstream leg).

### 2. The id column is the authority

`exchangeId` connects exactly one request event to its response event on the
same leg. `requestId` connects ALL legs of one inbound call: the client pair,
the upstream pair, every failover attempt and the Layer-2 decision pair. This
is the same shape as the OpenTelemetry HTTP retry convention, where one
inbound SERVER span owns a CLIENT span per send attempt. `requestId` is not a
trace: a caller's `traceparent` may cover a whole conversation, so a trace is a
DAG of many requests, never one request (ADR-0021).

### 3. What is written — the turn identity

Every servable inbound request records three fields alongside its existing ids,
stamped on EVERY capture event and every trace record of the request:

| Field | Meaning |
| :--- | :--- |
| `turnIndex` | 1-based, monotonic WITHIN one `sessionId`, immutable. The key is `(sessionId, turnIndex)`; there is no `turnId` |
| `isPromptStart` | true when this request opened the turn |
| `turnDecision` | `new_prompt` \| `continuation` \| `ambiguous_compaction` \| `no_prompt` — provenance for auditing a boundary decision |

A request with no user prompt (standalone decision surface, health probe,
replay) records `turnIndex: null`; null is a first-class value, not a missing
field.

### 4. The boundary rule (structural, `capture/turn-boundary.ts`)

A request opens a new turn if and only if its message list carries a NEW user
message that is NOT a tool-result continuation:

- Anthropic: a `user` message whose content is only `tool_result` blocks is a
  continuation.
- OpenAI: a trailing `role: "tool"` message, or a user message that only
  carries tool results, is a continuation.

The test is STRUCTURAL. Text presence is display-only and never decides the
boundary: an image- or attachment-only user prompt IS a new turn.

- History shrank (client-side compaction / truncation) so index comparison
  proves nothing: allocate anyway and record `ambiguous_compaction`. Allocating
  on doubt keeps the key unique; the label keeps the doubt visible.
- A client resending the same prompt after a timeout is a NEW turn. The gateway
  does not guess intent; idempotency is the client's option, not a heuristic.
- No user message at all: `no_prompt`, `turnIndex: null`.
- Failover hops, internal retries, re-entries and the Layer-2 decision leg are
  the SAME request and never allocate.

### 5. One writer, observation only

- Allocation happens at exactly one point: the inbound admission gate, AFTER
  the final session binding and BEFORE the first event is emitted
  (`orchestrator.ts` → `SessionManager.allocateTurnIndex()`). Nothing in the
  execution path, failover loop or capture writer may increment it.
- Counter storage follows the `bypassTurns` precedent: a
  `turnCounters: sessionId → high-water` map inside the per-environment session
  snapshot (snapshot `v: 3`), FIFO-capped, fail-open. Traces are the audit
  trail, not the counter: they can be pruned, so `max+1` over retained traces is
  only a SEED for a missing or corrupt snapshot, never the runtime source.
- `turnIndex` is OBSERVATIONAL. It must not key rate-limit budgets, billing,
  quota or any irreversible decision. ADR-0023's budgets are per `request`; a
  mis-classified boundary may cost one wrong console count — never a wrong
  budget or a wrong charge.

The allocation is idempotent per request context. A re-entry, failover hop or
retried dispatch reaches the same gate with the same request state and never
allocates twice. Residual risk: the snapshot flush is debounced, so a hard
crash can lose the last few allocations; the `max+1` seed restores the
high-water as long as either the snapshot or the traces survive, and a
collision requires BOTH to be lost for the same session.

### 6. The read plane

- No renumbering, ever: a turn is never recomputed at read time. Every event
  already carries `turnIndex` / `isPromptStart` / `turnDecision`; readers copy
  them. There is no `derived` fallback and no prompt-text heuristic anywhere
  in the read path.
- The six fixed summary slots are replaced by `exchanges[]` on
  `CaptureRequestSummary`, bucketed by `(leg, attempt)`. A failover's every
  hop and the decision pair stay visible; the console drawer renders one tab
  per exchange phase (`<exchangeId>:<phase>`), labelling `attempt > 1`.
- `attempt` is 1-based within `(requestId, leg)`; the client exchange is always
  1, every upstream failover hop / in-place retry increments it. Written at
  emit time, never inferred at read time.
- Timing contract: an event's `ts` is when THAT phase fired; a streamed
  response event additionally carries `firstByteTs` (first body chunk). Then
  `latencyMs = response.ts - request.ts`, `ttftMs = firstByteTs - request.ts`,
  `genMs = response.ts - firstByteTs` — exactly one meaning each, readable
  without guessing. The capture plane reports the SAME TTFT/decode-TPS
  vocabulary as the trace plane (ADR-0005 §8).
- `promptSummary` is DISPLAY-ONLY. It is stamped at write time on the
  prompt-start client-request event (an emitter-supplied text wins, otherwise
  the recorder flattens the last user slot) so `bodies=none` reads can render a
  prompt; it never decides a boundary and continuations never get one.
- `turnCount` on the console wire counts `isPromptStart` requests
  (`promptTurnsOf()`); the session entity counts every request as
  `requestCount`. `totalTurns` in a capture read is
  `count(distinct turnIndex)`, never an ordinal and never a request count.
- The archive index (`/summary`) scans write-time `turnIndex` metadata
  directly; the turn selector lists `CaptureTurnIndexEntry` keyed by
  `turnIndex`. `requestNumber` is the 1-based REQUEST ordinal inside the read
  window — the pager's unit; turn membership is never folded into it.

### 7. Known exceptions — a range, not strict containment

- `conversationKey` (content hash, ADR-0002 §1 and its Consequences) can
  regroup a conversation across volatile `sessionId` values; the archive read
  plane has a container WIDER than session. `session` is the largest WRITE-time
  entity, not the largest possible grouping. It is an index key, not a sixth
  layer.
- The standalone decision surface mints its own `requestId` with no user
  prompt, so it belongs to no turn (`turnIndex: null`).
- The gateway has NO third leg. `direction` is exactly `client | upstream` and
  names the LEG, not a vector: a response event carries the same `direction` as
  its request. The response the client receives is `clientResponse` — named by
  its leg, the same coordinate as `clientRequest`; the former
  `gatewayResponse` spelling named the sender and is retired.
  `normalizedRequest` is an in-memory body shape with no socket, status or
  latency; `clientRequest → normalizedRequest → upstreamRequest` is a
  body-shape chain, not a set of events.

### 8. Data cutover (one-way, no runtime compat)

- Capture archives: writes stay on the `capture/` root with
  `CAPTURE_SCHEMA = 2` (every line stamped with `schema: 2` plus the turn
  identity) — the version rides on the data, never on the root name. Schema 1
  is the unmarked baseline, and `V1ToV2Migrate`
  (`migrate/steps/v1-to-v2.ts`) carries it forward IN PLACE for BOTH historical
  shapes: lines that already carry the gateway ids are taken as-is, and lines
  that predate them (`traceId` + `spanId` only) get their request boundary read
  off the event sequence — `traceId` is connection scope, `spanId` is the
  exchange identity, a client request opens a request, its upstream spans
  belong to it, the matching client response closes it — with a requestId
  minted deterministically from `(sessionId, spanId, ts)` (so a re-run mints
  the same id). Turn identity in both shapes is the same structural rule the
  admission gate uses (`classifyTurnBoundary`), replayed over the bodies the
  archive already recorded, in file order with the previous request's message
  count threaded per session; `attempt` is the ordinal of each distinct
  exchange within `(requestId, leg)`; the retired vocabulary is dropped. The
  engine stamps `migratedFrom: 1` on every rewritten line, so a turn
  reconstructed during migration is never mistaken for an admission-gate
  stamp, and a line that never reached the target schema is still rejected by
  the archive-line validator, never silently normalized. A legacy span
  sequence that does not close cleanly is repaired INTO the target schema by
  the step itself (an upstream exchange outside any client request becomes a
  prompt-less orphan request with `NO_TURN`; a client request opening over an
  unfinished one is simply the next request; a stray response attaches to the
  request its span opened earlier or stands alone; a file ending mid-request
  keeps its request) — so nothing has to be set aside, and nothing ever is:
  there is no seal, no `capture-archive/`, no parking lot. An upgrade must
  leave the history it already holds READABLE, and the live root is the only
  copy. A line that is not parseable JSON is carried over byte-for-byte and
  counted as `unreadable` in the pass summary instead of costing the file its
  good rows. Every later schema bump
  (3 and beyond) is one more `V{N}ToV{N+1}Migrate` class in the same chain
  (`capture/migrate/`, one file per class under `migrate/steps/`, resolved by
  `(from, to)`, a fresh instance per file, `begin()` planned per hop over the shape that hop rewrites, applied by the boot pass to every
  file and by the hourly sweep to quiet ones, with whole-file atomic rewrites
  that re-check the original before the swap) — never a new root, never a
  reader-side branch.
- `traces.db`: `DB_VERSION = 3` runs a ONE-SHOT migration — the stored
  `turnNumber` blob field is renamed to `requestNumber`, and each row is stamped
  with the structured turn identity by replaying the old
  `request.userPromptSummary` blanking convention exactly once. Runtime readers
  are strictly single-shaped: no dual-field fallback on the hot path.
- Session snapshots: additive `v: 3` (`turnCounters`); `v: 1` / `v: 2`
  payloads load without the counter and re-seed from retained traces.

### 9. Banned spellings

| Banned | Reason |
| :--- | :--- |
| `tun`, `tune` as a scope unit | `tun` was a typo; `tune/tuning/tunable` already mean configuration adjustment, and `tunnel` is owned by ADR-0018/0020 |
| bare `turn` meaning an HTTP interaction or one inbound request | Use `request`; one `requestId` = one request |
| `turn` meaning the admission/budget unit | ADR-0023's `admitRequest()`, budgets and re-entry count are per REQUEST |
| `exchange` meaning a whole inference call or a container of pairs | An exchange is one request and its response on one leg |
| `request` meaning an outbound HTTP message | An outbound message is an exchange; `request` is the inbound client request and everything it caused |
| `gatewayRequest` | The gateway does not send itself a request; `GatewayRequestInfo` in `plugins/gateways.ts` is a plugin-match argument, not a request object |
| `gatewayResponse` | Retired in favor of `clientResponse`: the response is named by its leg, like `clientRequest` |
| `traceId` / `spanId` in the domain model | Banned by ADR-0021; `clientRequestId` is correlation only |
| `direction: 'gateway'` | Would fabricate HTTP events that have no network leg |
| bare `event` outside the capture plane | The three observation ledgers (failure / rate-limit / quota) hold `ledger events`; an unqualified `event` means a capture phase record and only that |
| new `round*` read-plane symbols | `roundNumber` / `totalRounds` / `CaptureRoundIndexEntry` are DELETED; a turn is keyed by write-time `turnIndex`. Do not reintroduce window-local renumbering |

## Consequences

- New code, comments, test titles, ADR prose and console labels follow the
  ladder. `docs/design/glossary.md` is the lookup surface; this ADR is the
  decision.
- The renames that shipped with this contract, all one-commit-swept:
  `HttpExchangeEvent → CaptureEvent`; `gatewayResponse → clientResponse`
  (emitters, transports, wire fields, eight-locale `tabGatewayResponse →
  tabClientResponse`); `CaptureTurnSummary → CaptureRequestSummary`;
  `groupEventsIntoTurns → groupEventsIntoRequests`; `numberTurns →
  numberRequests`; `/turn?id= → /request?id=`; the entity's `turnCount →
  requestCount` (the console wire keeps `turnCount` = user-prompt count);
  `ExecutionTrace.turnNumber → requestNumber` (wire, backend + frontend in one
  commit); `admitTurn → admitRequest` (ADR-0023).
- The eight-locale `thTurns` / `thTurnsTip` keys and `promptTurnsOf()` are
  correct under this contract — the console *Turns* column counts user
  prompts, by the write-time `isPromptStart` flag.
- Pre-contract `per-turn` prose was audited site by site — never bulk-replaced.
  The rule is the SENTENCE's unit, not the word: `per-request` where the unit
  is one inbound request (ADR-0005 TTFT per call, ADR-0009 attribution per
  call, ADR-0012 effort judgement per call, ADR-0002 routing); `per-turn`
  retained only where the unit is genuinely the user prompt (ADR-0011's
  directive overlay is APPLIED per request but SCOPED to the prompt).

## References

- ADR-0008 §5 (capture model, schema-2 archives)
- ADR-0021 (gateway-owned ids, no `traceId` / `spanId`, legs share `requestId`)
- ADR-0023 (`admitRequest()` and the budgets are per request, not per prompt)
- ADR-0002 §1 / Consequences (`conversationKey`); ADR-0018 / ADR-0020 (`tunnel`)
- `docs/design/glossary.md` (lookup table; zh-CN mirror under `docs/design/zh-CN/`)
- RFC 9110 §3.4/§3.9 (message exchange); OpenTelemetry HTTP semantic
  conventions (one span per attempt); OpenTelemetry GenAI conventions
  (`gen_ai.conversation.id`)
