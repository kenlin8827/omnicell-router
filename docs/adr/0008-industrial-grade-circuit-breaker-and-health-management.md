# ADR-0008: Top-Tier Industrial-Grade Model Circuit Breaking, Multi-Level Failover and Health Management System

## Status
Accepted & Implemented - 2026-09-30
**Amended 2026-10-14** — breaker state is persisted to disk (see §Amendment). The original in-memory-only posture is superseded: cooldowns, backoff position, sliding windows and manual trips now survive a gateway restart.

## Context
In large-scale production-grade AI gateway and model-routing gateway practice, upstream LLM services are strongly heterogeneous, cross-vendor and highly volatile, facing many unavoidable availability challenges:

1. **Quota Exhausted**: an account suddenly falls into arrears or its token quota is used up (HTTP 402 / `insufficient_quota`). Without perception, the gateway keeps hammering that model with the full subsequent request flood, failing every one of them.
2. **Multi-Hour Vendor Outages (5-Hour Outages)**: upstream service avalanches (500/502/503/504 / network timeouts). Without a circuit breaker, every request waits for tens of seconds to time out, draining the gateway's connection pool and dragging downstream clients down.
3. **Rate Limiting (429)**: on TPM / RPM overruns, without short backoff, the gateway cannot offload traffic onto alternate models within the same Tier.
4. **Session Ratchet Deadlock**: Session model locking (Pinning) was introduced earlier to protect KV Cache hit rate, but when the pinned model goes down, every subsequent turn of that session is completely paralyzed.
5. **Mis-tripping caused by client mistakes**: a client sending an over-long context (400 context length exceeded) or being blocked by safety filtering is a user-input problem — it must never be wrongly counted as a model failure or cause the model to trip its breaker.

## Decision
Build an industrial-grade resilience system end to end: **a high-precision Error Taxonomy, a multi-level Circuit Breaker state machine, Same-Tier transparent failover and Session Self-Healing**:

### 1. Structured Error Taxonomy (Error Taxonomy & Diagnosis)
Upstream anomalies are strictly decomposed into 6 classes, each governed differently:
* `QUOTA_EXHAUSTED` (HTTP 402 / `insufficient_quota`): **immediate Hard Open**, entering a long cooldown (default 12 hours); no high-frequency probing; supports manual reset from the admin backend;
* `AUTHENTICATION_ERROR` (HTTP 401 / `invalid_api_key`): **immediate hard open**, locked until the key is reloaded;
* `RATE_LIMITED` (HTTP 429 / TPM/RPM): **instant adaptive backoff**, preferentially parsing the `Retry-After` header, briefly steering clear while alternate same-Tier nodes take over;
* `SERVICE_UNAVAILABLE` (HTTP 5xx / network timeout / ETIMEDOUT): **sliding-window + consecutive-failure-threshold trip**, entering stepped exponential backoff (30s → 60s → 120s ... capped at a maximum of 5 hours);
* `CLIENT_ERROR` (HTTP 400 / context length exceeded): **zero-penalty pass-through**, not counted as a model failure, triggers no retry and no breaker trip;
* `UNKNOWN`: standard fault-tolerant retry.

### 2. Standard Three-State Circuit Breaker State Machine
* `CLOSED` (healthy): carrying traffic normally;
* `OPEN` (tripped): blocking requests to that model, diverting to alternate models instantly at zero added latency;
* `HALF_OPEN` (probing): after the cooldown expires, admit a trickle of canary (Canary) requests to probe. If probing succeeds, fully restore `CLOSED`; if it fails, double the cooldown duration and `OPEN` again.

### 3. Transparent Same-Tier Candidate Pool Failover (Zero-Downtime Failover)
* Each Tier maintains a prioritized candidate list (`primary`, `backup-1`, `backup-2`);
* Requests are dispatched to the primary model first; when the primary throws a recoverable failure (402/503/429), the breaker records the fault and, **within the same HTTP session, transparently transfers to a same-Tier backup model at millisecond latency**;
* The user receives a 200 success response unaware, with governance trace metadata attached in the response headers:
  * `X-OCR-Failover: true`
  * `X-OCR-Failover-Attempts: 2`
  * `X-OCR-Failover-Path: primary-model -> backup-model`
  * `X-OCR-Breaker-State: CLOSED`

### 4. Session Monotonic Ratchet Self-Healing (Session Self-Healing)
* When the `pinnedModel` bound to a session is detected to have entered the `OPEN` tripped state, the gateway automatically unbinds it and smoothly migrates/re-pins (Repin) the session to a healthy same-Tier backup model, eliminating the deadlock entirely.

### 5. Full-Spectrum Observability and Admin Interfaces (Observability & REST APIs)
* `GET /health`: intelligently summarizes the gateway's global health (`ok` / `degraded` / `outage`) and breaker health counts;
* `GET /v1/health/circuit-breakers`: exposes all models' live state, remaining cooldown duration, failure class, total request/failure counts;
* `POST /v1/health/circuit-breakers/reset`: provides administrators a one-click reset endpoint after manual recharging or vendor-side troubleshooting is complete.

## Consequences and Impact
- **Positive impacts**:
  - Ends for good the fragility of "a model falling into arrears or being down for 5 hours taking the whole service with it", achieving true 99.99% enterprise-grade high availability;
  - Zero-configuration transparent disaster recovery: clients use the gateway like a standard OpenAI API, while multi-vendor seamless switching happens automatically underneath;
  - Precisely protects upstream billing and connection-pool resources, eliminating sustained avalanche traffic toward dead upstreams.

## Amendment (2026-10-14) — Breaker Memory Survives Restart

**Problem.** The state machine lived only in process memory, so every restart wiped all cooldowns: a 402 quota trip (12h) or an operator manual trip (up to 7d) was silently undone, and a freshly booted gateway re-hammered accounts still inside their cooldown window. The registry's own docstring delegated persistent exclusion to `config.tiers` — a workaround for the gap, not the intent.

**Decision.**

- `<OCR_HOME>/breaker-state.<env>.json` (version 1, **per environment** — unlike the suspect flags, which stay GLOBAL because an account is suspect wherever it is used, breaker memory keys on model ids that belong to the ACTIVE env's config; restoring under env B prunes env A's records and the first save would rewrite the file, so one shared file would make an env switch destroy the other book-set's memory). It carries the full mutable state of every model and pair breaker: state, consecutive counts, totals, sliding window, `cooldownUntil`, the backoff position (`currentCooldownMs`), probe counters and the trip reason triple. Same file doctrine as `suspect-accounts.json` (atomic temp+rename, mode 0600, load-once, a corrupt file starts with empty memory and is renamed `.corrupt.<ts>` aside on the first write).
- **Write timing**: every public mutation entry point arms a ~1s debounced snapshot; a `process.on('exit')` hook flushes synchronously — signal handlers never run for `process.exit()` (the console's restart route exits exactly that way), and 'exit' also covers SIGINT/SIGTERM/SIGBREAK paths plus natural termination. Hard kills (`taskkill /F`, power loss) have no handler: the debounce window is the honest loss bound there (the governance-overlay doctrine: a brief loss is under-shaping, not a lie). A failed save keeps the snapshot for the next mutation or the exit retry — one transient write error (AV holding the rename target, momentary ENOSPC) does not silently drop a trip.
- **Restore ordering**: the boot path attaches the store AFTER all config models are registered and drops records for models the current config no longer knows (self-cleaning, no ghost breakers). Identity (provider/tier) always comes from the CURRENT config; the file's copy is display-only. The restored `cooldownUntil` is clamped to `now + currentCooldownMs` so a wall-clock **rewind** while the gateway was off cannot stretch a cooldown past its ladder position; a clock **forward jump** shortens it — fail-open, the same pre-amendment behavior a live process would show, noted rather than fixed.
- **Trust boundary**: illegal state values, reason codes/categories outside the closed vocabulary, non-primitive `reasonParams` entries and non-numeric scalars are sanitized at load; a malformed record is dropped, never fatal, and a save failure degrades to a warning — the gateway keeps running on in-memory breakers. A file that EXISTS but cannot be READ (EACCES, transient AV lock) starts empty **loudly** and is preserved aside on the first write, never silently overwritten.
- **No config flag, default-on** — consistent with `suspect-accounts.json`, which was always persisted. The payload stays display-safe (model ids, provider, keyHash prefixes, classifier reason text; never key material) — with the honest caveat that classifier `reason` strings embed up to ~150 chars of upstream response body, the same text already exposed in console snapshots; mode 0600 is best-effort (a no-op on Windows, real ACLs would need icacls).
- The consuming gate (`canExecute` probe-slot consumption) and the lazy OPEN→HALF_OPEN transition do NOT schedule writes on their own; a consumed canary slot normally ends in `recordSuccess`/`recordFailure`, which does. A debounced save or the shutdown flush can still land mid-canary and persist an exhausted HALF_OPEN quota, so `applyRecord` refreshes the probe quota when restoring a HALF_OPEN record — a restart can never strand a breaker in HALF_OPEN (worst case: one extra canary after the restart).
- A successful canary recovery (HALF_OPEN→CLOSED) also re-arms the sliding window EMPTY: stale failures from the outage must not let one transient blip re-trip the model the moment it recovers (the consecutive-failure count resets as before; the fresh window earns its rate threshold back from zero).

**Consequences.**

- (+) Quota/rate cooldowns, the escalation ladder and manual trips survive restarts; recovery probing resumes exactly where the previous lifetime left off.
- (+) CLOSED-state failure accumulation survives too (consecutive counts and the sliding window are no longer reset by a restart).
- (−) The file lives under the GLOBAL state root and is raced by concurrent gateway instances sharing one `OCR_HOME` — the same accepted stance as the suspect flags (single-process is the product form).
- (−) A manual trip is no longer "cleared on gateway restart": a forgotten trip cools until its own cooldown expires; permanent exclusion still means `config.tiers` exclude lists.
