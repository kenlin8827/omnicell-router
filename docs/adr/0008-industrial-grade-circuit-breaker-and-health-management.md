# ADR-0008: Top-Tier Industrial-Grade Model Circuit Breaking, Multi-Level Failover and Health Management System

## Status
Accepted & Implemented - 2026-09-30

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
