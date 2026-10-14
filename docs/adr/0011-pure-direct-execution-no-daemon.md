# ADR-0011: Pure Direct Execution — OpenCode Daemon Fully Exits the Inference Path

## Status

Accepted (phased implementation) — 2026-10-08
Related: [ADR-0002](0002-dynamic-model-discovery-via-opencode.md) (its item 4, "Keyless Proxy Delegation", is **superseded by this ADR**; the ideas in items 1–3 — dynamic discovery and price-pyramid tiering — are **retained**, only the data source changes).

## Context

The gpt-6-luna outage investigation on 2026-10-08 exposed four structural defects of delegating execution to the opencode daemon (each backed by measured evidence):

1. **The execution endpoint is lossy**: `/api/experimental/generate`, relied on by `OpenCodeProxyProvider`, flattens messages into a plain-text prompt — system/role structure, `tools` definitions and multimodal content blocks are all discarded, and there is no native streaming (the gateway post-hoc splits fake SSE). Coding clients (Claude Code / codex / opencode sub-agents) live on tool calling; this path is effectively unusable for them.
2. **The daemon is not a transparent pipe**: it is the inference component of the opencode application and adds its own material — `instructions[]` files and the agent system prompt are appended to every request; plugins register rewriting hooks such as `chat.message` / `chat.params` / `experimental.chat.system.transform` (verified present on the local machine); upstream admission is judged by "whether the caller comes from an OpenCode client" (the "free tier can only be used from within OpenCode" message is a product of this). The gateway loses control over what is actually sent to the model.
3. **Inverted egress-policy leverage**: the gateway's `/proxy` can only govern the gateway's own egress; the real outbound traffic happens in the daemon process, so when regional blocking hits, the gateway cannot intervene.
4. **Dependency and consistency overhead**: the daemon is a single point of failure (on the same day, mixed old/new processes ran concurrently producing half-old/half-new symptoms); the "manual test ≠ production call" dual-path drift directly manufactured the `ModelProtocolUnsupported` false alarm.

Key counter-evidence: the original justification for delegating to the daemon was "the protocol ground truth is hard to replicate". Measurement proved the ground truth's **data source is models.dev's `provider.npm` (with model-level overrides)**, already held by this repo's catalog; the truth is not in the daemon's execution stack (behavior) — it is in the data. **With the data, direct connection suffices; behavioral delegation is unnecessary.**

## Decision

1. **The sole inference execution path = gateway direct to provider**. `OpenCodeProxyProvider` is removed from the execution chain; the daemon (`/api/provider`, `/api/model`) is demoted to an optional catalog helper source (the catalog `'service'` source), never entering the request path.
2. **Direct credential reads**: `~/.config/opencode/opencode.jsonc` provider nodes + `~/.local/share/opencode/auth.json` — the same source and same files as the daemon, no second copy is made, preserving ADR-0002's "credentials never proliferate" advantage (this read capability, `user-config.ts`, already exists and so far served only the console).
3. **Data-driven wire dispatch**: resolve wire ∈ { openai, anthropic, responses, google } from `model-level provider.npm > config node npm > catalog builtin npm`, sharing **one and the same decision function** with `probeKindFor` — drift between testing and execution becomes structurally impossible. Attached rule `baseForWire()`: models.dev publishes only one `api` per provider (usually the OpenAI-compatible mount), while Anthropic wires commonly live on sibling mounts (measured on Zen: `/zen/v1/messages` 404 but `/inference/anthropic/v1/messages` 200) — boot and probe convert in sync; `anthropicMessagesUrl()` eliminates `/v1/v1` double suffixes (the claude-sonnet-5-5 incident, 2026-10-08). Console test-route model selection: a provider-level probe (no explicit `modelId`) builds up to 3 text-capable candidates (enabled config defs → catalog order) and rotates only on a MODEL-SCOPED rejection — the upstream answered with a structured 404 (Ark `ModelNotOpen`/`UnsupportedModel`) or a 400 protocol/url mismatch — so one green proves the provider is alive even when the catalog head model is not opened on the account; connection-scoped failures (auth, network, gateway 404) never rotate, and an explicit `modelId` is never substituted.
4. **Add `ResponsesProvider`** (OpenAI Responses API wire: `POST {base}/responses`).
5. **Wires that plain fetch cannot cover** (`@ai-sdk/google-vertex/*` rawPredict, bedrock SigV4, etc.): the model is **explicitly marked unroutable** in the registry — visible in the console, returning a clear error. Guessing a wrong wire onto the line and then blaming upstream 400s is banned.
6. **OAuth providers (github-copilot etc.)**: P2 implements the token-refresh lifecycle in the gateway; until done they are explicitly excluded from the routing pool and visibly so — no implicit reliance on daemon delegation.

## Implementation Phases

| Phase | Content | Completion criterion |
| :--- | :--- | :--- |
| P1 | Direct dispatch: at boot the model pool is built by `catalogRepository` (models.dev + config definitions, both already existing) instead of the daemon's `syncToTierModels`; the registry picks the executor by model-level npm; add ResponsesProvider; probe and executor share the npm→wire decision | With no daemon process, all pure API-key provider inference works; Test and inference produce byte-identical errors |
| P2 | OAuth refresh (github-copilot first — the primary local supply) | copilot models routable directly |
| P3 | `/v1/messages` ⇄ OpenAI bridge completes tools / tool_result / images / native streaming pass-through | Claude Code mounted on the gateway can finish one real tool-calling round |
| Each phase | Integration tests run in a clean worktree without config.yaml (local apiKeys cause fake 401 failures) | typecheck + tests fully green |

## Risks / Boundaries

- Credentials move from "daemon-held" to "held in the gateway process memory": this is a single-user local tool, the same auth.json file, so the leak surface does not grow; the gateway still never writes keys into its own config or responses.
- Model-pool freshness now depends on the models.dev 24h cache + manual definitions in opencode.jsonc (no daemon real-time sync) — slightly less dynamic than under ADR-0002, compensated by the console "Sync" button.
- During P1–P2, supplies with OAuth/special wires are unavailable — an **explicit exclusion** (observable), never silent degradation: better to route less than to route falsely.
- Upper-layer mechanisms — the ADR-0010 decision cache, ADR-0008/0009 breaker/retry — are unaffected (they sit after the registry).

## Consequences

- Gateway behavior is decided entirely by this repo's code + models.dev data: upgrading opencode plugins/instructions no longer changes model output routed through the gateway (the definition of "pure").
- `/proxy` takes effect on the full-chain egress for the first time.
- Bugs of the "manual test vs production call" kind are structurally eradicated (one decision function, one execution stack).
- The console can later gain a "direct / unroutable" pool status column, delivering the visibility promised by decision items 5 and 6.
