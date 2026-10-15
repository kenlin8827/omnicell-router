# ADR-0001: Routing Pipeline — Cascaded Tier Decision, Judge with Decision Cache, Dual Flywheel

## Status

Implemented — 2026-10-15 (facts-side corpus rewrite). Scope: how an auto/default request picks a tier, how the expensive leg is made cheap, how learning data is sampled. Request-`model` name resolution = ADR-0003; conversation policy = ADR-0002; the judge's protocol surface = ADR-0008.

## Context

Auto routing must choose `lite|plus|pro|ultra` per turn from structural signals — language-neutral, cheap, deterministic in its fallbacks, and never thrashing a conversation (the session ratchet rides this decision, ADR-0002). The founding boundary of this repo: **response caching of any kind is banned** — semantic/response caches contaminated both routing (system-prompt weight dominance) and answers (cross-session bleed) while defeating the provider-side KV caching the gateway exists to maximize. The decision path may cache *decisions*, never *content* (`decision-cache.ts:4-12` states the boundary against "the response cache banned earlier").

## Decision

### 1. Layer vocabulary and cascade

`layerUsed: 'layer0' | 'layer1' | 'layer2'` (`types/router.ts:162`), reasonCode set locked beside it (`:147-153`).

- **Layer 0 = never consult a model.** Explicit choices are decisions: `router_options.force_tier`, auto-tier aliases (`auto-lite/plus/pro/ultra` rewrite `force_tier` before routing, `orchestrator.ts:356-363`), combo (reasonCode `combo`), and the global mode lever `routing.mode`: `cost`→lite, `quality`→pro, `smart`→cascade; a client-named model or forced tier always outranks the mode (`routingModeForceTier`, `router/index.ts:14-23`, applied `orchestrator.ts:469-477`).
- **Layer 1 = local CPU classifier.** Cascade short-circuits on confidence ≥ `classifier.localModel.confidenceThreshold` (default 0.85) only when `localModel.enabled` (`router/index.ts:116`, `layer1-classifier.ts:289,371`).
- **Layer 2 = remote judge**, only on low-confidence L1. Any judge miss (disabled, unresolvable, timeout, upstream failure) returns null → graceful L1-labelled fallback (`layer2-judge.ts:106-128`; `router/index.ts:137-183`). Routing never hard-fails because the judge failed.

### 2. Layer 1 — language-neutral features, guaranteed-cascade scaffold

Eight structural features only (`layer1-classifier.ts:66-75,192-278`): token count, turn count, has-system-prompt, code-block ratio, syntax-symbol density, has-tools-or-schema, character entropy, punctuation density. **No natural-language lexicons in any language** — the founding language-neutrality decision. Derived flags: `hasCode` (block ratio > 0.05 or ```), `hasToolsOrSchema` (tools / json_schema / json_object response_format); `hasMathOrProof` = symbol entropy > 0.7 (`router/index.ts:53`).

- Schema-protocol short-circuit BEFORE any model: tools/json_schema → `lite` @0.92 (`l1.schema_protocol`) — structured-output asks are protocol-shaped, cheap-capable by definition.
- Model kinds: `linear_softmax_classifier` (micro-tensor) or `onnx` (loaded only if `modelPath` ends `.onnx` AND `onnxruntime-node` imports; predict branch currently a stub returning plus @0.90 — `:117-133,310-326`).
- Auto-init: missing `models/layer1-classifier.json` writes the zero-weight scaffold; uniform probabilities guarantee sub-threshold confidence → deterministic cascade on fresh installs (`:53-57,95-96,110-146`).
- In-process trainer: multiclass logistic regression (softmax + L2) fed by the execution flywheel (`:451-560`).

### 3. Shipped defaults are quality-first

`localModel.enabled: false` + `layer2.enabled: false` out of the box (`config/index.ts:46-58`) ⇒ auto requests land on the documented "Default Quality-First" fallback with `plus` (`router/index.ts:166-183`, `layer1-classifier.ts:351-368`). Zero-config never silently routes cheap; enabling cascade is a conscious opt-in.

### 4. Layer 2 judge — shared executor, honesty contract, decision cache

- The judge calls a REGISTERED model over the gateway's own System One protocol (`runSystemoneDecision`; executor shared with the `/v1/systemone` surface, ADR-0008). Model: `classifier.layer2.model`, falling back to `systemone.defaultModel`; timeout `timeoutMs` default 1500 (`layer2-judge.ts:130-134,197`).
- Calibration honesty: native decision upstreams → `l2.system_one`; chat-model conversion → `l2.system_one_uncalibrated` with "(self-reported, not yet calibrated)" in the reason (`:247-252`).
- The judge is a below-request internal leg: never routed through the candidate pool, breakers, or rate-limit rejection (`decision-pipeline.ts:222-234`) — its own HTTP leg can join the OUTER trace (`purpose:'l2-judge'`, ADR-0008).
- Decision cache (decisions, never responses): key `systemone::<modelId>::sha256(state)`, state = last 4 turns' `role: content` joined, sliced to 4000 chars; in-memory LRU+TTL, defaults 500 entries / 1800s / enabled (`decision-cache.ts:30-58`, `config classifier.layer2.decisionCache.*`). Only successful decisions stored; race-winner writes (`layer2-judge.ts:283-291`). Hit marker: reason prefix `"[Decision Cache] "` + `reasonParams.cached=true` — no separate reasonCode, no header.

### 5. Dual flywheel — strict two-namespace separation

- **Execution flywheel** (`flywheel.enabled` opt-in, `flywheel.datasetPath` default `data/flywheel.jsonl`): records featureVector + decision + execution + derived label — "what actually SERVED, not what the router asked for" (`flywheel/collector.ts:144-236`). Feeds the L1 trainer and catalog validation.
- **Judge dataset sampler** (`classifier.layer2.collectEnabled`, single key, default OFF because state carries user conversation content): (state, tier, confidence, latency, model, native/converted) → fixed `data/layer2-decisions.jsonl` under the ACTIVE env root, 64 MB cap then pause + one warn per process, delete/rotate to resume, hot-applied (`flywheel/decision-capture.ts:39-132`).
- Guard rail: `collectEnabled` (dataset sampling) ≠ `requestCapture.systemone.l2DecisionEnabled` (HTTP-exchange capture, ADR-0008) — one namespace for logs, one for training data; retired keys (`capture:`, `decisionCapture`, vendor `provider/baseUrl/apiKey` judge keys) are load-stripped and never rewritten on save.

## Consequences

- Predictable zero-config quality; intelligent routing is opt-in at each layer with deterministic degradation at every miss.
- Judge cost bounded by cache reuse; content purity protected (nothing but decisions cached).
- Learning signals honest (served-not-asked) and content-gated (default-off for conversation-bearing datasets).
- Tests: `router*`, `decision-cache`, `layer1/layer2`, `flywheel*`.
