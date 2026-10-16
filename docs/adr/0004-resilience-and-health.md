# ADR-0004: Resilience — Error Taxonomy, Breaker State Machine under a Live Rule Tree, Scoped Trips, Capability Health View, Shaping vs Breaking

## Status

Implemented — 2026-10-15 (facts-side corpus rewrite). Scope: what counts as failure, how breakers trip and recover, what survives restart, how health is *named* upward, and where rate limiting differs from breaking. Execution sequencing = ADR-0005; eviction consumption of the health view = ADR-0002.

## Decision

### 1. Seven-class error taxonomy; classifier diagnoses, manager decides

`QUOTA_EXHAUSTED | AUTHENTICATION_ERROR | RATE_LIMITED | SERVICE_UNAVAILABLE | CLIENT_ERROR | MANUAL | UNKNOWN` (`resilience/types.ts:7-15`; 5xx + network causes — reset/timeout/DNS — all fold into SERVICE_UNAVAILABLE with a `networkCause` sub-vocabulary). Status extraction tolerates numeric, message-text (`status: 429`) and provider-code-string forms; `Retry-After` supports integer seconds only (HTTP-date unsupported).

Default dispositions (each overridable by the rule tree; "under-cool, never over-cool" is the shared bias):

| Class | Trigger words/status | Default scope | Cooldown | Side effects |
| :--- | :--- | :--- | :--- | :--- |
| QUOTA | 402/`insufficient_quota`/balance wording | account | `trip.quota.cooldownMs` (12 h floor) | never SUSPECT |
| AUTH | 401/`invalid_api_key`… | account | `trip.auth.cooldownMs` | `markSuspect:true` |
| RATE_LIMIT | 429/503+limit wording; `Retry-After` honored | account if account-limit markers, else pair | `clamp(RA·1000,[1s,maxCooldown])`; no RA → `min(60s,initial)` | short burst (RA ≤ `maxRateLimitWaitMs`) in-place retriable; **long RA hard-trips at that length — trust the provider's stated wait** |
| SERVICE_UNAVAILABLE | 5xx/network | model | ladder (30 s→×2→5 h) | — |
| CLIENT_ERROR | 400/422 + wording | never trips | — | counted only when `counting.clientErrors` ON (the only inversion) |
| UNKNOWN | anything else | pair | counted statistics | — |

Scoping rule: a trip is scoped ONLY when the error carries credential attribution (stamped by `registry.execute`); unattributable errors never carry `tripScope` (absence = model). Rules' per-class `scope` overrides the diagnosis — after attribution, never before.

### 2. Three-state machine; consuming gate vs non-consuming peek

`CLOSED | HALF_OPEN | OPEN` (`CircuitBreakerState`) — this vocabulary belongs to the breaker component and is NEVER reused for model-level aggregation (see §4). Detection: per-class consecutive-failure ladders + sliding failure-rate window (defaults threshold 3/window 20/50 %; `initialCooldownMs` 30 s, ×2 escalation, `maxCooldownMs` 5 h cap; quota fixed 12 h). Recovery trial: `recovery.halfOpen.{maxProbes,successThreshold,maxWaitMs}` + `onCanaryFailure: backoff|initial|close` (MANUAL forces backoff; default threshold 1 = canary-closes-on-first-success; a stuck single canary may linger, bounded by `maxWaitMs`, 0 = forever).

- **Consuming gate** `canExecute` is called only immediately before an upstream call. **Peek** `peekExecute` (selection, pool filters, leader picks, console) NEVER takes a probe slot — lookups would starve a recovering model into permanent HALF_OPEN.
- Pair/account verdicts deliberately never reach the model breaker (a pair that 429s must not strand the whole model); a model trip reads as "every prefix out" through the AGGREGATE, not by rewriting pair states.
- Non-penalty outcomes (rule-dropped, `shouldTripBreaker:false`) release any consumed probe slot; client-side 413/499 never reach the breaker at all (no upstream call → no record).
- **Commit point (streamed turns).** Failover and in-place retry are legal only while no byte has reached the client. Once the relay forwards a frame the turn is committed: a later upstream break is still classified and recorded through the normal taxonomy (health stays honest), but is never re-issued — a retry would hand the client a second copy of a generation it has partly consumed. The stream simply ends without `[DONE]`, which is also the signal to the client that the turn did not complete (ADR-0008 §1).

### 3. Live rule tree with contractual OFF-semantics

`circuitBreaker.rules` (global ⊕ per-provider overrides): counting/trip/recovery per class — UNSET fields fall back to the global knobs (legacy behavior = the defaults). Hot-applied on EVERY console save (`manager.applyConfig` — swaps rule sets, never live state machines; the single reconciliation: OPEN breaker whose tripping rule was disabled is released now) (`routes/console.ts:1082,1106`). OFF-semantics are contract, not implementation detail: counting-off = neither recorded nor tripped (and releases a consumed slot); trip-off quota/auth = full ignore (no trip, no count, **no SUSPECT** — an ignored 401 must not eject an account); trip.rateLimit-off = long-RA 429 downgraded to a counted statistical failure, RA-derived floor still flows. Invariant across the tree: **a toggle neither sets nor clears an existing flag** (`markSuspect:false` stops NEW flags; existing SUSPECT keeps gating selection until manual clear). SUSPECT is set only along a trip; only reconnect/Push/admin clear it. Operator DISABLED is runtime-invisible to the classifier yet outranks every selection degeneracy (never served by force). Shadow mode: automatic trips never deny (accounting runs); MANUAL always enforces. `circuitBreaker.enabled:false` = gates always allow + records no-op; selection flags, rate limiting, and manual trips keep working exactly as configured.

### 4. Two health readings, one deliberate divergence

- `modelAvailability` (PEEK-based boolean aggregate): model breaker not-allowed ⇒ all prefixes out; else a prefix is out iff `isPairOut` (DISABLED first, then SUSPECT, then pair-breaker-peek). Serves pool building, selection, the eviction **landing guard**.
- `modelHealthView` ∈ `available | recovering | unavailable` (STATE-based aggregation, non-consuming `getState()`, shadow-folded exactly like the `verdict()` contract: a shadowed automatic trip still serves so it never reads out; MANUAL stays verbatim): `available` = model not OPEN ∧ some pair CLOSED; `recovering` = trial in flight (canary slot free OR busy) without CLOSED pair; `unavailable` = model OPEN ∧ no CLOSED pair, or every pair hard-OPEN/DISABLED/SUSPECT. Takedown outranks recovery-in-progress; chain-less providers degenerate to the model state; a model trial whose every pair is still hard-OPEN reads `unavailable` (no probe can reach upstream). Serves the session-pin EVICTION (ADR-0002 fires only on `unavailable`) — so an operator never confuses "a canary just started" with "gone".

The divergence is the point: a busy canary reads unavailable on peek — pools route around it this turn, the peek-based landing guard refuses it, but the state view protects live bindings from being moved off a model one probe from recovery.

### 5. Breaker memory persistence — per-env state, global flags

Breaker state machines persist to `<home>/breaker-state.<env>.json` (per ENVIRONMENT book-set): full state + sliding outcome windows survive restart; HALF_OPEN restores with probe counters CLEARED and `enteredAt` re-anchored (a snapshot taken mid-canary must not starve the trial); `cooldownUntil` gets a clock-skew guard; writes are debounced (`persistence.debounceMs`, not hot-applied), atomic temp+rename 0600, corrupt files kept aside `.corrupt.<ts>`; flush on SIGINT/SIGTERM/SIGBREAK/exit. Administrative flags persist GLOBAL (`suspect-accounts.json` — suspects AND disabled entries): they attach to the credential, not the book-set. Loading skips records whose rule is permanently disabled.

### 6. Active health probing (opt-in)

`circuitBreaker.activeProbing.enabled:false` default; prober interval `activeProbing.intervalMs`. Every tick scans pairs for HALF_OPEN-or-cooldown-expired-OPEN and runs a `max_tokens:1` `health_check_ping` through the REAL execution path (credential re-stamped → scoped diagnosis). The prober never consumes traffic canary slots: it holds its own model-slot budget (= `halfOpen.maxProbes`) and picks the first not-out "representative credential" per pair; SUSPECT never self-returns; a fully-out chain skips the cycle. Probing converts passive cooldown into verified recovery, at the cost of ~zero tokens.

### 7. Rate limiting — a different axis: quota shaping, not health

Separate engine (`ratelimit/`): sliding-window log over `requests | tokens | costUsd` (any full ⇒ verdict). Two directions: **inbound enforcement** per apiKey (429 + `Retry-After`, OpenAI-error body with `param=limitedBy`; the rejected request does NOT count; bounded grace-wait ≤ 2 s re-checks once before denial; MITM leg is not inbound-metered) and **outbound shaping** per account (`account:<provider>:<keyHashPrefix>` overlay limits: selection SKIPS at-cap accounts for new placements only — the kept-binding iron law says a bound session is never moved by a local cap, only by the provider's own 429/pair-open/takedown; the last-candidate force still serves, attributed `forced`). Every candidate order is fixed: select-account → rate PEEK (non-consuming; at-cap never burns a canary) → consuming breaker gate → dispatch deduct → execute → scoped record. Event ledger kinds `denied/grace-admitted/skipped/forced/shaped` (upstream 429 belongs to the breaker, not the ledger); ring 500 + coalesced WAL mirror in `traces.db` (own handle, fault-isolated, fail-open). Admin API: `GET /api/admin/ratelimit[/events]`, `POST /api/admin/ratelimit/events/clear`.

### 8. Operator surfaces

`X-OCR-*` headers single-homed in `surfaces/ocr-headers.ts` (defaults are a frozen contract; transports decide DELIVERY, not content): chat leg 13 base (`Tier`, `Tier-Escalated`, `Layer`, `Model`, `Failover`, `Failover-Attempts`, `Failover-Path`, `InPlace-Retries`, `Breaker-State`, `Session-ID`, `Session-Ratchet`, `Session-Lookup`, `Trace-ID`, `Latency-MS`) + conditional `Thinking-Requested/Actual/Degraded` and `Variant`; decision leg exactly 3 (ADR-0008). Breaker management API: `GET /api/admin/health/circuit-breakers` (model+pair snapshots + rules banner), `POST .../reset?scope=model|account|pair&account=<keyHashPrefix>` (clears cooldown/failures/window/ladder — never SUSPECT), `POST .../trip` (manual, default 1 h, clamp [1 s, 7 d]), `POST /api/admin/health/suspect-accounts/clear`. Recurring misconfig warnings route through `WarnThrottle` (dedup once per process, 60 s ≤ 50 lines then fold).

## Consequences

- Hard vs soft response is class-decided, rule-tree overridable, hot-applied — with OFF-semantics specified per family instead of assumed.
- The capability/state layering of §4 gives operators one unambiguous word each for "down", "healing", and "out"; the divergence between peek and state is pinned by tests (`pin-eviction.test.ts`, `resilience*`).
- Recovery is verified (prober) or honest (peek-routed around), never accidental.
