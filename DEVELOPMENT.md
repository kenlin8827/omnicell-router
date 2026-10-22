# OneCastRouter (OCR) Developer & Architecture Guide

<div align="center">

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Cascaded%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Backend%20Suites-121%20Suites%20Pass-brightgreen.svg)]()
[![ADR](https://img.shields.io/badge/ADR-0001%20through%200014-blue.svg)](docs/adr/README.md)

[English Version](DEVELOPMENT.md) | [Chinese Version](DEVELOPMENT.zh-CN.md) | [User README](README.md) | [Release Guide](RELEASING.md)

</div>

> This guide documents the technical architecture, internal subsystems, routing cascades, test suites, and coding conventions of **OneCastRouter (OCR)**. It reflects current code reality on `main` and Architecture Decision Records (ADR-0001 through ADR-0014).

---

## Table of Contents
1. [Monorepo Structure & Core Subsystems](#1-monorepo-structure--core-subsystems)
2. [Global Execution Pipeline](#2-global-execution-pipeline)
3. [Cascaded Arbitration Engine](#3-cascaded-arbitration-engine)
4. [Session State Machine & Entry-Mode Autonomy](#4-session-state-machine--entry-mode-autonomy)
5. [Resilience & Scoped Circuit Breakers](#5-resilience--scoped-circuit-breakers)
6. [Failure Events Ledger & Observability](#6-failure-events-ledger--observability)
7. [Token Saver Compression Suite](#7-token-saver-compression-suite)
8. [Credential Store & Provider Defs Truth](#8-credential-store--provider-defs-truth)
9. [Declarative Quota Probing Engine](#9-declarative-quota-probing-engine)
10. [Architecture Decision Records (ADR-0001 to ADR-0014)](#10-architecture-decision-records-adr-0001-to-adr-0014)
11. [Testing Matrix & Verification](#11-testing-matrix--verification)
12. [Coding Conventions & Cleanup Rules](#12-coding-conventions--cleanup-rules)

---

## 1. Monorepo Structure & Core Subsystems

OneCastRouter is organized as a Bun monorepo comprising a Fastify backend and a Vite+React frontend:

```
onecast-router/
├── backend/                             # Core gateway daemon (Fastify + Pino)
│   ├── src/
│   │   ├── auth/                        # Admin API keys, web sessions, model access policies
│   │   ├── capture/                     # HTTP exchange recording & System One dataset capture
│   │   ├── cli/                         # CLI entry points, subcommands, client synchronizers
│   │   ├── compression/                 # Token Saver (rtk, headroom sidecar, caveman prompts)
│   │   ├── config/                      # YAML config schema, env loader, hot-reloading
│   │   ├── forward-proxy/               # Inbound MITM proxy engine & dynamic CA certificate
│   │   ├── metrics/                     # FinOps cost calculations, token accounting
│   │   ├── observability/               # Failure events ring buffer & SQLite ledger (ADR-0013)
│   │   ├── opencode/                    # Provider definitions, catalog sync, credential adapters
│   │   ├── pipeline/                    # Orchestrator, prompt normalization, KV cache shield
│   │   ├── protocols/                   # Wire adapters for Anthropic, OpenAI, Responses
│   │   ├── providers/                   # Direct execution engine, candidate pools, member matching
│   │   ├── quota/                       # Declarative DSL prober, SQLite quota_events ledger
│   │   ├── ratelimit/                   # Sliding window rate limiter & client event log
│   │   ├── resilience/                  # Circuit breakers, scoped trip state, health views
│   │   ├── router/                      # Route entries (ADR-0011), retry escalation, judge
│   │   ├── routes/                      # Fastify HTTP route definitions (console, envs, surfaces)
│   │   ├── session/                     # Monotonic ratchet state machine, zero-header hashing
│   │   ├── surfaces/                    # Protocol surface table & dispatch layer (ADR-0008)
│   │   ├── trace/                       # SQLite trace store (traces.db) & in-memory ring
│   │   ├── validator/                   # Local AST & JSON schema assertion fallback
│   │   ├── index.ts                     # Application bootstrap & lifecycle management
│   │   └── server.ts                    # Fastify HTTP server & admin API registrations
│   └── tests/                           # 121 isolated backend test suites
├── frontend/                            # Web Administration Console (Vite + React + Vanilla CSS)
│   └── src/
│       ├── components/                  # UI components (Combobox, tables, modal dialogs)
│       ├── pages/                       # Console views (Combos, Failures, RouteEntries, etc.)
│       ├── lib/                         # API client mirroring backend wire types 1:1
│       └── i18n/                        # Localization (English and zh-CN translation tables)
├── docs/                                # Project documentation
│   └── adr/                             # Canonical Architecture Decision Records (ADR-0001..0014)
│       └── zh-CN/                       # Bilingual Chinese ADR mirrors
└── scripts/                             # Utility & test automation runners
    ├── test-isolated.ts                 # Multi-process sandbox test runner
    ├── check-guardrails-matrix.ts       # CI guardrails validation script
    └── full-system-test.ts              # End-to-end integration test runner
```

---

## 2. Global Execution Pipeline

All inbound traffic is intercepted by the Fastify server, normalized into an internal protocol representation, arbitrated through the cascade, and dispatched via direct candidate pool execution:

```
                           Inbound Client Request
   (POST /v1/chat/completions | POST /v1/messages | POST /v1/responses)
                                      │
                                      ▼
               [Step 1: Surface Detection & Dispatch (ADR-0008)]
                - Protocol Surface registry matches path suffix
                - Dispatches to surface-specific stream/non-stream handler
                                      │
                                      ▼
               [Step 2: Canonical Normalization & Session ID (ADR-0002)]
                - Computes SHA-256 Prefix-Chain Hash over message history
                - Preserves exact byte ordering to optimize upstream KV cache
                                      │
                                      ▼
               [Step 3: Cascaded Tier & Effort Decision (ADR-0001, ADR-0011, ADR-0012)]
                - Layer 0: Explicit rules (force_tier, combos, auto-tier aliases)
                - RouteEntry Experience Table: SHA-256 prompt hash short-circuit
                - Layer 2 Judge: Remote System One emits {tier, effort} (opt-in)
                - Fallback: Hardcoded 'plus' baseline defense
                                      │
                                      ▼
               [Step 4: Monotonic Session Ratchet & Entry Mode (ADR-0002, ADR-0014)]
                - Prevents mid-dialogue tier downgrades ("escalate-only")
                - Enforces entry-mode constraints: only 'auto' moves dynamically
                - Verifies pinned model health; executes guarded pin eviction if needed
                                      │
                                      ▼
               [Step 5: Direct Pool Execution & Resilient Retry (ADR-0004, ADR-0005)]
                - Gathers candidate models for the target tier from active registry
                - Stage 1: In-place jittered retry on transient 5xx/timeout blips
                - Stage 2: In-tier failover and controlled upward escalation
                - Scoped breaker updates & failure-events ledger emission (ADR-0013)
                                      │
                                      ▼
               [Step 6: Diagnostic Headers & Stream Delivery]
                - Injects X-OCR-Trace-ID, X-OCR-Tier, X-OCR-Thinking-Source headers
                - SSE re-chunking and client delivery
```

---

## 3. Cascaded Arbitration Engine

The decision cascade eliminates crude prompt-length heuristics and replaces them with deterministic layers:

### 3.1 Layer 0: Explicit Rules & Fast Paths
1. **Direct Combo**: If `request.model` names a configured combo (ADR-0003), tier arbitration is bypassed. The combo pool selects a member using its configured strategy (`priority`, `weighted`, `round_robin`) and confines failover strictly within its members.
2. **Auto-Tier Aliases**: Models named `lite`, `plus`, `pro`, or `ultra` force the target tier directly and lock the session to an `'explicit'` mode contract.
3. **Client Options**: `router_options.force_tier` explicitly overrides automatic tiering.
4. **Global Mode Lever**: `routing.mode: cost` routes to `lite`; `routing.mode: quality` routes to `pro`.

### 3.2 RouteEntry Experience Table (ADR-0011)
Before consulting a remote judge, the gateway computes the 16-character hex hash:
$$\mathcal{H}_{\text{prompt}} = \text{SHA256}(\text{normalize}(\text{prompt}))[0 \dots 15]$$
- If an entry exists in `<envRoot>/data/route-entries.json`, the gateway short-circuits Layer 2, setting `layerUsed: 'entry'` and `reasonCode: 'entry.hit'`.
- **Write Whitelist Precedence**: `human` (manual operator edits via console) > `correction` (accepted retry escalation outcomes) > `l2_confident` (System One judge confidence $\ge 0.85$).
- Human entries are immutable to automated overwrite.

### 3.3 Layer 2: System One Semantic Judge (ADR-0012)
- Opt-in via `classifier.layer2.enabled: true` (shipped default is false).
- Invokes a dedicated lightweight model (`classifier.layer2.model`) via `runSystemoneDecision`.
- When enabled, the judge resolves both `{tier, effort}` in a single round-trip.
- Decisions are cached in an in-memory LRU+TTL store (`decisionCache`) keyed by prefix and prompt content.

### 3.4 Quality-First Baseline
When the judge is disabled, times out, or fails to classify, the request immediately defaults to the hardcoded `plus` tier (`layerUsed: 'layer0'`, `reasonCode: 'default'`). The gateway never silently routes to cheap micro-models without explicit intent.

### 3.5 Retry Escalation Ladder (ADR-0011)
If an identical prompt ($\ge 20$ characters) is re-sent within the same active session following a successful completion, the gateway interprets this as operator dissatisfaction and applies the escalation ladder:
- **Attempt 1**: Reasoning effort $+1$ (`low` $\to$ `medium` $\to$ `high` $\to$ `max`). If the model already operates at max effort or does not support reasoning effort, it executes an immediate capability jump to $\text{tier} + 1$.
- **Attempt 2+**: Tier $+1$ (`lite` $\to$ `plus` $\to$ `pro` $\to$ `ultra`). Capped at `ultra`.
- Every escalation event is appended to `<envRoot>/data/routing-ledger.jsonl`.

---

## 4. Session State Machine & Entry-Mode Autonomy

### 4.1 Zero-Header Prefix-Chain Fingerprinting
Standard LLM clients do not transmit dedicated session headers. OCR derives session identity via prefix-chain hashing:
$$\mathcal{H}_{\text{session}} = \text{SHA256}(\text{CanonicalJSON}(\text{messages}[0 \dots n-2]))$$
Because $messages[0 \dots n-2]$ encapsulates the prior assistant turn $A_{n-1}$, cryptographic collision probability across concurrent requests is virtually zero.

### 4.2 Monotonic Session Ratchet
Once a dialogue escalates to a higher tier (`plus`, `pro`, or `ultra`), mid-session downgrades back to `lite` are strictly blocked. Subsequent follow-up prompts (e.g., "fix line 3", "thanks") continue executing on the established tier, preventing hallucination and context corruption.

### 4.3 Entry-Mode Autonomy Matrix (ADR-0014)
The gateway enforces strict operational boundaries based on entry mode:

| Entry Mode | Eligible Triggers | Tier Movement by Judgment | Retry Escalation | Ratchet Locked |
| :--- | :--- | :--- | :--- | :--- |
| **`auto`** | Bare `auto`, tier aliases, classifier model names | Allowed (full cascade) | Full ladder (effort $\to$ tier) | Yes |
| **`explicit`** | Registered physical models, forced tier aliases | Forbidden (contract verbatim) | Disabled | No (fixed tier) |
| **`combo`** | Configured virtual combo IDs | Forbidden (pool internal) | Disabled | No |

### 4.4 Guarded Pin Eviction (ADR-0002)
Sessions pin to a specific physical model instance to maximize upstream KV prompt cache retention. A pin is evicted and migrated to a healthy landing only when:
1. The pinned model is removed from configuration or excluded by an updated denylist.
2. The pinned model reads fully `unavailable` (its model breaker is open, or all credential pairs are down).
3. Landing guard: the new target must belong to the active tier (cross-tier migration allowed only if the tier is completely depleted).

---

## 5. Resilience & Scoped Circuit Breakers

### 5.1 Seven-Class Error Taxonomy (ADR-0004)
Upstream errors are normalized into seven operational categories:
1. `quota` (HTTP 402): Upstream balance/quota exhausted. Trips immediately into `OPEN` (default 12h cooldown).
2. `auth` (HTTP 401/403): Invalid credentials or permissions. Marks the credential with a persistent `SUSPECT` flag.
3. `rate_limit` (HTTP 429): Upstream concurrency or token throttling. Applies adaptive backoff.
4. `server_error` (HTTP 5xx): Upstream service outage. Governed by consecutive failure thresholds and sliding-window error rates.
5. `timeout`: Network gateway or socket timeout.
6. `network`: Connection refused, DNS failure, or aborted socket.
7. `bad_request` (HTTP 400): Client-side or payload rejection. Does not trip circuit breakers.

### 5.2 Tripping Scopes & Capability Vocabulary
Circuit breakers isolate failures across three distinct scopes:
- **`model` scope**: Trips only the model globally when the failure is model-wide.
- **`credential` scope**: Trips across all models utilizing a specific credential (identified by `keyHashPrefix = sha256(key)[0..7]`).
- **`pair` scope**: Trips only the specific `(model, credential)` tuple.

At the health aggregation layer, models report status using capability vocabulary:
- **`available`**: Healthy and ready to serve traffic.
- **`recovering`**: Operating in `HALF_OPEN` probe state.
- **`unavailable`**: Model breaker `OPEN` or every candidate credential pair down.

### 5.3 Two-Stage Execution & KV Cache Protection (ADR-0005)
`executeCandidatePool` acts as the single choke point for upstream execution:
- **Stage 1 (In-Place Jittered Retry)**: On encountering a transient 5xx or timeout, OCR retries once on the *same physical model instance* with a brief jittered delay ($200\text{ms} + 0..100\text{ms}$). This resolves ~70% of cloud gateway blips while retaining 100% of the warmed upstream KV prompt cache.
- **Stage 2 (In-Tier Failover & Upward Escalation)**: If in-place retry fails, the pool iterates through remaining healthy candidates within the same tier. If the tier is exhausted, controlled upward escalation to higher tiers is permitted. Downward degradation is forbidden.

---

## 6. Failure Events Ledger & Observability

Implemented under **ADR-0013**, the failure events ledger provides deep visibility into upstream model calls:
- **Dual Emitters**: Captures failures from both `serving` candidate execution and `judge` remote calls.
- **Storm Coalescing**: Consecutive identical failures (`model × provider × errorClass × role`) within a 10-second window are coalesced into a single event with an incremented repeat counter ($N$).
- **Storage**: Bounded in-process ring buffer (500 events) mirrored synchronously into SQLite (`traces.db`, `failure_events` table).
- **Admin Endpoints**:
  - `GET /api/admin/failure-events`: Filter by `model`, `provider`, `errorClass`, `role`, or `limit`.
  - `POST /api/admin/failure-events/clear`: Clears both memory ring and SQLite durable mirror.
  - `DELETE /api/admin/failure-events/:id`: Deletes a single failure event.

---

## 7. Token Saver Compression Suite

The Token Saver pipeline reduces token bloat before upstream dispatch:
1. **`rtk` (Deterministic Tool Compression)**: Truncates and compresses high-volume tool outputs (e.g., git status, diffs, directory trees, compilation logs) using deterministic structural filters.
2. **`headroom` (Neural Compression Sidecar)**: Optional background sidecar service that applies neural context summarization across long multi-turn conversational histories.
3. **`caveman` (Terse System Prompt Injection)**: Injects compact system instructions prompting upstream models to provide direct, concise, and fluff-free technical completions.

---

## 8. Credential Store & Provider Defs Truth

### 8.1 Single Truth of Provider Definitions (ADR-0010)
Connection definitions reside strictly in `<ocrHome>/custom-providers.json`. Downstream tool configuration files (such as OpenCode v2's `opencode.jsonc`) are write-only sync targets materialized from this truth.

### 8.2 Credential Store Architecture (ADR-0006)
- Master credentials reside in `<ocrHome>/credentials.json`.
- Credentials are keyed by their cryptographic hash:
  $$\text{keyHash} = \text{SHA256}(\text{key})$$
  Display surfaces and logs exclusively expose the 8-character prefix `keyHashPrefix`.
- Synchronizes with active clients: OpenCode v2 (`opencode.db` / HTTP), Claude Code, Codex, and Pi.

---

## 9. Declarative Quota Probing Engine

Governed by **ADR-0009**, the quota engine tracks upstream balances without blocking inference:
- **Layered Knowledge**: Built-in declaration table $\to$ code adapters $\to$ operator `quotaProbes:` configuration.
- **12 DSL Constructs**: `get`, `post`, `header`, `body`, `extract_json`, `math`, `assert`, `date_format`, etc.
- **5 Banned Classes**: Arbitrary shell execution, raw socket access, credential write-back, unencrypted transport, and blocking inference gates are structurally prohibited.
- **Ledger**: Inference-side burns and probe snapshots append to the SQLite `quota_events` ledger.
- **Display-Only**: Quota probe failures never block or gate routing requests.

---

## 10. Architecture Decision Records (ADR-0001 to ADR-0014)

All architectural decisions are codified under `docs/adr/`:

| ADR | Title | Summary |
| :--- | :--- | :--- |
| **[ADR-0001](docs/adr/0001-routing-pipeline.md)** | Routing Pipeline | Cascaded tier decisions, System One judge decision cache, hardcoded plus quality baseline. |
| **[ADR-0002](docs/adr/0002-sessions.md)** | Sessions & Ratchet | 7-layer zero-header identity, monotonic session ratchet, guarded pin eviction. |
| **[ADR-0003](docs/adr/0003-model-addressing-and-tier-membership.md)** | Model Addressing | Addressing resolution ladder, explicit combo pools, per-key model access controls. |
| **[ADR-0004](docs/adr/0004-resilience-and-health.md)** | Resilience & Health | 7-class failure taxonomy, scoped circuit breakers, capability health vocabulary. |
| **[ADR-0005](docs/adr/0005-execution-topology.md)** | Execution Topology | Pure direct execution, `executeCandidatePool` single choke point, two-stage retry. |
| **[ADR-0006](docs/adr/0006-credential-store.md)** | Credential Store | Capability-based store adapters, key-hash identity, sync client materialization. |
| **[ADR-0007](docs/adr/0007-environments-and-bootstrap.md)** | Environments & Bootstrap | Isolated book-set directories, controlled restart switching, export/import envelopes. |
| **[ADR-0008](docs/adr/0008-protocol-surfaces-and-capture.md)** | Protocol Surfaces & Capture | Dispatch table for Chat, Anthropic, Responses, and SystemOne surfaces; HTTP capture. |
| **[ADR-0009](docs/adr/0009-quota-probing.md)** | Quota Probing | Declarative 12-construct DSL, 5 banned classes, display-only quota events ledger. |
| **[ADR-0010](docs/adr/0010-provider-def-ownership.md)** | Provider Def Ownership | `<ocrHome>/custom-providers.json` as single definition truth; `opencode.jsonc` materialized. |
| **[ADR-0011](docs/adr/0011-route-entries-and-retry-escalation.md)** | Route Entries & Retry Escalation | Persistent prompt experience table (`route-entries.json`), retry ladder, routing ledger. |
| **[ADR-0012](docs/adr/0012-judge-emitted-thinking-effort.md)** | Judge-Emitted Thinking Effort | System One judge emits `{tier, effort}` in one call; `effortSource` provenance headers. |
| **[ADR-0013](docs/adr/0013-failure-events-ledger.md)** | Failure Events Ledger | Upstream model call failure ledger, 10s storm coalescing, SQLite mirror, admin routes. |
| **[ADR-0014](docs/adr/0014-entry-mode-autonomy.md)** | Entry-Mode Autonomy | Autonomy matrix: only `auto` family moves tier by judgment; forced tiers served verbatim. |

---

## 11. Testing Matrix & Verification

### 11.1 Test Execution Commands
- **Typecheck** (TypeScript validation across backend and frontend):
  ```bash
  bun run typecheck
  ```
- **Isolated Backend Test Runner** (121+ suites in sandboxed processes):
  ```bash
  bun run test
  ```
  *Note*: Do not execute `bun test backend/tests` directly. Shared process memory contaminates global config state. The isolated runner (`scripts/test-isolated.ts`) launches each test in a sandboxed process.
- **Frontend Build Validation**:
  ```bash
  bun run build:frontend
  ```
- **Full System Integration Test**:
  ```bash
  bun run test:system
  ```

---

## 12. Coding Conventions & Cleanup Rules

1. **English Only in Code & Technical Docs**:
   - Comments (`//`, `/* */`), identifiers, log entries, and English docs (`README.md`, `DEVELOPMENT.md`) must be 100% English.
   - Chinese is permitted exclusively in localization tables (`frontend/src/i18n/locales/zh-CN.ts`), bilingual docs (`*.zh-CN.md`), and Chinese user config templates (`YAML_FIELD_COMMENTS`).
2. **Frontend Component Rules**:
   - Use `Combobox` from `frontend/src/components/Combobox.tsx` for all dropdown menus. Native `<select>` elements are prohibited due to theme inconsistency.
   - Wire types in `frontend/src/lib/api.ts` must mirror backend contracts 1:1 using identical contract names.
3. **Cleanup Contract**:
   - Renaming or deleting symbols requires an exhaustive sweep. Dead references in docstrings, test names, and ADRs must be deleted in the same commit.
   - Audit dead code before submitting changes:
     ```bash
     npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters
     npx tsc -p frontend --noEmit --noUnusedLocals
     ```
