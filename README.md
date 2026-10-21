# OneCastRouter (OCR)

<div align="center">

**Production-ready intelligent cascading router & FinOps gateway for [OpenCode](https://opencode.ai) and standard LLM clients.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![FinOps](https://img.shields.io/badge/Cost%20Optimization-70%25%20~%2090%25-orange.svg)]()

**[Quick Start](#quick-start)** · **[Client Integrations](#client-integrations)** · **[Architecture & Features](#features)** · **[Developer Guide](DEVELOPMENT.md)** · **[Release Guide](RELEASING.md)** · **[Chinese Version](README.zh-CN.md)**

</div>

---

## What is OneCastRouter (OCR)?

**OneCastRouter (OCR)** is a high-performance, local-first LLM API cascading router, resilience orchestrator, and FinOps gateway. It unifies model access across disparate upstream providers (OpenAI, Anthropic, DeepSeek, Moonshot/Kimi, DashScope, Ollama, and OpenAI-compatible endpoints) into an intelligent cascading pool.

By orchestrating **rule-based fast paths**, a persistent **RouteEntry experience table**, an opt-in **System One semantic judge**, a **monotonic session ratchet**, **two-stage jittered retry with upstream KV cache protection**, and a **Token Saver** compression pipeline, OneCastRouter cuts LLM API spending by **70% to 90%** while defending reasoning quality across multi-turn developer sessions.

---

## Features

- **💸 70% ~ 90% FinOps Cost Reduction**: Short, repetitive, or structured prompts resolve instantly to high-efficiency lite models; complex coding and algorithmic reasoning escalate automatically to plus/pro/ultra workhorses.
- **⚡ Native OpenCode v2 Integration & Keyless Upstream Proxying**: Discovers 90+ models and synchronized credentials from your local OpenCode daemon or OCR credential store with zero manual configuration.
- **🧠 Experience-Driven Routing (ADR-0011)**: Persistent prompt-level memory table (`data/route-entries.json`) short-circuits expensive judge inference on recurring developer prompts.
- **🎯 System One Judge with Unified Effort Emission (ADR-0012)**: Context-aware semantic judge evaluates prompt difficulty and emits both target tier and reasoning effort (`{tier, effort}`) in a single wire call.
- **🔒 Monotonic Session Ratchet & Entry-Mode Autonomy (ADR-0002, ADR-0014)**: Mid-conversation downgrades are strictly blocked to prevent reasoning collapse. Only the `auto` family is eligible for dynamic judgment adjustments; forced tiers and explicit models are preserved verbatim.
- **📈 Retry Escalation Ladder (ADR-0011)**: Re-sending an identical prompt within an active session signals dissatisfaction and automatically climbs the ladder: attempt 1 boosts reasoning effort; attempt 2+ escalates the model tier.
- **🛡️ Two-Stage In-Place Retry & KV Cache Shield (ADR-0005)**: Jittered in-place retry on transient 5xx/timeout errors preserves 100% of upstream KV prompt cache, avoiding 10x token-cost explosions.
- **🩺 Layered Resilience & Scoped Circuit Breakers (ADR-0004)**: Seven-class error taxonomy (`quota`, `auth`, `rate_limit`, `server_error`, `timeout`, `network`, `bad_request`) with isolated trip scopes across `model`, `credential`, and `(model, credential)` pairs.
- **📊 Real-Time Failure Events Ledger (ADR-0013)**: Ring buffer and durable SQLite mirror capturing every upstream failure with 10-second storm coalescing and dedicated admin inspection UI.
- **🗜️ Token Saver Suite**: Includes deterministic tool output compression (`rtk`), neural context compression sidecar (`headroom`), and terse prompt injection (`caveman`).
- **🔍 Declarative Quota Probing (ADR-0009)**: Built-in 12-construct domain-specific language (DSL) for automated non-intrusive upstream quota monitoring.
- **🔌 Multi-Protocol Compatibility (ADR-0008)**: Drop-in proxy support for OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses API formats.

---

## Quick Start

### 1. Requirements
* **Bun** (Recommended for peak performance): `>= 1.0`, or **Node.js**: `>= 18`.
* **OpenCode v2** (Optional but recommended): Seamlessly syncs provider credentials, pricing catalogs, and active models.

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/kenlin8827/onecast-router.git
cd onecast-router

# Install dependencies using Bun
bun install

# Or using npm
npm install
```

### 3. Build & Setup
```bash
# Build backend and frontend
bun run build

# Or using npm
npm run build
```

### 4. Configuration
Each environment manages its own isolated book-set (configuration, credentials, sessions, and logs). The default environment resides at `~/.onecast-router/envs/default/config.yaml`. The gateway creates it automatically upon first boot from a self-documenting template. To inspect or customize:
```bash
mkdir -p ~/.onecast-router/envs/default
cp config.example.yaml ~/.onecast-router/envs/default/config.yaml
```

> 📦 **Environments**: Switch environments via the CLI (`bin/ocr env use <name>`) or via the web console under `/environments`. Controlled gateway restart applies changes safely.

> ⚙️ **Runtime Variables**: Set `OCR_HOME` to customize the root state directory (defaults to `~/.onecast-router`) and `OCR_ENV` to select the active environment.

### 5. Start the Gateway
```bash
# Start with Bun (recommended)
bun run start:bun

# Or start using Node.js
npm run start

# Development mode with hot reloading
bun run dev
```
The gateway listens on `http://127.0.0.1:3000` by default. Access the Web Admin Console at `http://127.0.0.1:3000/admin`.

### 6. Verify Health
```bash
curl http://127.0.0.1:3000/health
```
Example response:
```json
{
  "status": "healthy",
  "version": "0.0.1",
  "modelsCount": 94,
  "timestamp": 1727622400000
}
```

---

## Client Integrations

OneCastRouter exposes full OpenAI-compatible and Anthropic-compatible endpoints. Configure your favorite developer tools:

### 1. Cursor IDE
1. Navigate to: `Settings` -> `Models`.
2. Enable `OpenAI API Key` and input any placeholder string (e.g., `sk-ocr`).
3. Set `Override OpenAI Base URL` to:
   ```
   http://127.0.0.1:3000/v1
   ```
4. In the model selector, add and select the virtual model: `auto`.

### 2. Claude Code / OpenCode CLI / Chatbox
1. **API Base URL**: `http://127.0.0.1:3000/v1`
2. **API Key**: Any placeholder string (or your configured `adminApiKey`).
3. **Model**: `auto` (or explicit tier aliases like `auto-plus`).

### 3. Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-ocr"
)

response = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "Explain the difference between optimistic and pessimistic locking with code snippets."}
    ]
)

print(response.choices[0].message.content)
```

### 4. Node.js / TypeScript SDK
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-ocr',
});

async function main() {
  const stream = await openai.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'Generate a Fastify route plugin with schema validation.' }],
    stream: true,
  });

  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

---

## Model Addressing & Virtual Tiers

Clients can request models through four distinct addressing modalities (ADR-0003, ADR-0014):

| Model Reference | Type | Routing Behavior & FinOps Profile |
| :--- | :--- | :--- |
| **`auto`** / **`default`** | Dynamic Cascading Model | **Full Cascaded Pipeline**: Evaluates traits, consults the RouteEntry table, optionally calls the System One judge, and respects the session ratchet. Yields 70%~90% cost savings. |
| **`auto-lite`** | Forced Virtual Tier | Serves exclusively from the `lite` model pool (~$0.10 ~ $0.50 / M tokens). Governed by explicit contract: no dynamic escalation. |
| **`auto-plus`** | Forced Virtual Tier | Serves exclusively from the `plus` workhorse pool (~$2.00 ~ $3.00 / M tokens). Default general-purpose engineering baseline. |
| **`auto-pro`** | Forced Virtual Tier | Serves exclusively from the `pro` reasoning specialist pool (~$3.00 ~ $8.00 / M tokens) for deep mathematical proofs and complex refactors. |
| **`auto-ultra`** | Forced Virtual Tier | Serves from the `ultra` frontier tier (≥ $8.00 / M tokens) for large-scale multi-file codebases and complex autonomous agent loops. |
| *Custom Combos* | Virtual Model Sets | Composed model groups with configured selection strategies (`priority`, `weighted`, `round_robin`). Fails over strictly within combo members. |
| *Direct Physical Models* | Direct Passthrough | Any registered upstream physical identifier (e.g. `deepseek-chat`, `claude-3-7-sonnet-20250219`). Bypasses tier arbitration. |

---

## Cascaded Routing Architecture

The arbitration pipeline executes in four disciplined steps:

```
                      Client Request (Chat Completions / Anthropic Messages / Responses)
                                                    │
                                                    ▼
                     [Step 1: Inbound Trait Parsing & Session Fingerprinting]
                      - Zero-header session identification via SHA-256 Prefix-Chain
                      - Normalization and byte-order preservation for KV Cache affinity
                                                    │
                                                    ▼
                     [Step 2: Cascaded Tier & Effort Decision Pipeline]
             ┌───────────────────────────────────────────────────────────────┐
             │ Layer 0: Explicit Rules & Inbound Overrides                  │
             │  - Client force_tier / combo / auto-tier alias / mode lever   │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (no explicit override)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ RouteEntry Experience Table (ADR-0011)                        │
             │  - SHA-256 prompt hash hit short-circuits judge inference     │
             │  - Precedence: human > retry correction > confident judge     │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (cache / table miss)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ Layer 2: System One Semantic Judge (ADR-0012, Opt-In)        │
             │  - Context-aware intent evaluation                            │
             │  - Emits {tier, effort} in a single remote call               │
             └───────────────────────────────┬───────────────────────────────┘
                                             │ (judge disabled / miss / timeout)
                                             ▼
             ┌───────────────────────────────────────────────────────────────┐
             │ Baseline Default: Hardcoded 'plus' Tier (Quality Defense)     │
             └───────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                     [Step 3: Multi-Turn Monotonic Session Ratchet (ADR-0002)]
                      - Escalate-only policy: mid-session downgrades strictly blocked
                      - Pinned physical model instance protects upstream KV prompt cache
                                                    │
                                                    ▼
                     [Step 4: Direct Pool Execution & Resilient Failover (ADR-0005)]
                      - In-place jittered retry on transient 5xx/timeout errors
                      - In-tier candidate failover and controlled upward escalation
                      - Ring buffer and SQLite failure-events ledger logging
```

---

## Observability & FinOps Diagnostics

### 1. HTTP Response Headers
Every proxied response carries diagnostic metadata:
* `X-OCR-Trace-ID`: Unique per-turn execution trace identifier.
* `X-OCR-Tier`: Executed model tier (`lite`, `plus`, `pro`, `ultra`).
* `X-OCR-Model`: Exact physical model invoked upstream.
* `X-OCR-Thinking-Effort`: Applied reasoning budget (`low`, `medium`, `high`, `max`).
* `X-OCR-Thinking-Source`: Origin of the reasoning effort decision (`client`, `judge`, `entry`, `escalation`, `default`).
* `X-OCR-Failover`: Whether upstream failover occurred (`true` / `false`).
* `X-OCR-Failover-Attempts`: Number of candidate attempts before success.
* `X-OCR-Breaker-State`: Health state of the invoked candidate (`CLOSED`, `HALF_OPEN`).
* `X-OCR-Session-ID`: Resolved zero-header session identifier.
* `X-OCR-Session-Ratchet`: Whether the monotonic ratchet locked the tier (`true` / `false`).
* `X-OCR-Cost-USD`: Calculated cost for the execution turn.
* `X-OCR-Saved-USD`: Net savings compared to the baseline tier.
* `X-OCR-Latency-MS`: Gateway execution latency in milliseconds.

### 2. Core Administration Endpoints

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/admin/status` | `GET` | Comprehensive gateway status: circuit breakers, active models, metrics, and environment info. |
| `/api/admin/usage` | `GET` | Aggregated token usage and per-API-key consumption breakdowns. |
| `/api/admin/quota` | `GET` | Live quota tracking plan, active pair snapshots, and quota events ledger. |
| `/api/admin/quota/refresh` | `POST` | Invalidates pair quota cache and triggers immediate re-probing. |
| `/api/admin/route-entries` | `GET` | Paginated listing of the persistent RouteEntry experience table. |
| `/api/admin/route-entries/:hash` | `PATCH` | Manually overrides tier and reasoning effort for a specific prompt hash. |
| `/api/admin/route-entries/:hash` | `DELETE` | Removes an entry from the experience table. |
| `/api/admin/failure-events` | `GET` | Queries upstream model call failure events with optional filters. |
| `/api/admin/failure-events/clear` | `POST` | Clears in-memory ring and durable SQLite failure events ledger. |
| `/api/admin/health/circuit-breakers/reset` | `POST` | Manually resets tripped circuit breakers across `model`, `credential`, or `pair` scopes. |
| `/v1/sessions` | `GET` | Lists active multi-turn sessions, pinned models, and turn counts. |
| `/v1/traces` | `GET` | Paginated query of recent request execution traces. |
| `/v1/metrics` | `GET` | Real-time FinOps metrics, tier distribution, and cumulative cost savings. |

---

## Frequently Asked Questions

### Q1: Does OneCastRouter require duplicating API keys across configs?
**No**. OneCastRouter treats `<ocrHome>/custom-providers.json` and `credentials.json` as the single source of truth and synchronizes bidirectionally with local OpenCode v2 credentials. Downstream clients simply authenticate with any arbitrary bearer token or configured admin API key.

### Q2: Why will multi-turn conversations never degrade in intellect?
Traditional routers frequently route short replies (such as *"yes"*, *"fix line 12"*, or *"looks good"*) to low-cost micro models, corrupting conversational context across 20k+ token histories. OneCastRouter enforces a **Monotonic Session Ratchet**: once a dialogue reaches an advanced tier (`plus`, `pro`, or `ultra`), it locks strictly to that tier and pins to the identical physical model instance.

### Q3: How does the gateway protect upstream KV prompt caching?
Changing models across conversational turns invalidates upstream prefix caches and causes sudden 10x token billing spikes. OneCastRouter pins sessions to exact physical model instances and applies **In-Place Jittered Retry**: transient 5xx or timeout glitches retry immediately on the same upstream instance, preserving warmed prompt caches before attempting same-tier failovers.

### Q4: What happens if an upstream model fails or runs out of credits?
OneCastRouter classifies errors into a 7-class taxonomy:
- **HTTP 402 (Quota Exhaustion)**: Hard-trips the credential or pair breaker for 12 hours, immediately bypassing the failed target without latency overhead.
- **HTTP 5xx / Timeouts**: Triggers exponential cooldowns and automatically reroutes to healthy same-tier candidates in milliseconds.
- **HTTP 429 (Rate Limits)**: Applies adaptive backoff based on upstream `Retry-After` headers.
- **Observability**: Every failed upstream call is recorded in the `failure-events` ledger and surfaced on the web console.

---

## License

Released under the [MIT License](LICENSE).
