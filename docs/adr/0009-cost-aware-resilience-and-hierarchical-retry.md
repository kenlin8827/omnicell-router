# ADR-0009: Cost-Aware Highly Resilient Two-Layer Retry and Cross-Tier Failover Architecture

## Status
Accepted & Implemented - 2026-09-30

## Context
In the long-running, high-concurrency evolution of the production-grade intelligent routing gateway, the circuit breaker (ADR-0008) successfully isolated upstream faults, but directly triggering model failover exposed severe economic and engineering hazards in large-context applications:

1. **KV Cache / Prompt Cache economics pain points**:
   - Mainstream LLMs (Anthropic Claude 3.5 Sonnet, DeepSeek-V3, OpenAI GPT-4o) offer discounts of up to 90% on Prompt Cache hits (e.g. $3.00 per million tokens dropping to $0.30, or DeepSeek from $0.14 to $0.014).
   - In long multi-turn sessions (50k–100k tokens), an occasional transient wobble at a cloud vendor's edge gateway (503 Bad Gateway, 502, ETIMEDOUT) that indiscriminately switches to a different model (e.g. Claude-3.5 → GPT-4o) causes the already-warmed upstream KV Cache to be **instantly invalidated to zero**, multiplying that request's cost 10× — a massive waste of compute and money.
2. **The inefficiency of blind in-place retry and blanket no-awareness retry**:
   - Traditional gateways either never retry or blindly retry every error. For arrears (HTTP 402 `insufficient_quota`) or dead keys (HTTP 401), in-place retry can never succeed and only adds hundreds of milliseconds of latency; for client syntax errors (HTTP 400), retry is even more meaningless.
3. **Blurry boundaries for "cross-tier" model failover**:
   - When the primary model fails and in-place retry fails, may the gateway switch across Tiers?
   - Switching arbitrarily could silently "downgrade" a code-refactoring task that genuinely needs a flagship (Plus) model to a cheap small model (Lite) during an outage, causing a severe Intellectual Cliff and hallucination pollution; conversely, never escalating when all Lite models fail would leave the user-facing surface erroring out and paralyzed.

## Decision
Fully establish a **cost-aware, highly resilient two-layer retry (In-Place & Failover) architecture with tier anti-downgrade failover**:

### 1. Two-Layer Retry Topology (`retry: { inplace, failover }`)
The gateway strictly decouples retry responsibilities into a two-stage pipeline:

```text
               +----------------------------------------------------+
               |                Client Request                      |
               +----------------------------------------------------+
                                         |
                                         v
               +----------------------------------------------------+
               |            Candidate 1 (Primary Model)             |
               +----------------------------------------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                 [Transient 5xx/Timeout]            [402/401 Hard Trip]
                       |                                   |
                       v                                   v
        +-----------------------------+         (Bypass In-Place Retry)
        |  Tier 1: In-Place Retry     |                    |
        |  (200ms + 100ms Jitter)     |                    |
        +-----------------------------+                    |
          | (Success)             | (Failed)               |
          v                       +------------------------+
   [Return 200 OK]                                         |
   (100% KV Cache Saved!)                                  v
                                       +-------------------------------------+
                                       |      Tier 2: Multi-Model Failover   |
                                       |   (Exhaust Same Tier -> Escalate)   |
                                       +-------------------------------------+
                                                         |
                                                         v
                                       +-------------------------------------+
                                       |    Candidate 2 (Backup Model)       |
                                       +-------------------------------------+
```

* **Layer 1: In-Place Retry (fine-grained jitter diagnosis to save the KV Cache)**:
  * **Network Failure Taxonomy**:
    The system performs precise low-level diagnosis of exceptions through [`ErrorClassifier`](../../backend/src/resilience/error-classifier.ts), decomposing them into a `networkCause` and deciding `isInPlaceRetriable`:
    1. `CONNECTION_RESET` (connection interruption: `ECONNRESET`, `ECONNABORTED`, `socket hang up`, `EPIPE`, `und_err_socket`): **immediate in-place retry**;
    2. `NETWORK_TIMEOUT` (timeout jitter: `ETIMEDOUT`, `ESOCKETTIMEDOUT`, HTTP 504 Gateway Timeout, `AbortError`): **immediate in-place retry**;
    3. `GATEWAY_ERROR` (momentary gateway failure: HTTP 502 Bad Gateway, HTTP 503 Service Unavailable, Cloudflare 52x): **immediate in-place retry**;
    4. `DNS_ERROR` (DNS jitter: `EAI_AGAIN`, `ENOTFOUND` — transient name-resolution failures): **immediate in-place retry**;
    5. `RATE_LIMIT_BURST` (transient short rate-limit: HTTP 429 with `Retry-After <= maxRateLimitWaitMs`, default 2s): **wait-and-retry in place on demand** — an in-place wait of just 1–2 seconds saves the high-value KV Cache of 50k–100k tokens, an enormous economic benefit; beyond 2s, switch to a backup model immediately;
    6. `SERVER_INTERNAL_ERROR` (HTTP 500 internal server error): by default NOT retried in place (upstream code defects most likely fail again on retry), but can be explicitly enabled via configuration;
    7. `HARD_FAILURE` (HTTP 402 arrears, HTTP 401 key invalidation, HTTP 400 bad parameters): **absolutely never retried in place** (0 retries; pass straight through to Failover or to the response).
  * **Policy configuration parameters (`retry.inplace`)**:
    * `maxAttempts`: maximum in-place retry attempts (default: 1);
    * `backoffMs`: base backoff duration (default: 200ms);
    * `jitterMs`: random jitter (default: 100ms), preventing a thundering-herd strike on the upstream under high concurrency;
    * `retryOnCauses`: whitelist of failure causes allowed for in-place retry (freely customizable filtering supported);
    * `maxRateLimitWaitMs`: maximum tolerated 429 wait for in-place backoff (default: 2000ms).
  * **Economic value**: industry data shows a single micro-backoff resolves roughly 70% of cloud-vendor gateway spike jitter, **preserving 100% of the upstream KV cache state** and completely avoiding the 10× cost explosion caused by cross-model switching.


* **Layer 2: Candidate Pool Failover**:
  * When in-place retries are exhausted without recovery, or a 402/429 error is hit, the breaker records the failure and seamlessly activates backup candidate models;
  * Governed by `retry.failover.maxAttempts` (default 2 models) to prevent endless serial model traversal causing extreme latency in the worst case.

### 2. Cross-Tier Switching Policy and the Strict Anti-Downgrade System (`tierCrossPolicy`)
Clear escalation boundary rules, with two policy levels:

* **`allow_escalate` (default, recommended: same-tier exhausted → escalate upward to stay alive, never dive downward)**:
  1. **Same-Tier Exhaustion First**: if the routing verdict targets the Lite Tier, all healthy Lite models must be traversed first (`lite-primary` → `lite-backup`);
  2. **Upward Escalation**: only when every healthy candidate model in the current Tier is unavailable or the request fails, transparently upgrade to higher Plus/Pro/Ultra Tier candidates, preventing hard interruption of the business side;
  3. **Strict Anti-Downgrade iron rule**: **if the request itself is classified or forced as Plus/Pro/Ultra Tier, when that Tier becomes wholly unavailable the system is strictly forbidden from downgrading to Lite models!**
     * *Rationale*: in complex system architecture, code generation and mathematical-logic scenarios, the harm of low-quality output and subtle Bugs caused by downward degradation far exceeds that of an explicit 503 error.
* **`same_tier_only` (strict same-tier lockdown)**:
  * Failover is strictly confined to the registered model pool of the current Tier, never crossing any Tier boundary;
  * Suited to budget-controlled large-scale offline batch tasks (Batch Processing), avoiding a task auto-jumping to an expensive flagship model due to upstream congestion and blowing up the bill.

### 3. Full-Chain Observability Extension (Observability & Headers)
All HTTP responses (both normal mode and SSE streaming) inject precise resilience governance metadata:
* `X-OCR-InPlace-Retries`: number of in-place retries (`0` or `1`);
* `X-OCR-Failover`: whether cross-model failover occurred (`true` / `false`);
* `X-OCR-Failover-Attempts`: number of candidate models actually tried;
* `X-OCR-Failover-Path`: full transfer chain path (e.g. `gpt-4o -> claude-3-5-sonnet`);
* `X-OCR-Breaker-State`: breaker state of the final model (`CLOSED` / `HALF_OPEN` / `OPEN`);
* The session trajectory tracker (`TraceTracker`) and monitoring logs record all the governance fields above in full.

## Consequences and Impact
- **Positive impacts**:
  - **Maximizes Prompt Cache economic returns**: eliminates the vast majority of blind model switches caused by upstream gateway spikes, preserving the 90% cache discount;
  - **Zero wasted latency**: 402 arrears and 401 authentication faults spend 0 in-place waits and trigger same-tier fast failover directly;
  - **R&D intellectual safety**: the "escalate one way, never downgrade" safety policy blocks model degradation and Intellectual Cliffs induced by disaster recovery;
  - **Minimal semantic configuration**: declared clearly in `config.yaml` via the `retry: { inplace, failover }` structure, covering both simple scenarios and professional production needs.
- **Negatives and trade-offs**:
  - Against persistent, unrecoverable 5xx failures, the first model undergoes an extra ~250ms in-place backoff before switching to the second model — the small weighed price paid to save the high-value KV Cache.
