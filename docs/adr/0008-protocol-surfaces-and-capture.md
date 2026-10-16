# ADR-0008: Protocol Surfaces and Capture — One Dispatch Table for Both Transports, Exchange Events Not Turn Snapshots, Opt-in Full-Chain

## Status

Implemented — 2026-10-15 (facts-side corpus rewrite). Scope: the inbound protocol faces (native routes + MITM proxy), their shared dispatch seam, the System One decision gateway, and the request-capture plane. Trace persistence/observability split = ADR-0005; dataset sampling (NOT capture) = ADR-0001; addressing on the decision surface = ADR-0003.

## Decision

### 1. One table, two transports, one seam

`SURFACES` (`surfaces/table.ts:8-23`) is the single registry: one entry per inbound face with `routePath / detectSuffix / exec / capture / encodeStream`. The SAME table drives Fastify route registration (`server.ts:1044-1056`) and MITM path detection (`detectSurface` suffix match) — and the rate-limit route table derives from it too (`INFERENCE_ROUTE_PATHS = SURFACES.map`). `dispatchSurface` branches only on `exec`: `chat-pipeline` | `decision-pipeline`. Both transports build a `TransportContext` (`surfaces/types.ts:58-79`): `method/url/headers/clientIp` + the access gate (discriminated: `kind:'key'` on Fastify — validated bearer/x-api-key + per-key modelAccess, guard already wrote the 403; `kind:'exempt'` on MITM — the client connects THROUGH us, trust lives at the CONNECT/TLS layer + bypass list; no gateway key, so captured events carry no apiKey attribution and upstream calls use the registered provider's own credentials) + `captureProcessContext()` (answers `{}` when capture off) + terminal sends (`sendJson` / `beginSse`+`writeSseChunk`+`endSse`) + `isClientGone()` + `logError`. Terminal-send discipline: exactly one terminal send per request, and parse/gate failures emit ZERO capture events (all pre-dispatch on both legs).

### 2. Inbound wire aliases — exactly four; Gemini is an upstream wire

`/v1/chat/completions` (OpenAI-compatible), `/v1/messages` (Anthropic-compatible), `/v1/responses` (OpenAI Responses), `/v1/systemone` (decision gateway). The wire alias table is closed — anything else 404s. Gemini `:generateContent` is OUTBOUND provider wire (`providers/google.ts`; outbound wire set `openai|anthropic|google|responses|opencode-proxy`), never an inbound alias. The systemone `detectSuffix '/systemone'` is intentionally WIDER than its routePath so the MITM leg claims upstream native decision traffic (typesafe.ai / bailian) passing through the proxy.

### 3. MITM forward proxy — full capture is the point

Default posture: EVERY HTTPS CONNECT MITMs unless loopback or `bypassHosts` (`forward-proxy/server.ts:15-22`): SNI peek → `startMitm` → decrypted stream spliced into an inner `http.Server`; surface match + POST ⇒ dispatch; otherwise transparent byte relay (`relay.ts` splice with backpressure; hop-by-hop header set — connection/keep-alive/TE/trailer/transfer-encoding/upgrade/proxy-* — stripped both directions). Request body cap 32 MB (413) and malformed JSON (400) both fail BEFORE capture/dispatch — zero events. Bare-name disambiguation rides `upstreamHost` = the intercepted request's host (`orchestrator.ts:106-124`; the native leg deliberately does NOT trust Host — anti-spoofing, ADR-0003 §1.5).

### 4. Trace identity, both legs identical

One shared extractor (`observability/trace-id.ts`): inbound precedence `traceparent` > `x-request-id` > `x-trace-id`/`x-correlation-id`/`request-id` > mint 32-hex (W3C-validate-or-mint, never echo malformed); MITM reads the ORIGINAL client request headers. Outbound traceparent injection is NOT implemented (builder exists for tests only). Captured `clientHeaders` are the safe subset `{userAgent, acceptLanguage, requestId}`; authorization/api-key/cookies are structurally never in the trace record.

### 5. requestCapture — HTTP-exchange events, not turn snapshots

Namespace: `requestCapture:` — the retired top-level `capture:` section (rename residue), `classifier.layer2.decisionCapture`, and key-level `role` are load-STRIPPED and never rewritten back on save; both console save paths hot-apply (`routes/console.ts:1074,1098`). One namespace, one meaning: **request/HTTP exchange logging** (training-data sampling is a different concern, ADR-0001 §5).

Model: `HttpExchangeEvent` — one event per direction per leg; an inference turn produces 2–4 events sharing one `traceId`: client-request / gateway-response / upstream-request / upstream-response (the older turn-shaped `CaptureRecord` is @deprecated). Every event additionally carries `conversationKey` (ADR-0002 §1: sha256(apiKey identity + first user message), content-addressed, absent when unresolvable) so the archive can regroup a conversation across volatile session ids. Header regime (current code): NAMES preserved, credential-shaped VALUES `[REDACTED]` via substring deny-list (authorization/api-key/cookie/token/secret/bearer/…-key/key/auth), query-string auth params redacted too. Master `enabled:false` default — OFF is a BYTE-IDENTICAL zero-event posture (pinned by tests), on is conscious opt-in (the `/api/admin/*` auth-exempt reminder applies). Sink: `<capture>/<YYYY-MM-DD>/<sanitized-sessionId>.jsonl`, retention 7 d / 512 MB / body cap 64 KB, boot + hourly sweeps, ALL I/O fail-open. Gateway-response body stash capped 1 MB; client disconnects finalize through the transports (synthesized 499) — hang/cancel still leaves a record. The `/v1/systemone` surface itself never captures FinOps or trace rows — capture is exchange events only.

### 6. System One surface — two-leg opt-in gate tree

`requestCapture.enabled` (master, default OFF) × `requestCapture.systemone.enabled` (surface gate, default ON; flipping it silences BOTH legs — client pair and the surface's own upstream pair, native passthrough or synthesized conversion alike; no purpose tag). Emission is strictly AFTER all 400/403/404/503 gates. The Layer-2 judge's internal calls form a THIRD knob: `isSystemoneJudgeCaptureEnabled = master × surface × systemone.l2DecisionEnabled` (default ON) — the sub-switch can only ADD events (the judge's own HTTP leg, attached to the OUTER routed request as upstream direction, `purpose:'l2-judge'`, the sole `ExchangePurpose` value), never bypass its master. Privacy posture when off: `captureProcessContext()` returns `{}`, the surface path is byte-identical to a build without capture.

### 7. The decision gateway (/v1/systemone) — two upstream kinds, honesty by wording

Native (`provider type:'systemone'` — TypeSafe Jev / decision-model-preview): passthrough, zero loss. Everything else: PROTOCOL CONVERSION — one JSON-constrained chat completion carrying all questions; the response's probabilities are then "self-reported estimates, NOT calibrated" (wording lives in the protocol types + reasonCode split, ADR-0001 §4). Model semantics on this surface: named model = that model; auto-tier aliases resolve by PURE POOL PROJECTION to the chain head of the access-filtered pool — 404 unknown/no-pool, 403 denied, 503 unresolvable, NEVER a silent fallback; bare/`auto`/`default`/omitted → `systemone.defaultModel`; native upstreams use registry chain-head credentials; decision-line rate accounting counts but never locally rejects (the judge is a below-request leg). Exactly three response headers (frozen contract): `X-OCR-Model / X-OCR-Systemone-Upstream / X-OCR-Latency-MS`. The SAME executor backs the Layer-2 router judge — one implementation, two callers.

### 8. Responses continuation state (`responses.persist`)

The `/v1/responses` chain store is authoritative in-memory (L1 Map); `responses.persist: false` default = byte-for-byte in-memory posture; ON mirrors an append-only JSONL (`<env dataDir>/responses-chain.jsonl`, 0600) replayed at boot (TTL filter 24 h → createdAt order → cap sweep → atomic compaction; boundaries 20 k nodes / 256 KB node / 64 MB file / compact per 1000 appends). Persist turns RESTART AMNESIA into "lost the last unflushed turn" — a chain-using client whose store rolled gets the documented fail-visible 400 (full-resend degradation, prompt preserved); disk failure only ever warns, never fails a request; persist-OFF chain users get a one-per-process warn explaining the exposure.

## Consequences

- Adding an inbound face = one table row; both transports inherit dispatch, header, capture and rate-limit behavior — per-leg drift is structurally impossible (the header module's comment records the old drift as the reason it exists).
- Capture answers "what crossed the wire", traces answer "what decided and executed", datasets answer "what should the models learn" — three planes, three namespaces, no key implies another.
- Privacy postures are default-off/byte-identical and test-pinned, opt-in is two-level and honest about exposure.
