# OneCastRouter (OCR)

<div align="center">

**Production-ready intelligent cascading router & FinOps gateway for [OpenCode](https://opencode.ai).**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-green.svg)](https://platform.openai.com/docs/api-reference)
[![FinOps](https://img.shields.io/badge/Cost%20Optimization-70%25%20~%2090%25-orange.svg)]()

**[Quick Start](#quick-start)** · **[Client Integrations](#client-integrations)** · **[Features](#features)** · **[Developer Guide](DEVELOPMENT.md)** · **[Chinese Version](README.zh-CN.md)**

</div>

---

## What is OneCastRouter (OCR)?

**OneCastRouter (OCR)** is a high-performance, local-first LLM API cascading router and FinOps orchestration gateway. It connects seamlessly to your local **OpenCode v2** daemon, enabling keyless upstream proxying with zero API key exposure across clients.

By combining **hierarchical 3-layer model-driven routing**, **monotonic session ratcheting**, **upstream KV prompt cache protection**, and **local schema static assertions**, OneCastRouter (OCR) reduces LLM API expenditures by **70% to 90%** with zero degradation in conversational intellect.

---

## Features

- **💸 70% ~ 90% Cost Reduction**: Trivial prompts and structured extractions execute instantaneously on lite micro-models; complex engineering queries automatically escalate to plus-tier models.
- **⚡ Keyless Upstream Proxying**: Integrates natively with your local OpenCode v2 daemon, synchronizing 90+ active models, credentials, and token pricing with zero configuration.
- **🔒 Multi-Turn Monotonic Session Ratchet**: Once a conversation escalates to a plus/pro/ultra model, mid-dialogue downgrades are strictly blocked, preventing cognitive degradation.
- **🛡️ Industrial-Grade Circuit Breaker & Failover**: Upstream error taxonomy (402 quota exhaustion hard-trip for 12h, 5xx outages exponential backoff up to 5h, 429 adaptive backoff), transparent same-tier candidate failover, and session-pin eviction.
- **🚀 Cost-Aware Two-Tier Retry & KV Cache Shield (ADR-0005)**: In-place jittered retry on transient 5xx blips preserves 100% of upstream KV cache and prevents 10x cost explosion; same-tier exhaustion, controlled upward escalation, and strict anti-downgrade.
- **💾 Upstream KV Cache Protection**: Multi-turn sessions are pinned to the exact physical model instance, preserving 80%~95% of upstream Provider KV Prompt Cache (Anthropic, DeepSeek, OpenAI).
- **🎯 Zero-Header Prefix-Chain Fingerprinting**: Tracks dialogue turns automatically using SHA-256 Prefix-Chain Hashing without requiring custom client headers.
- **🛡️ Local Schema Assertion & Silent Fallback**: Lightweight models lead structured tasks; if JSON parsing or schema validation fails, the query silently escalates to a plus-tier model with error context.
- **🔌 100% OpenAI Protocol Compatible**: Drop-in proxy replacement for Cursor, VS Code, Chatbox, NextChat, LobeChat, LangChain, and all standard OpenAI SDKs.

---

## Quick Start

### 1. Requirements
* **OpenCode v2** — required. OCR targets opencode v2 (provider config in the `providers` node, credentials in `opencode.db` + its HTTP service). **opencode v1 is not supported**: on a v1 install OCR keeps working but degrades — providers and keys are managed in OCR's own store (`~/.onecast-router/credentials.json`), which opencode v1 cannot read, so they serve OCR's gateway only. The console badges this with an explicit warning. Upgrade opencode to v2 to share one credential truth.
* **Bun** (Recommended for peak performance): `>= 1.0`, or **Node.js**: `>= 18`.

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/kenlin8827/onecast-router.git
cd onecast-router

# Using Bun (Recommended)
bun install

# Or using npm
npm install
```

### 3. Configuration
Each environment owns its own configuration — the default one lives at `~/.onecast-router/envs/default/config.yaml`. The first boot creates it automatically from a self-documenting template; to start from the annotated example instead, copy it there:
```bash
mkdir -p ~/.onecast-router/envs/default
cp config.example.yaml ~/.onecast-router/envs/default/config.yaml
```
> 💡 **Tip**: Upstream models and credentials are automatically discovered from OpenCode. `config.yaml` works out of the box with zero manual API keys required!

> 📦 **Environments**: keep separate book-sets (config, keys, sessions, captures) under `~/.onecast-router/envs/<name>/` — `ocr env create <name>` / `ocr env use <name>`, or the console `/environments` page. Switching restarts the gateway.

> ⚙️ **Bootstrap levers**: `OCR_ENV` (which environment boots) and `OCR_HOME` (state root, default `~/.onecast-router`) are read from the **process environment only** — OCR has no `.env` file loader. To run a scratch instance: `OCR_HOME=/tmp/ocr-scratch bun run ocr start`. Selecting the environment day-to-day is `ocr env use <name>` (or the console page), which writes `~/.onecast-router/envs/current`.

### 4. Start the Gateway
```bash
# Using Bun (development or production, with hot-reloading)
bun run dev:bun

# Or using Node.js
npm run dev
```
The gateway listens on `http://127.0.0.1:3000` by default.

### 5. Health Check Verification
Verify connectivity and synchronized models:
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

OneCastRouter (OCR) is fully compatible with OpenAI API standards. Simply point your client's **API Base URL** to this gateway.

### 1. Cursor IDE
1. Open Cursor Settings: `Settings` -> `Models`.
2. Enable `OpenAI API Key` and enter any placeholder string (e.g., `sk-ocr`).
3. Expand `Override OpenAI Base URL` and enter:
   ```
   http://127.0.0.1:3000/v1
   ```
4. In the model selector, add and select the virtual model: `auto`.

### 2. Chatbox / NextChat / LobeChat
1. **API URL / Base URL**: `http://127.0.0.1:3000` (or `http://127.0.0.1:3000/v1`).
2. **API Key**: Any arbitrary string (or your `adminApiKey` if configured in `config.yaml`).
3. **Model**: Select or enter `auto`.

### 3. Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="sk-ocr"  # Any placeholder string
)

response = client.chat.completions.create(
    model="auto",  # Recommended 4-step cascading router
    messages=[
        {"role": "user", "content": "Write a generic TypeScript debounce function with unit tests."}
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
  const completion = await openai.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'Explain the principles of quantum computing.' }],
    stream: true,
  });

  for await (const chunk of completion) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

### 5. cURL CLI Direct Call
```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Which is greater, 9.11 or 9.8? Explain briefly."}
    ]
  }'
```

---

## Available Virtual Models

In addition to exposing all registered upstream physical models, OneCastRouter (OCR) provides virtual cascading models:

| Model ID | Purpose & Behavior | Cost Profile |
| :--- | :--- | :--- |
| **`auto`** <br>*(Recommended Default)* | **Intelligent 4-Step Cascading Router**: Analyzes complexity, schemas, and session ratchets to dispatch the optimal model dynamically. | 70% ~ 90% Savings |
| **`auto-lite`** | **Forced Low-Cost Tier**: Micro-models optimized for quick information extraction, greetings, and basic translations. | ~$0.10 ~ $0.50 / M Tokens |
| **`auto-plus`** | **Forced Plus Workhorse**: General workhorse models for architecture design, refactoring, and code generation. | ~$2.00 ~ $3.00 / M Tokens |
| **`auto-pro`** | **Forced Pro Reasoning Specialist**: Deep thinking models for mathematical proofs, complex algorithms, and long-horizon agents. | ~$3.00 ~ $8.00 / M Tokens |
| **`auto-ultra`** | **Forced Ultra Frontier Tier**: Above-frontier models for hour-long autonomous agent tasks and the hardest thinking workloads. | ≥ $8.00 / M Tokens |
| *Upstream Models* | Direct pass-through to any physical model (e.g., `kimi-k2.7-code`, `deepseek-chat`). | Upstream standard rates |
| *Custom Combos* | **User-composed virtual models** (`config.combos`): call the combo id as `model` — the gateway picks the leader via the configured strategy (priority / weighted / round_robin) and fails over strictly within the configured members. Each member keeps its own circuit breaker & retry semantics; no session ratchet, no cross-combo escalation. | Sum of member rates |

Custom combos are defined in `config.yaml` (and editable visually on the console `/combos` page, hot-applied on save):

```yaml
combos:
  - id: my-combo            # client-visible virtual model name
    selection: weighted     # priority (config order) | weighted | round_robin
    models:
      - kimi-k2.7-code      # bare string = weight 1
      - id: deepseek-chat
        weight: 3           # weighted/round_robin share
```

---

## Observability & FinOps Metrics

### 1. Response Diagnostic Headers
Every API response includes FinOps diagnostic headers:
* `X-OCR-Trace-ID`: Unique trace identifier for the request turn (e.g. `trace_8df3e29a...`).
* `X-OCR-Tier`: Target tier utilized (`lite`, `plus`, `pro`, `ultra`).
* `X-OCR-Model`: Specific upstream model ID invoked.
* `X-OCR-Failover`: Whether upstream failover was triggered (`true` / `false`).
* `X-OCR-Failover-Attempts`: Number of model attempts before success (e.g. `2`).
* `X-OCR-Failover-Path`: Traversal path taken during failover (e.g. `primary-plus -> secondary-plus`).
* `X-OCR-Breaker-State`: Circuit breaker state of the executing model (`CLOSED`, `HALF_OPEN`).
* `X-OCR-Session-ID`: Session fingerprint hash (`sess_8df3e29a...`).
* `X-OCR-Session-Ratchet`: Whether the monotonic ratchet locked the tier (`true` / `false`).
* `X-OCR-Cost-USD`: Incurred cost for this request.
* `X-OCR-Saved-USD`: Cost saved relative to the plus-tier baseline.
* `X-OCR-Latency-MS`: End-to-end gateway execution latency.

### 2. Session State & Turn Management

#### 📋 List Active Sessions `GET /v1/sessions`
Inspect active sessions, turn counts, and pinned model instances:
```bash
curl http://127.0.0.1:3000/v1/sessions
```

#### 📌 Query Single Session Details `GET /v1/sessions/:id`
Inspect a specific session's locked tier, pinned model, total turns, and recent trace summaries:
```bash
curl http://127.0.0.1:3000/v1/sessions/sess_8df3e29a...
```

#### 📜 Query Session Trajectory `GET /v1/sessions/:id/traces`
Fetch the complete step-by-step routing and execution trajectory for a session across all turns (including decision rationale, target tier, model invoked, latency, and FinOps savings):
```bash
curl http://127.0.0.1:3000/v1/sessions/sess_8df3e29a.../traces
```

#### 🌐 Global Trajectory Log Query `GET /v1/traces`
Query recent gateway routing traces across all sessions, with support for pagination (`?limit=50&offset=0`) and session filtering (`?session_id=...`):
```bash
curl "http://127.0.0.1:3000/v1/traces?limit=20"
```

#### 🔬 Single Request Trace Lookup `GET /v1/traces/:id`
Lookup a specific execution trace using the `X-OCR-Trace-ID` returned in response headers:
```bash
curl http://127.0.0.1:3000/v1/traces/trace_8df3e29a...
```

#### 🗑️ Reset / Clear Session `DELETE /v1/sessions/:id`
Reset an active session state and its cached traces, allowing clients to cleanly restart context:
```bash
curl -X DELETE http://127.0.0.1:3000/v1/sessions/sess_8df3e29a...
```

### 3. Real-Time FinOps Metrics `GET /v1/metrics`
```bash
curl http://127.0.0.1:3000/v1/metrics
```
```json
{
  "totalRequests": 1280,
  "cacheHits": 420,
  "cacheHitRatePct": 32.8,
  "fallbackCount": 18,
  "tierDistribution": {
    "lite": { "count": 960, "pct": 75.0 },
    "plus": { "count": 270, "pct": 21.09 },
    "pro": { "count": 50, "pct": 3.91 }
  },
  "economics": {
    "actualCostUsd": 0.512,
    "baselineCostUsd": 4.620,
    "totalSavingsUsd": 4.108,
    "savingsPct": 88.92
  }
}
```

### 4. Circuit Breakers Inspection & Recovery
#### 🩺 Inspect Breaker States `GET /v1/health/circuit-breakers`
Inspect real-time health, remaining cooldowns, failure categories, and request statistics for all models:
```bash
curl http://127.0.0.1:3000/v1/health/circuit-breakers
```

#### 🔄 Admin Manual Reset `POST /v1/health/circuit-breakers/reset`
Instantly reset circuit breakers back to CLOSED health (supports `?model=...` to reset a specific model, or omitted to reset all):
```bash
curl -X POST http://127.0.0.1:3000/v1/health/circuit-breakers/reset
```

---

## FAQ

### Q1: Do I need to enter provider API keys into OneCastRouter?
**No**. OneCastRouter (OCR) connects directly to your local OpenCode v2 daemon. All credentials, active providers, and pricing tables configured in OpenCode are automatically synchronized and utilized.

### Q2: Why won't conversations become "dumber" mid-dialogue?
Standard stateless routers dispatch short follow-ups (e.g. "thanks", "fix line 3") to cheap micro-models based on short character length, causing severe hallucinations over 10k+ token histories. OneCastRouter (OCR) enforces a **Monotonic Session Ratchet**: once a dialogue reaches higher tiers (plus/pro/ultra), it locks strictly to that tier and pins to the exact same model instance, safeguarding intellect and preserving upstream KV Cache.

### Q3: What happens with zero configuration — does auto routing guess cheap?
**Never**. With the Layer 2 judge disabled (the shipped default), every auto request lands on the hardcoded **plus** quality baseline; a client-named model or `force_tier` always wins over any automatic choice. Intelligent tiering is a conscious opt-in (`classifier.layer2.enabled`).

### Q4: How does the router handle upstream outages or quota exhaustion?
**OneCastRouter (OCR) provides enterprise-grade resilience & failover (ADR-0004)**:
- **Quota / Balance Exhaustion (HTTP 402)**: Hard-trips immediately into OPEN (default 12h cooldown), bypassing the model with zero latency.
- **Service Outages (5xx / Timeouts)**: Tripped upon consecutive failures or sliding window error rates, applying exponential backoff up to 5 hours max.
- **Transparent Same-Tier Failover**: Automatically retries across candidate models within the same tier in milliseconds; the client receives a seamless 200 response.
- **Session-Pin Eviction**: A bound session is hard-switched onto a healthy landing (write-back included) when the pinned model leaves its pool — config edit, denylist, removal — or reads fully `unavailable` (model breaker open, or every credential down); cross-tier landing is allowed when the tier is empty, and with no healthy landing the session keeps serving on its pin (safe fail, retried next turn).

### Q5: Does model switching cause KV prompt cache invalidation and 10x cost explosion?
**Never**. OneCastRouter (OCR) implements a **Cost-Aware Two-Tier Retry Engine (ADR-0005)**:
- **Tier 1: In-Place Retry**: Transient 5xx / timeout glitches trigger a quick (200ms + 100ms jitter) retry on the *same model*, resolving ~70% of cloud gateway blips while **saving 100% of the warmed KV prompt cache** (preserving the 90% discount on 50k+ tokens).
- **Tier 2: Failover & Anti-Downgrade**: If in-place retry is exhausted, the router fails over across same-tier models. If all lite models fail, it permits controlled upward escalation to plus/pro/ultra; **downward downgrades from higher tiers to lite are strictly prohibited** to prevent hallucinations from polluting production code.

---

## Developer Guide & Architecture

For deep-dive documentation into the routing pipeline, unit testing suites, and Architecture Decision Records (ADRs):

* 📘 **[Developer & Architecture Guide (DEVELOPMENT.md)](DEVELOPMENT.md)**
* 🏛️ **[Architecture Decision Records (ADR)](docs/adr/README.md)** (ADR-0001 through ADR-0008)

---

## License

Released under the [MIT License](LICENSE).
