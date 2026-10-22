# ADR-0013: Failure Events Ledger — Model-Call Failure Observability

## Status

Implemented — 2026-10-21. Scope: a new observability plane (the `failure_events` ledger + the console Failures page) and one fail-fast repair on the decision layer's error path. Ledger precedent = ADR-0009's `quota_events`; the trace plane's executed-turns-only rule = ADR-0005; breaker states remain confined to the CircuitBreaker layer (ADR-0004).

## Context

The operator question "WHICH model calls failed, and WHY" had no answering plane:

- The trace table records executed turns only — a failed round has no turn, so failed calls never land anywhere durable.
- The circuit breaker keeps trip STATE (`available/recovering/unavailable`) but no per-failure reason or timeline; its event-log sibling explicitly routes upstream 429s into the breaker's domain, which holds no reasons.
- The log tail is raw unaggregated text; LogsPage cannot answer "which models".
- The routing decision layer's wire failure was swallowed by a fully silent catch — a quota-exhausted decision model produced nothing but missing tier decisions (the production incident that motivated this ADR: the decision layer's model had burned its monthly quota and every `/auto` request degraded silently).

Alternatives rejected in review:

- **Extend the trace table** — semantic mismatch: failed calls have no turn, no session-turn shape, and would pollute every trace consumer's invariant.
- **Fold into LogsPage** — a raw tail cannot aggregate by model; the question stays unanswered.

## Decision

### 1. One ledger, one event per failed upstream MODEL CALL

New `backend/src/observability/failure-events.ts`. Record shape: `{ id, ts, lastTs, count, model, provider, errorClass, status?, message, role, sessionId? }`. `errorClass` = the error classifier's `ErrorCategory` vocabulary (the same words the breaker rules and the gateway error surface speak) extended by `TIMEOUT` — an abandoned decision layer call has no HTTP status to classify. `role` splits the emitter: `serving` (candidate-pool attempts) and `l2-decision` (routing-decision-layer wire calls) today; `probe` is reserved in the vocabulary so a future health-prober emitter needs no schema change.

### 2. Two emitters, fail-open by construction

- **Serving** — the orchestrator's per-candidate catch, at the exact point the classifier verdict is already in hand: every diagnosed failure is recorded with its category, status, message and the owning session, REGARDLESS of whether a later candidate rescues the turn (failover outcome is routing; a failed call is fact). In-place retry failures coalesce like any repeat.
- **L2 Decision** — the decision layer's wire catch (classified like any upstream error) and the deadline branch (`errorClass: 'TIMEOUT'`). A late rejection landing after the deadline never double-records — the timeout branch owns that observation. Both decision layer rows carry the triggering turn's session id (threaded `routeAsync` → `evaluate`), so a dead decision layer is attributable to the conversations it failed — independent of the capture master switch, unlike the decision layer's capture identity.

Not recorded — the ledger observes CALLS, not refusals: policy-denied requests, breaker-skipped candidates, disabled credentials, and empty pools (nothing went out); nor content-level failures (a 200 whose answer cannot be parsed — the /auto last-outcome surface owns those).

### 3. Storm coalescing — the rate-limit ledger's exact rule

Consecutive repeats of the same model+provider+errorClass+role within 10 s fold into one row: `count` bumps, `lastTs` moves, the row UPSERTs by stable `id`. A 429 storm is one growing observation, not hundreds of rows. Error `message` is log-grade English truncated to 400 chars — a row is an observation, not an archive of the wire body.

### 4. Storage mirrors quota_events exactly

In-process ring (500 rows) + durable mirror in the shared `traces.db` under its own `failure_events` table with an independent `bun:sqlite` handle (WAL, fault isolation via separate handles). Boot replays the newest 500 into the ring before traffic; non-bun runtimes degrade to memory-only; every method fails open — a failure observation must never break the request path it observes. No config knob: always-on, like `quota_events`.

### 5. L2 decision silence repaired — throttled warn

The decision layer's failure path (wire error, timeout, unparseable answer) now emits one throttled warn per failing model (dedup + window-capped, the shared warn-throttle) at the race-failure branch, while the /auto last-outcome record keeps its role as the always-fresh single verdict. The catch is no longer a black hole; the log, the /auto card and the ledger each carry the granularity appropriate to them.

### 6. Console surface

`GET /api/admin/failure-events` (equality filters `model`/`provider`/`errorClass`/`role`, optional `limit`, newest first) + `POST /api/admin/failure-events/clear` (ring + mirror; breaker/rate-limit state untouched) + `DELETE /api/admin/failure-events/:id` (ONE event — ring row and mirror row die together; a coalesced ×N observation is one row and dies whole; same `{ removed }` contract as the route-entries delete). The Failures page renders two sections over the SAME filtered view: a per-model aggregation strip (failed-call total, cause breakdown, last seen) above the coalesced event list — the strip and the table always answer the same question.

## Consequences

- "Which models failed, why, how often" is now a glanceable page instead of an archaeology dig; quota exhaustion, dead keys, 5xx runs and decision layer timeouts share one timeline with the emitting role attributed.
- Every upstream failure is durable across restarts (bounded to the ring budget) — the ledger is observability, not an archive.
- Zero routing impact: no consumer gates on the ledger; writes are fail-open; the plane is display-only.
- A decision layer that dies at QPS produces: one throttled warn line per model, a fresh /auto verdict, and coalesced ledger rows — three honest signals instead of silence.
- Tests: `failure-events` (record/coalesce/list-filter/clear, durable round-trip incl. boot replay, serving emission through the real pool, decision layer emission on wire error + timeout).
