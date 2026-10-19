# ADR-0005: Execution Topology — Pure Direct Execution, the Single Candidate Choke Point, Two-Stage Retry, Cache Economics

## Status

Implemented — 2026-10-15 (facts-side corpus rewrite). Scope: how a decision becomes an upstream call; what the boot pool is built from; retry/failover semantics; streaming; token-saver compression; cost truth. Health semantics = ADR-0004; addressing/membership = ADR-0003; credential selection/affinity = ADR-0002.

## Decision

### 1. Pure direct execution — no daemon on the inference path

The gateway calls provider HTTP endpoints itself; nothing on the request path depends on any background helper process (the historical "daemon" was fully removed from inference; the name `bootDirect` is the surviving evidence). `buildDirectPool` runs at BOOT ONLY (`index.ts:124`; no pool-rebuild HTTP endpoint exists — provider defs and credentials are boot-scoped, tier membership is live per ADR-0003). Mock mode injects `mock-lite/plus/pro/ultra` only when the pool is empty (`registry.ts:115-152`).

### 2. Three sources of truth for the boot pool

`providers/boot-direct.ts`: (a) `opencode.jsonc` provider nodes — CURRENT shape only (the single `providers` slot; legacy node-level `npm/options` shapes are dropped-and-reported; `env:[VAR]` names materialize to `{env:X}` templates); (b) the boot-bound CredentialStore chain (ADR-0006) — `resolveKey/resolveKeyChain` with the chain-head invariant: `chain[0].key === config.apiKey`, inline keys unshift ahead of store keys, raw keys stay IN-PROCESS, never serialized; (c) the catalog (wire + pricing, ADR-0007 domain boundary: catalog files, this record consumes).

Failure doctrine: an unroutable provider is EXCLUDED and reported (`db_unreadable | no_credential | no_baseURL | all models unroutable`), never a boot abort; OAuth rows are listed-and-badged, never enter chains, never routed (`:163-209,323-326`). Wire dispatch is DATA-DRIVEN: npm package priority `model > catalog entry > provider def > recommendation` — protocol truth lives in catalog data, not code tables (`wire.ts:1-11`); per-provider bases: openai-compatible / anthropic / responses / google; System One is not a chat executor (decision protocol direct-called, ADR-0008).

### 3. The single candidate choke point

`executeCandidatePool` is the ONE execution funnel for every entry mode (auto/explicit/combo/escalation) — so per-key model-access filtering applied there covers everything, including tier-escalation tails into denied models (`orchestrator.ts:1316-1331`; `policyDenied` → honest 403, `:939-946`). Per-candidate sequence fixed: selectCredential (health+affinity+slack, ADR-0002/0004) → rate-limit PEEK → consuming breaker gate `canExecuteScoped` (the ONLY probe-consuming check on the request path) → outbound slot deduct → `registry.execute` with the chosen credential (unknown-selector throw unreachable — stale-binding recovery happens at the selection boundary, never as a 500) → scoped breaker record. Last candidate is forced free when every gate denies (all-unhealthy keeps the legacy no-prefix force); all-DISABLED is NEVER forced (a takedown outranks availability, ADR-0004).

### 4. Two-stage retry economics

- **In-place micro-backoff** against the SAME candidate (default 1 extra attempt, 200 ms + 100 ms jitter): a transient network/5xx blip retried on the spot preserves prompt-cache locality (a 10×-cost retry beats a failover prefill); cause-whitelist gated (`retryOnCauses` — `server_internal_error` excluded by default on purpose: an ambiguous 500 may have executed); short-RA 429 burst eligible; 401/402 NEVER in-place (unattributable / quota — go around now).
- **Failover chain walk**: auto attempts = `retry.failover.maxAttempts` budget; explicit/combo cap = chain length (their own composition is the contract); `tierCrossPolicy: same_tier_only | allow_escalate` — escalate mode adds a healthy `plus` tail ONLY to a `lite` chain; strict Anti-Downgrade: a higher-tier chain never gains a lower-tier tail (`:1227-1229,1311-1315`).
- Schema-assertion cascade (auto + structured output only): lite lead → LOCAL static assertion (zero extra LLM cost; JSON syntax/required/type/enum) → on failure escalate to `fallback.escalateTier` (plus|pro|ultra) with the failed output + `[System Assertion Error]` correction appended and temperature 0.1 — skipped entirely for explicit models, combos, and `router_options.disable_fallback`. Fallback is honest (cause carried in `reasonParams`), not a silent rescue.

### 5. Streaming is downstream-only re-chunking

The gateway executes NON-streaming upstream calls and re-chunks to the client as SSE (`chat-sse.ts:3-6`): role → content in 4-char chunks → tool_calls in 32-char chunks → final chunk with the real `finish_reason` + usage. Terminal payload is ENCODED BEFORE `beginSse` (never a double-terminate). Both transports implement `beginSse/writeSseChunk/endSse`; `X-OCR-*` headers ride the SSE leg identically. Client-gone is detected per-leg and recorded as a synthesized 499 (nginx convention) — never sent upstream. MITM traffic not matching the surface table bypasses everything as a raw bidirectional splice (hop-by-hop headers stripped both ways; ADR-0008).

### 6. Token-saver compression family — three stages, all fail-open

`applyCompression` before routing (`compression/index.ts:36-75`): ① **rtk** tool-output compression (git/grep/ls/logs/build patterns; deterministic ⇒ same bytes same cache key); ② **headroom** sidecar proxy (`POST /v1/compress`, session-sticky by the gateway's OWN sessionId ⇒ replayed prefixes stay byte-stable; fail-open); ③ **caveman** output-style injection (idempotent system-message append; `lite|full|ultra|wenyan-*` levels; constraints verbatim-preserve code/paths/commands/URLs/errors, restore full sentences for safety warnings, keep the USER's language). The **pre-compression fingerprint principle** closes the loop: clients always resend ORIGINAL bytes, so session anchors index the pre-compression snapshot (`orchestrator.ts:491-505`; identity in ADR-0002) while the upstream compressed prefix stays stable through determinism + session mode.

**Sidecar lifecycle — association, not ownership** (`compression.headroom.autoStart`, opt-in default false): at boot the gateway probes `<url>/health` and ADOPTS any already-running instance; only when nothing answers does it spawn `headroom proxy --host 127.0.0.1 --port <from url> --mode cache` DETACHED (loopback URLs only) and poll readiness (≤20 s) without ever blocking the request path — fail-open carries traffic meanwhile, and a sidecar still mid-startup is adopted by the next probe. The spawned pid is recorded at `<home>/headroom.pid` (process-level file, ADR-0007 convention) and the gateway NEVER kills the sidecar on exit: headroom's session-replay state is exactly what keeps upstream prefixes byte-stable across the gateway's own controlled restarts (ADR-0007), so the sidecar is designed to outlive the gateway. Console surface: `GET /api/admin/headroom/sidecar` + `/start` + `/stop`. Stop works regardless of who started the instance: a gateway-recorded pid is killed directly, and a manually started LOCAL instance is identified by port (`Get-NetTCPConnection` / `lsof`; loopback only — the /health probe just confirmed that port serves headroom) and killed the same way; refusals stay honest — remote instances (`not-loopback`) and unidentifiable listeners (`pid-unknown`) are reported with machine codes the console localizes, never guessed.

### 7. Cost truth without savings theater

Per-request cost = uncached×input + cached×`cache_read` + output (+ reasoning premium only when the model prices it) (`request-cost.ts:13-39`). `cache_read` is a CATALOG price (fallback `input×0.25`) — no hardcoded discount constant. Baseline/savings are DELIBERATELY not computed (the legacy `savedCostUsd` field is stripped on replay): a counterfactual baseline is not a measurement. FinOps tier/token/latency aggregates live IN-PROCESS; only `totalRequests`+`fallbackCount` persist (`finops_totals` in the shared `traces.db`, WAL, own handle — fault-isolated from trace writes). Exposure: the trace `finops` block + `GET /api/admin/metrics` (+reset). There are no `X-OCR-FinOps-*` headers.

### 8. Observability plane of the execution path

TraceTracker: ring 5000 + per-env `traces.db` (WAL) persistence, retention 7 d / 100 MB, hourly sweep; record = request summary (safe `clientHeaders` subset) + routing (reason/reasonCode/reasonParams incl. eviction attribution, ADR-0002) + execution + finops. Admin surfaces: traces (ring→db, cold sessions rebuildable from persisted traces), sessions (live rows joined), logs (ring buffer tail ≤ 5000). Fastify per-request access logging is DISABLED by design (UI polling noise; 5xx floor kept via onError) — request observability is the trace/capture plane's job, not stdout's. The capture seams are named `observability/http-exchange` (client leg) + `observability/upstream-events` (`UpstreamEventContext` threaded through `process()`, provider-side emit contract) — no other event-sink abstraction exists.

## Consequences

- One execution funnel ⇒ security filtering, breaker accounting, and rate deduction have exactly one home; entry-mode differences are POLICY fields on the same mechanism.
- Cache economics are explicit at each layer: in-place retries, deterministic compression, session-sticky sidecars, byte-stable fingerprints — and cost numbers stay measurements, never marketing.
- Degradation is loud: exclusions reported, fallback causes carried, empty pools warned.
