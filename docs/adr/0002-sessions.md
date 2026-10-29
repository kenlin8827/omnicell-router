# ADR-0002: Sessions — Identity Resolution, Monotonic Ratchet, Pin Eviction, Credential Affinity

## Status

Implemented — 2026-10-15. Derived from code fact (`backend/src/session/session-manager.ts`, `backend/src/pipeline/orchestrator.ts` 4B seam, `backend/src/pipeline/credential-selection.ts`). Facts re-derived from current code in the corpus reset (historical numbering retired; current map: 0001 routing, 0003 addressing/membership, 0004 resilience, 0005 execution, 0006 credentials, 0007 environments, 0008 surfaces). Layer: cross-cutting (request-side conversation state). Health vocabulary referenced here is defined in ADR-0004; affinity identity anchoring in ADR-0006. §1 identity revised 2026-10-16: conversation key (API-key scoped, no transport IP) replaces the root-anchor/tombstone layer; tool-call anchors serialize canonically; anchor/key snapshot persists across restarts.

## Context

Every routed turn needs to answer two questions without client cooperation: *which conversation is this*, and *what should serve it*. Unbounded per-turn model choice causes intellectual degradation (follow-ups land on weaker models) and destroys upstream KV prompt caching (80–95% of input cost on cache miss). The session subsystem is the single owner of both problems; everything else in the pipeline reads its verdicts.

## Decision

### 1. Identity — layered zero-header resolution

Priority order (first hit wins), `resolveSessionId`:

1. Explicit header `x-session-id` / `x-conversation-id` / `session-id` / `conversation-id`, or `router_options.session_id`.
2. Client-embedded conversation UUID — Claude Code `metadata.user_id` in either shape: the legacy `user_{hex}_account_{uuid}_session_{uuid}` string or the 2.x JSON payload `{"device_id":...,"account_uuid":...,"session_id":"<uuid>"}`; both inner ids live in the same conversation-uuid namespace and map onto the shared `cc_` prefix. Exact-shape match only: a loose `_session_` suffix would promote ordinary user ids, and the JSON probe requires a JSON object with a non-empty string `session_id` (mirrors the console's `formatSessionId`).
3. Bare `request.user` (user-scoped; kept for compatibility).
4. Chain anchors — hash of every head prefix of the prior history ending at an assistant turn (bounded probes; matches branched/regenerated histories sharing the head). Serialized **canonically** (see below): the served assistant echo keeps its `tool_calls`, so an agent tool-loop re-anchors across the client's resend byte drift.
5. Tail anchors — trailing windows of length ≥ 3 ending at an assistant boundary (clients that truncate old turns re-find their conversation).
6. Conversation key — `sha256(apiKey identity + FULL first user message)`. Reaches only after the byte-exact anchors miss (turn 2+, e.g. a regenerated assistant rewrite), and rejoins only when the key has exactly ONE candidate (unambiguous); an ambiguous key (two live sessions sharing a first message) cold-starts — false split self-heals, false merge never does. The transport IP is deliberately NOT an input: on a local gateway every conversation shares `127.0.0.1`/`::1` (no discrimination) and the address flaps across the two loopback families (which broke re-anchoring). This replaces the former first-message root map: it short-circuited turn-1-shaped resends straight to mint (never consulting the key) and **tombstoned** an ambiguous key — a same-opening re-ask poisoned the key, and with the tool-call drift below every later turn fell through to it and re-minted, cascading one conversation into dozens of session ids.
7. Cold start — fresh random id (`sess_` + 12 random bytes). A turn-1-shaped resend ALWAYS mints a distinct id (preserving the no-false-merge guarantee); it self-heals from turn 2 once the branches get their own anchors. Deterministic birth ids are rejected: they collide across conversations sharing boilerplate openings on a local gateway.

Tool-call anchors serialize in **canonical** form — volatile wrapper fields (the `"type":"function"` marker, pretty-printed vs re-compacted `arguments` JSON, key reordering of the envelope) are normalized away; a raw-object hash missed every tool-call boundary against a client that re-serializes on resend. Discrimination is retained where it matters: pure tool-call turns still differ by id + name + arguments, so distinct calls never collide (the unrecoverable false-merge direction). Anchor maps and conversation keys persist to a per-environment JSON snapshot (`<env>/data/sessions.json` — content hashes + session ids only, no plaintext) written atomically on a 2 s debounce and flushed at shutdown; a restart no longer splits non-cooperating clients (session tier/pins/affinity stay in-memory and rebuild fresh). Full summarization rewrites match nothing and intentionally start a new session. Birth metadata (`origin`, `firstUserMessage`) is first-write-wins, immutable.

### 2. Tier policy — three configurable strategies

- `monotonic` (default): a session tracks its peak tier. Upgrades pass through (reasonCode `session.escalated`); downgrade asks are intercepted and the session is held at peak (`session.ratchet` / `session.preserved`). Rationale: short follow-ups ("thanks", "fix this line") must not downgrade the brain or invalidate the cache.
- `sticky`: every turn runs at the session ceiling (`session.sticky`).
- `stateless` / `enabled: false`: per-turn routing, no session writes.

Session lifecycle: idle TTL (`ttlSeconds`, default 3600) and capacity (`maxSessions`, default 10000) evict via LRU at cleanup time; no timers.

### 3. Model pin and its eviction — the only two ways a conversation moves models

A session pins one model (`pinnedModel`, written by the ratchet on birth/escalation). Pin reads use the live registry; the pin is honored as chain head in ratchet mode. A pinned model is **hard-switched** (`repinModel`, persisted at the seam before execution) only when:

```
evict(pin) = configForce ∨ healthForce
switch     = evict ∧ healthy landing exists ∧ landing.id ≠ pin
```

- **configForce** — `pin ∉ getCandidateModelsForTier(pin.tier, healthyOnly=false)`: the id is gone from the registry (zombie pin — repaired by the same seam), `unclassified` (removed from every tier member list / glob no longer claims it), or the global `tiers.exclude` denylist vetoes it. **Not** triggers: a model moved to another tier (`reclassifyTiers` rewrites `m.tier` in place — the pin still joins "its own" tier's pool), and member-list edits against hand-configured models (no `tierMatch`; their tier is permanent, per ADR-0003).
- **healthForce** — `modelHealthView(pin) === 'unavailable'` (ADR-0004): every credential tuple hard-OPEN / SUSPECT / operator-DISABLED with no trial in flight (the derived fold of the model's tuple breakers — there is no separate model-level machine). A `recovering` canary — slot free **or busy** — is never eviction: the peek view reads a busy trial as down, and moving a pin one probe from recovery burns the session's KV cache permanently (there is no switch-back). Shadow mode never evicts an automatic trip: shadowed breakers keep serving (the `verdict()` contract), and the view folds them as serving; MANUAL and takedowns enforce verbatim.
- **Landing** — `getModelForTier(actualTier, true)` ∧ peek-available; cross-tier landing when the tier is empty is legitimate and logged (`reason=empty-pool`); `maxTier` is never touched by a repin. **No healthy landing → keep serving the evicted pin** (safe fail; an emptied tier must not strand bound sessions; re-evaluated lazily every turn).
- **Scope** — ratchet mode only. Explicit-named requests never re-route and write the pin back only for alignment (client-named model serves at the ceiling tier; at session birth/escalation the ratchet resolver receives the NAMED model itself, never a pool representative — pool-less deployments keep explicit traffic callable; bare `auto` still resolves representatives through the pool). Combos bypass pins entirely (`sessionMode='bypass'`): the combo's member list is re-resolved per call, so a combo edit reaches every conversation next request — nothing is "bound" to evacuate.
- **Console surface** — the pin is routing-internal and never appears in console session rows: `GET /api/admin/sessions` reports `currentModel` (the registered id of the model that actually served the session's last turn, exactly as registered — `provider/model` for catalog/tier-derived models, bare for hand-configured ones) plus the serving `currentProvider`, one derivation shared by live and trace-reconstructed rows, with the same projection on `GET /api/admin/sessions/:id`. A failover landing therefore never masquerades as the session's anchor, a post-restart reconstructed row (which by design carries no routing state) renders that same execution view instead of a fabricated pin, and the row is a closed whitelist (`SessionRow`, `backend/src/session/session-row.ts`) so a future internal entity field stays invisible by default instead of leaking through a spread.
- **Attribution** — never a new `reasonCode` (the turn's code belongs to §2); the move rides `reasonParams`: `{ repin: 'config'|'health', repinFrom, repinTo }`, persisted on the trace, rendered as a tail in the session switch timeline.
Rejected: peek-based eviction (moves pins off recovering models); filtering the chain head in `executeCandidatePool` (shared by explicit/combo — breaks the explicit-wins contract); waiting for TTL (up to an hour of silent override of a committed operator edit).

### 4. Credential affinity — switching is forced failover, never balancing

Each session may bind one credential (`boundKeyHashPrefix` = display-safe `sha256(keyHash)` prefix, ADR-0006 identity). Contract (pure function at selection, `selectCredential`; persistence lives with the orchestrator, only after a serve):

- bound & healthy & in the candidate's chain → **keep, ever** (local rate-limit caps never move a binding — only the provider's own 429 / pair-open / takedown does);
- bound & pair-OPEN/SUSPECT/DISABLED → next healthy in chain order, **FORCED rebind** persisted after it serves;
- bound & stale/expired/absent-from-chain → treated absent → deterministic new-session spread `sha256(sessionId) % healthyPool` (capped credentials preferred-against — shaping applies only to NEW placements); the spread is WEIGHTED since the ADR-0006 weight amendment: the hash draws a slot in `[0, Σweights)` and walks the weight prefix sums, so a credential weighing w occupies w consecutive slots (uniform weights reproduce the pre-weight landing exactly; weights never move a kept binding, never re-order the forced-failover landing — chain order still wins there — and never touch the ratchet);
- every prefix out → no prefix (legacy force); every prefix DISABLED → move on to the next candidate (a takedown outranks a guess);
- lazy window expiry (`credentialAffinity.cacheTtlMs`, read against `lastActiveAt`) is independent of the session TTL; no switch-back on recovery anywhere.

A model repin never rewrites the binding: continuity rides the selection boundary (keep if the bound prefix exists in the new provider's chain, else stale → re-spread + forced rebind). The model dimension and the credential dimension are strictly separated: partial credential disablement rebinds the credential, never the model.

## Consequences

- Zero-header clients get full conversation continuity; with the anchor/key snapshot, a restart no longer splits grouping either (only the in-memory ratchet/pin/affinity state rebuilds).
- Identity is anchored on the API-key application (never the transport IP), and tool-call anchors survive client resend byte drift — the two failures that cascaded one agent loop into dozens of session ids. `conversationKey` is stamped on every capture event (ADR-0008) so the archive can regroup a conversation by content hash independent of the volatile session id.
- Client User-Agent headers ride the traces (`request.clientHeaders.userAgent`) and are surfaced read-only on the console session table as a display-only client fingerprint; being client-forgeable they are never an identity or routing input — same reasoning as the transport-IP exclusion above.
- Bypass (combo) turns never mint a session entity, so per-session turn numbering uses a dedicated persisted counter (`SessionManager.recordBypassTurn`, snapshot field `bypassTurns`) — display-only bookkeeping that never feeds routing; without it every combo request read `undefined + 1` and stamped every row #1 in the console's request-detail table.
- Operator edits (tier lists, denylist) reach live conversations next turn; each evicted session pays exactly one cache rebuild — forced, attributable, retried only when it has somewhere to land.
- Tests: `backend/tests/pin-eviction.test.ts` (forces, non-triggers, recovering exemption with two-view divergence, landing guard, scope regressions), `credential-affinity-orchestrator.test.ts`, `credential-selection.test.ts`, `session.test.ts`, `resilience*.test.ts`.
