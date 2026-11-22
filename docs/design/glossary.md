# Observation scope glossary

Status: Active. Decision record: [ADR-0024](../adr/0024-observation-scope-vocabulary.md).
Chinese mirror: [zh-CN/glossary.md](./zh-CN/glossary.md).

This is the lookup surface for the words used by sessions, traces, capture and
the console. ADR-0024 holds the decision; this file holds the answers. When a
new symbol, comment, test title or console label needs a scope word, use the
first matching row below and do not invent a synonym.

## 1. Ladder at a glance

| Layer | Means | Identity | Write time | Industry analogue |
| :--- | :--- | :--- | :--- | :--- |
| `session` | Largest write-time container, the gateway conversation entity | `sessionId` | write | `gen_ai.conversation.id` |
| `turn` | One user prompt plus every request it drove | `turnIndex` per session (a write-time ATTRIBUTE, no id) | write (admission gate) | conversational turn |
| `request` | One inbound client request plus all HTTP legs it caused | `requestId` | write | server span + its descendant client spans |
| `exchange` | One HTTP request and its response on one leg | `exchangeId` + `attempt` | write | HTTP message exchange (RFC 9110 section 3.4) |
| `event` | One phase record of one exchange | `id` (`evt_…`) + `phase` | write | phase / span event |

`session ⊃ turn ⊃ request ⊃ exchange ⊃ event`.

Two rules outrank any intuition about the words:

- `session`, `request`, `exchange` and `event` are write-time ENTITIES with
  their own id. `turn` is a write-time ATTRIBUTE (`turnIndex` per session,
  stamped on every capture event and trace record of the request), never an
  entity: **there is no `turnId`.** The boundary is decided structurally at
  the admission gate (`capture/turn-boundary.ts`) and copied by every reader;
  it is never re-derived.
- An `exchange` is a PAIR. `client ↔ gateway` and `gateway ↔ upstream` are two
  separate HTTP requests and therefore two exchanges. One request owns 2-N.

## 2. Per-layer entries

### session

- Definition: the gateway-owned conversation entity (ratchet, pins, traces
  index). `sessionId` is minted by the gateway.
- Parent: none among write-time entities. `conversationKey` can group across
  volatile session ids on the archive read plane (see section 6).
- Children: turns (write-time `turnIndex` attribute), requests (write-time records).
- Code: `session/session-manager.ts` (snapshot `v: 3` carries the
  `turnCounters` high-water), `session/session-row.ts`, `X-OCR-Session-ID`.
- Never call it: a trace, a conversation id borrowed from the caller.

### turn

- Definition: ONE user prompt plus every request it drove. A tool-result
  continuation resends history but does NOT open a new turn.
- Identity: `turnIndex`, 1-based and monotonic within one `sessionId`,
  immutable, allocated once at the admission gate after the final session
  binding; the key is `(sessionId, turnIndex)` and there is no turn id.
  `turnIndex: null` is a first-class value (no user prompt).
- Provenance: `isPromptStart` (opener flag) and `turnDecision`
  (`new_prompt` / `continuation` / `ambiguous_compaction` / `no_prompt`).
- Children: requests.
- Code: `capture/turn-boundary.ts` (structural boundary),
  `session-manager.ts allocateTurnIndex()` (the one writer),
  `thTurns` / `thTurnsTip` in all eight locales,
  `session-row.ts promptTurnsOf()` (counts `isPromptStart` traces),
  `CaptureTurnIndexEntry` / `totalTurns` (whole-archive index, keyed by
  `turnIndex`).
- Never call it: one HTTP round trip, one inbound request, an exchange.
- Note: the LLM world also has an "agent-loop pass" reading of turn. This
  project does NOT use it. Bare `turn` in new code must mean this layer.

### request

- Definition: ONE inbound client request and every HTTP leg it caused (client
  pair, upstream pair, failover hops, Layer-2 decision pair).
- Identity: `requestId` — gateway-minted, unique, immutable, the trace record
  primary key, console row identity, capture join key, `X-OCR-Request-ID`.
- Children: exchanges.
- Code: `observability/request-identity.ts mintRequestId()`,
  `recorder.ts groupEventsIntoRequests()` (groups by `requestId`),
  `CaptureRequestSummary` (read-plane projection, with `exchanges[]`),
  `trace/tracker.ts` (`requestNumber`, `turnIndex`, `isPromptStart`,
  `turnDecision`).
- Never call it: a turn, an exchange, a trace, an outbound HTTP message (an
  outbound message is an `exchange`).

### exchange

- Definition: ONE HTTP request and its response on ONE leg. RFC 9110 allows
  informational responses plus one final response, but always around ONE request.
- Identity: `exchangeId` — pairs the request event with the response event;
  `attempt` is the 1-based ordinal within `(requestId, leg)` (client always 1,
  each upstream failover hop increments). Timing: `latencyMs` is the
  `ts` delta of the pair; a streamed response adds `firstByteTs`, giving
  `ttftMs` and `genMs` exactly one meaning each.
- Children: two events (`phase: 'request'` and `phase: 'response'`).
- Code: `observability/http-exchange.ts emitClientRequest` /
  `emitClientResponse` (client leg), `emitUpstreamRequest` /
  `emitUpstreamResponse` (upstream leg), `mintExchangeId()`.
- Cardinality: 2-N per request — client, upstream, each failover hop, the
  Layer-2 decision call. Every hop stays visible: the read plane buckets
  `exchanges[]` by `(leg, attempt)`, never last-write-wins.
- Never call it: a whole inference call, a container of pairs, a single event.

### event

- Definition: one JSONL line; `eventType: 'http-exchange'`, `schema: 2`,
  one `direction`, one `phase`, one `exchangeId`, one `requestId`, plus the
  write-time turn identity and `attempt`.
- Code: `recorder.ts recordEvent()` (stamps `schema`, `attempt`, `NO_TURN`
  defaults) / `readEvents()`, `parseArchivedEvent()` (strict schema-2
  validation — lines lacking the turn identity are rejected, not normalized).
- Never call it: an exchange. Two events make one exchange. Bare `event` means
  a CAPTURE phase record; the failure / rate-limit / quota ledgers hold
  `ledger events`, never `events`.

## 3. Id vocabulary (ADR-0021 is authoritative)

| Id | Owner | Scopes | May repeat |
| :--- | :--- | :--- | :--- |
| `sessionId` | gateway | conversation entity | no |
| `requestId` | gateway | one request, all its legs | no |
| `exchangeId` | gateway | one request/response pair | no |
| `turnIndex` | gateway | one turn within one session | no within a session |
| `clientRequestId` | caller | correlation only, NEVER a key | yes, across rows and turns |
| `upstreamRequestId` | provider | the provider's own call id | yes |
| `conversationKey` | derived | content hash, archive read plane | yes |

`traceId` and `spanId` do not exist in the domain model. A caller `traceparent`
is parsed into `clientRequestId` and never echoed as a key.

## 4. Event axes

| Axis | Values | Meaning |
| :--- | :--- | :--- |
| `direction` | `client` / `upstream` | which LEG, from the gateway's point of view; it names the leg, NOT a vector — a response carries its request's value |
| `phase` | `request` / `response` | which side of the exchange |
| `purpose` | `l2-decision` (sole value, `ExchangePurpose`) | a gateway-initiated decision call riding the upstream direction |
| `attempt` | 1..N within `(requestId, leg)` | failover / retry ordinal; client leg always 1 |

`direction: 'gateway'` is banned. The gateway has no third leg:
`normalizedRequest` is an in-memory body shape with no socket, status or
latency. `clientRequest → normalizedRequest → upstreamRequest` is a body-shape
chain (field / debug view), not a set of events. The response the client
receives is `clientResponse` — named by its LEG, the same coordinate as
`clientRequest`; the retired `gatewayResponse` spelling named the sender.

## 5. Banned spellings

| Banned | Use instead | Why |
| :--- | :--- | :--- |
| `tun`, `tune` as a scope | `turn` | typo / tuning knob; `tunnel` belongs to ADR-0018, ADR-0020 |
| `turn` for one HTTP interaction | `request` | turn is a user prompt |
| `turn` for the admission / budget unit | `request` | ADR-0023's `admitRequest()`, budgets and re-entry count are per request |
| `exchange` for a container | `request` | exchange is one pair |
| `request` for an outbound HTTP message | `exchange` | `request` is the inbound client request and everything it caused |
| new `round*` symbols | `turnIndex` | `roundNumber`, `totalRounds`, `CaptureRoundIndexEntry` are DELETED; a turn is keyed by the write-time `turnIndex`, never by window-local renumbering |
| `gatewayResponse` | `clientResponse` | retired: the response is named by its leg, like `clientRequest` |
| `gatewayRequest` | `request` | the gateway does not send itself a request |
| `traceId`, `spanId` | `requestId`, `clientRequestId` | ADR-0021 |
| `direction: 'gateway'` | `purpose: 'l2-decision'` | no network leg exists |
| bare `event` outside the capture plane | `ledger event` | the three observation ledgers hold ledger events |

## 6. Known exceptions

- `conversationKey` regroups across volatile `sessionId` values, so the archive
  read plane has a container WIDER than session.
- The standalone decision surface mints its own `requestId` with no user prompt;
  it belongs to no turn (`turnIndex: null`).
- Upstream failover writes one exchange per hop; `exchanges[]` keeps every hop
  visible and the drawer tabs each `attempt`.
- Pre-cutover data enters the runtime read plane only after it reaches the live
  shape: schema-1 capture archives are migrated in place by `V1ToV2Migrate`
  (`migratedFrom: 1` marks the reconstructed identity) — including files written
  before the request layer, whose request boundary is read off the recorded span
  sequence rather than guessed — and `traces.db` got a one-shot
  `DB_VERSION = 3` normalization. A sequence that cannot be closed is repaired in
  place (orphan request with `NO_TURN`), never sealed away: nothing leaves the
  live root, because an upgrade may not cost the operator its own history.
  There is no legacy fallback branch on any hot path.

## 7. Where to look

| Question | File |
| :--- | :--- |
| Why this ladder | `docs/adr/0024-observation-scope-vocabulary.md` |
| Id ownership and cardinality | `docs/adr/0021-request-identity.md` |
| `request` definition and capture event model (schema-2 archives) | `docs/adr/0008-protocol-surfaces-and-capture.md` section 5 |
| Conversation regrouping | `docs/adr/0002-sessions.md` section 1 (and Consequences) |
| Id minting | `backend/src/observability/request-identity.ts` |
| Event emission | `backend/src/observability/http-exchange.ts` |
| Write-time turn boundary | `backend/src/capture/turn-boundary.ts` |
| Read-plane request assembly and whole-archive turn index | `backend/src/capture/recorder.ts` |
| Admission budgets and re-entry (per `request`, never per prompt) | `docs/adr/0023-rate-limit-waiting-and-reentrant-admission.md` |
| Console counts | `backend/src/session/session-row.ts`, `frontend/src/pages/SessionsPage.tsx` |
