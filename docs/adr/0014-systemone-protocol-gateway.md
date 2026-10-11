# ADR-0014: System One Protocol Gateway with Upstream Translation

## Status

Implemented — 2026-10-11.

## Context

**System One** is a decision-model protocol introduced by TypeSafe AI (September 2026, first model Jev) and independently adopted by Alibaba Cloud Model Studio's decision-model API (`decision-model-preview`) and LiteLLM's Auto Router (self-hosted classifiers Laya / Bespoke Nimble; hosted Jev). A System One request evaluates one `state` against a map of typed `questions` (`choice` / `noul` / `score`) and receives typed `answers` with probabilities and confidence — never generated text. Callers are routers, guardrails and triage pipelines that consume the values directly.

The gateway already carried a dormant TypeSafe touchpoint: the Layer 2 judge's `provider: 'typesafe'` branch posts to `POST {base}/decision/choice`, a shape that does not exist in TypeSafe's current public API (the only documented endpoint is `POST /v1/systemone`). That branch ships disabled (`classifier.layer2.enabled: false`) in both the example and live configs.

Operators want `POST /v1/systemone` served by the gateway — backed either by a native System One upstream (Jev / Bailian decision model) or by ANY registered chat model, with the protocol contract staying valid in all cases.

## Decision

### 1. Inbound surface: `POST /v1/systemone`

- New route (`backend/src/routes/systemone.ts`), registered next to the other protocol compatibility layers (`server.ts`). Auth and per-key model-access policies apply exactly like `/v1/chat/completions`.
- Structural validation only (`protocols/systemone/convert.ts#validateSystemoneRequest`): required `state`; non-empty `questions`; per-type shape (`choice` non-empty option map; `score` array of ≥2 levels; `noul` optional `{true,false}` hints). Upstream-specific limits (e.g. TypeSafe score ≤10 levels vs Bailian ≤255) are NOT enforced here — the upstream stays the authority. Invalid bodies → 400 `invalid_request_error` (gateway envelope; upstreams themselves use 422).
- `model` resolution: a registered physical model id; missing / `'auto'` / `'default'` falls back to config `systemone.defaultModel`; neither present → 400. No tier cascade, session ratchet or combo resolution — System One is a stateless decision surface: the model named is the model served.

### 2. Two upstream paths, selected by provider type

| Provider type | Path | Wire |
| --- | --- | --- |
| `systemone` (native) | passthrough | `POST {baseUrl}/systemone` with `{...body, model: upstreamModel}` |
| every chat type | conversion | synthesized chat completion + response synthesis |

- Native providers are declared in `config.providers` with `type: 'systemone'` (TypeSafe baseUrl `https://api.typesafe.ai/v1`; Bailian `https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`). The registry stores their config (`getProviderConfig`) but builds no chat executor — they are never routable through chat wires.
- Native responses pass through unchanged (`answers` / `usage` / vendor extras such as `request_id`, `latency_ms`), after a minimal `answers`-presence check (a non-System-One body from a native endpoint → 502 `upstream_error`).

### 3. Conversion contract (chat models)

- Request side: ONE chat completion carries all questions (`state` + `questions` JSON in the user message; a fixed system prompt pins the JSON contract). `temperature: 0`, `response_format: json_object`, `max_tokens: 4096`. Batching all questions mirrors System One's parallel evaluation (TypeSafe's own guidance: one batched call is ~12× cheaper and faster than sequential).
- Reasoning effort is pinned for the decision call (`decisionReasoningEffort` in convert.ts) with ONE rule — the LOWEST level we can trust, never a hard-coded `'none'`: operator `effortMap` translation wins first; an explicit `supportedReasoningEfforts` list yields its lowest level (`'none'` is trusted only there); the coarse legacy/catalog boolean yields `'low'` (it certifies "thinking-capable", not that the vendor enum accepts `'none'`); no effort declaration at all → the field is omitted (send nothing). System One is a fast-decision protocol — conversion calls must not burn thinking tokens by default.
- Vendor enums can contradict the catalog's coarse capability flag (Alibaba accepts only `low|high|max` while the model is still declared thinking-capable by the boolean catalog flag), so the route calibrates at runtime: a rejected `reasoning_effort` is re-targeted from the vendor's own error enumeration (its LOWEST allowed level, e.g. `must be one of: 'low', 'high', 'max'` → `low`), falling back to the conservative `none` → `low` → omit chain when the message doesn't enumerate; hard-bounded to 3 attempts and memoized per model for the process lifetime — the client never sees the vendor's effort 400.
- Response side: tolerant JSON extraction (code fences / first-`{` fallback) → per-question synthesis with normalization:
  - `choice`: declared option matched case-insensitively against the criteria keys; probabilities filtered to the criteria space and renormalized; empty distribution → degenerate `{winner: 1}` over the full option set; winner = declared else argmax; `confidence` = provided else distribution peak.
  - `noul`: numeric / boolean / yes-no string → clamped `[0,1]`.
  - `score`: level index clamped to `[0, n-1]`; without a declared index the probability-weighted expectation; `legend` rebuilt from the criteria array.
  - `usage`: `prompt_tokens` / `completion_tokens` → `input_tokens` / `output_tokens`.
- Failure handling: one repair retry (the model's previous output plus the failure reason are appended); still invalid → 502 `conversion_failed` naming the offending question ids. Deliberately no fabricated answers — a degraded answer is never synthesized silently.
- **Fidelity statement**: probabilities/confidence from a converted chat model are self-reported estimates, NOT calibrated (Jev's calibration comes from RLCD training). Consumers gating on confidence should prefer a native upstream. This is documented per ADR (and must be surfaced in user-facing docs).

### 4. Execution semantics (v1)

- Converted calls execute through `registry.execute` — the exact named model, with provider-level proxy policy, timeout and `UpstreamError` classification applying. The orchestrator's session / classifier / schema-assertion machinery is deliberately NOT engaged.
- Deliberately out of v1 scope: circuit-breaker tripping, FinOps accounting, trace/flywheel/capture records and decision caching for this surface; native upstream 4xx/5xx statuses are mirrored to the caller.

### 5. L2 judge migration path

The retired-on-touch `classifier.layer2.provider: 'typesafe'` branch (`/decision/choice`) should target the new native System One path when it is next enabled. It remains disabled by default; nothing in this ADR activates it.

## Consequences

- `/v1/systemone` becomes a first-class gateway surface: any registered model can serve it; native System One upstreams get exact passthrough.
- Operators can host a LiteLLM-style classifier endpoint on the gateway without a dedicated decision model — at the cost of uncalibrated probabilities (documented above).
- Converted-call resilience is provider-level only (timeout / proxy / error classification). Breaker + retry + FinOps integration for this surface is explicit follow-up work.
- The console has no System One provider editor yet — native upstreams are configured via `config.yaml` (`type: 'systemone'`; see `config.example.yaml`).