# ADR-0001: Routing Pipeline — Cascaded Tier Decision, Decision Layer with Decision Cache

## Status

Implemented — 2026-10-21 (Layer 1 micro-classifier and the learning flywheel removed; facts-side corpus rewrite). Scope: how an auto request picks a tier, how the expensive leg is made cheap, how the decision layer's decisions are sampled. Request-`model` name resolution = ADR-0003; conversation policy = ADR-0002; the decision layer's protocol surface = ADR-0008.

## Context

Auto routing must choose `lite|plus|pro|ultra` per turn — cheap, deterministic in its fallbacks, and never thrashing a conversation (the session ratchet rides this decision, ADR-0002). The founding boundary of this repo: **response caching of any kind is banned** — semantic/response caches contaminated both routing (system-prompt weight dominance) and answers (cross-session bleed) while defeating the provider-side KV caching the gateway exists to maximize. The decision path may cache *decisions*, never *content* (`decision-cache.ts:4-12` states the boundary against "the response cache banned earlier").

The retired Layer 1 (a local micro-tensor classifier trained by the learning flywheel) never earned its keep: with the shipped base scaffold its confidence stayed below threshold on every request, so every decision already cascaded — the layer added a trainer, a dataset pipeline and a console page while contributing zero routing outcomes. It is deleted, not deprecated: the cascade is now L0 rules → L2 decision layer → hardcoded plus baseline.

## Decision

### 1. Layer vocabulary and cascade

`layerUsed: 'layer0' | 'entry' | 'layer2'` (`types/router.ts`), reasonCode set locked beside it (`forced`, `default`, `combo`, `entry.hit`, `l2.*`, `session.*`; `retry.*` attribution rides reasonParams — ADR-0011).

- **Layer 0 = never consult a model.** Explicit choices are decisions: `router_options.force_tier`, auto-tier aliases (`lite/plus/pro/ultra` rewrite `force_tier` before routing), combo (reasonCode `combo`), and the global mode lever `routing.mode`: `cost`→lite, `quality`→pro, `smart`→cascade; a client-named model or forced tier always outranks the mode (`routingModeForceTier`, `router/index.ts`).
- **Experience lookup = the persistent prior.** Before consulting the decision layer, an auto request checks the RouteEntry table (ADR-0011): a hit short-circuits L2 with `layerUsed: 'entry'`.
- **Layer 2 = remote decision layer.** Any decision layer miss (disabled, unresolvable, timeout, upstream failure) returns null → graceful fallback (`layer2-decision.ts`). Routing never hard-fails because the decision layer failed.
- **Default = plus baseline.** With no decision layer decision the cascade ends at a hardcoded `plus` with reasonCode `default` and `layerUsed: 'layer0'` (`router/index.ts`) — never a guess at lite.

### 2. Structured-output gate (survives Layer 1)

`needsSchemaValidation = hasToolsOrSchema(request)` — a direct payload read (tools list / `json_schema` / `json_object` response_format), computed in `router/request-traits.ts` and carried on every `RoutingDecision`. It arms the orchestrator's lite-first schema-assertion cascade (5A) regardless of the decided tier. No learned features remain anywhere in the routing path.

### 3. Shipped defaults are quality-first

`layer2.enabled: false` out of the box ⇒ auto requests land on the documented plus baseline. Zero-config never silently routes cheap; enabling the decision layer is a conscious opt-in.

### 4. Layer 2 decision layer — shared executor, honesty contract, decision cache

- The decision layer calls a REGISTERED model over the gateway's own System One protocol (`runSystemoneDecision`; executor shared with the `/v1/systemone` surface, ADR-0008). Model: `classifier.layer2.model`, falling back to `systemone.defaultModel`; timeout `timeoutMs` default 5000.
- Calibration honesty: native decision upstreams → `l2.system_one`; chat-model conversion → `l2.system_one_uncalibrated` with an explicit "(uncalibrated)" caveat in the reason.
- Explicit-model honesty: naming a registered model (full id / variant / bare name) never renders as a tier decision — the resolver's injected `force_tier` is rewritten to `explicit.model` ("routed to the named model, no tier judgment"), so the console never badges a tier inferred from the registration table.
- The decision layer is a below-request internal leg: never routed through the candidate pool, breakers, or rate-limit rejection — its own HTTP leg can join the OUTER trace (`purpose:'l2-decision'`, ADR-0008).
- Decision cache (decisions, never responses): key `systemone::<modelId>::sha256(state)`, state = last 4 turns' `role: content` joined, sliced to 4000 chars; in-memory LRU+TTL, defaults 500 entries / 1800s / enabled (`decision-cache.ts`, config `classifier.layer2.decisionCache.*`). Only successful decisions stored; race-winner writes. Hit marker: reason prefix `"[Decision Cache] "` + `reasonParams.cached=true` — no separate reasonCode, no header.

### 5. L2 decision dataset sampler (the surviving capture leg)

- (`classifier.layer2.collectEnabled`, single key, default OFF because state carries user conversation content): (state, tier, confidence, latency, model, native/converted) → fixed `data/layer2-decisions.jsonl` under the ACTIVE env root, 64 MB cap then pause + one warn per process, delete/rotate to resume, hot-applied (`capture/decision-capture.ts`).
- Guard rail: `collectEnabled` (dataset sampling) ≠ the requestCapture HTTP-exchange audit log (ADR-0008) — one namespace for logs, one for training data; retired keys (`capture:`, `decisionCapture`, `flywheel:`, `classifier.localModel`, the `requestCapture.systemone` two-gate subtree, vendor `provider/baseUrl/apiKey` decision layer keys) are load-stripped and never rewritten on save.

## Consequences

- Predictable zero-config quality; intelligent routing is opt-in with deterministic degradation at every miss.
- Decision cost bounded by cache reuse; content purity protected (nothing but decisions cached).
- The retired flywheel's on-disk leftovers (`data/flywheel.jsonl`, `models/layer1-classifier.json`) are inert — nothing reads them; delete at leisure.
- Tests: `router*`, `decision-cache`, `layer2-systemone`, `decision-capture`.
