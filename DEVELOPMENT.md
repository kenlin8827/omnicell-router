# OneCastRouter (OCR) Developer & Architecture Guide

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Cascaded%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Tests-37%2F37%20Pass%20(100%25)-brightgreen.svg)]()

[English Version](DEVELOPMENT.md) | [Chinese Version](DEVELOPMENT.zh-CN.md) | [User README](README.md)

> This document is designed for developers, contributors, and researchers working on **OneCastRouter (OCR)** core algorithms, extensions, private deployments, and architecture.  
> It covers the cascaded routing pipeline architecture, monotonic session ratcheting, and testing matrices.

---

## Table of Contents
- [1. Global Pipeline & Architecture](#1-global-pipeline--architecture)
- [2. Mathematical Principles & Deterministic Proofs](#2-mathematical-principles--deterministic-proofs)
- [3. Core Module Responsibilities & Directory Structure](#3-core-module-responsibilities--directory-structure)
- [4. Test Matrix & Verification Suites](#4-test-matrix--verification-suites)
- [5. Code Conventions & Zero Cruft Policy](#5-code-conventions--zero-cruft-policy)

---

## 1. Global Pipeline & Architecture

OneCastRouter (OCR) replaces simplistic character length rules (e.g., `prompt.length < 20 -> small model`) and natural language lexicons with a cascaded arbitration pipeline:

```
                      Client Requests (Cursor / Chatbox / NextChat / WebUI / Official SDKs)
                                                   │
                                                   ▼
                    [Step 1: Canonical Normalization & Prefix Fingerprinting]
                     - Zero-header session identification via SHA-256 Prefix-Chain Hash
                     - Preserves canonical byte order to maximize upstream Provider KV Cache
                                                   │
                                                   ▼
                  [Step 2: Cascaded Hierarchical Classification]
            ┌──────────────────────────────────────┐
            ▼                                      ▼
   [Layer 0: Request Rules]              [Layer 2: Judge Model]
    - Explicit tiers / aliases / combos   - Multi-turn context awareness
    - Global routing mode lever           - Statistically calibrated tiers
    - Deterministic, zero model cost      - Decision cache over identical contexts
            │                                      │
            └──────────────────────────────────────┘
                        │ (no judge decision)
                        ▼
              [Default: plus quality baseline]
                                                   │
                                                   ▼
                    [Step 3: Multi-Turn Monotonic Session Ratchet State Machine]
                     - "Escalate-Only" policy: Strictly blocks mid-session downgrades
                     - Pins to the identical physical model instance, preserving 80%-95% KV Cache
                                                   │
                                                   ▼
                    [Step 4: Execution & Cascading Schema Assertion (Fallback)]
                     ├── Lite lead ────► [Local AST / JSON Schema Static Assertion]
                     │                      ├── Passed ────► Direct return (90% cost savings)
                     │                      └── Failed ────► Inject error context & escalate to plus
                     └── Plus / Pro / Ultra ────────► Enforce thinking-token budgets & return
```

### Hierarchical Decision Logic
1. **Layer 0 (Request Rules)**:
   - Explicit client choices decide immediately: `router_options.force_tier`, auto-tier aliases, combos, and the global `routing.mode` lever.
   - Structured-output requests (`response_format` / `tools`) arm the lite-first schema-assertion cascade at execution time, whatever tier was decided.
2. **Route-entry Experience Table (ADR-0011)**:
   - Before consulting the judge, an auto request checks the persistent experience table: a hit short-circuits L2 with the tier (and effort) that served this prompt before.
   - Human-editable from the console `/route-entries` page; writes come only from the whitelist (judge ≥0.85, accepted retry corrections, human edits).
3. **Layer 2 (Context-Aware Judge Model)**:
   - Evaluates recent conversational context using a dedicated judge model for authoritative semantic intent and difficulty rating.
   - Any judge miss (disabled, unresolvable, timeout, upstream failure) degrades gracefully.
4. **Default (Quality-First Baseline)**:
   - With no judge decision, requests land on the hardcoded `plus` tier — zero-config never silently routes cheap.
5. **Retry Escalation (ADR-0011)**:
   - The same prompt re-sent in a session (≥20 chars, previous turn succeeded) escalates: attempt 1 raises reasoning effort, attempt 2+ raises the tier (cap `ultra`, capability-ceiling jumps straight to tier+1).

---

## 2. Mathematical Principles & Deterministic Proofs

### Zero-Header Prefix-Chain Hash Collision Resistance
In standard API clients without explicit session headers, OneCastRouter (OCR) tracks dialogues using Prefix-Chain Hashing:
$$\mathcal{H}_{\text{session}} = \text{SHA256}(\text{CanonicalJSON}(\text{messages}[0 \dots n-2]))$$

**Collision Resistance Analysis**:
The conversation prefix $messages[0 \dots n-2]$ contains the prior assistant response $A_{n-1}$. Due to autoregressive stochastic sampling across large vocabulary token spaces, $A_{n-1}$ contains extensive unique entropy.  
Under cryptographic SHA-256, the collision probability across global concurrent requests satisfies:
$$P(\text{collision}) \le \frac{k^2}{2 \times 2^{256}} \approx 0$$
Hash collisions are mathematically negligible, delivering completely stable zero-header session tracking.

---

## 3. Core Module Responsibilities & Directory Structure

```
onecast-router/
├── src/
│   ├── router/                    # Cascaded arbitration engine
│   │   ├── request-traits.ts      # Rule-based request facts (structured-output gate)
│   │   ├── route-entries.ts       # Persistent per-prompt experience table (ADR-0011)
│   │   ├── retry-escalation.ts    # Repeated-prompt detection + escalation ladder (ADR-0011)
│   │   ├── routing-ledger.ts      # Append-only hash-only audit trail
│   │   ├── layer2-judge.ts        # Layer 2: Dedicated context-aware semantic judge model
│   │   └── index.ts               # Central hierarchical arbitration pipeline (RouterEngine)
│   ├── session/                   # Session lifecycle & state machine
│   │   └── session-manager.ts     # Multi-turn monotonic ratchet state machine & prefix-chain hashing
│   ├── capture/                   # Request/response & decision capture sinks
│   │   ├── recorder.ts            # Full request/response body archive (opt-in)
│   │   └── decision-capture.ts    # Layer 2 judge decision dataset sampler (opt-in)
│   ├── validator/                 # Schema assertion & fallback extraction
│   │   ├── schema-assertion.ts    # Local AST & JSON Schema static assertion
│   │   └── parser.ts              # Error context extractor for silent retry
│   ├── budget/                    # Token budget & thinking-effort clamping
│   │   └── budget-manager.ts      # Token consumption ceilings and thinking-effort control
│   ├── trace/                     # Execution trajectory & turn telemetry
│   │   └── tracker.ts             # Ring-buffered turn trajectory tracking, session indexing & query API
│   ├── providers/                 # Upstream model execution adapters
│   │   ├── opencode-proxy.ts      # OpenCode v2 keyless proxy execution adapter
│   │   └── registry.ts            # Dynamic provider registry
│   ├── opencode/                  # Local OpenCode daemon integration
│   │   └── sync.ts                # Auto-discovery, dynamic 90+ model sync & adaptive tiering
│   ├── pipeline/                  # Pipeline orchestration
│   │   ├── prompt-optimizer.ts    # Canonical normalization for upstream KV cache protection
│   │   └── orchestrator.ts        # Central orchestrator coordinating routing, session, and fallback
│   ├── metrics/                   # FinOps cost analytics
│   │   └── finops-tracker.ts      # Real-time savings, cache hits, and tier volume aggregation
│   ├── server.ts                  # Fastify HTTP proxy server & endpoint definitions
│   └── index.ts                   # Gateway application bootstrap entrypoint
├── scripts/
│   └── full-system-test.ts        # 10-point full system integration test suite
├── docs/
│   └── adr/                       # Architecture Decision Records (ADR-0001 through ADR-0008)
│       └── zh-CN/                 # Bilingual Chinese ADR mirror directory
├── config.example.yaml            # Production configuration template
├── tests/                         # Comprehensive unit test suite (30/30 passing)
└── package.json
```

---

## 4. Test Matrix & Verification Suites

### 1. Unit Tests (37/37 Passing)
```bash
bun test
```
* **tests/session.test.ts** (4 tests): Prefix-chain fingerprinting, monotonic ratchet escalate-only rules, model pinning.
* **tests/trace.test.ts** (7 tests): Request trajectory recording, per-session trace indexing, global trace pagination, session inspection & deletion.
* **tests/router.test.ts**: Client forced tiers, structured-output gate, default plus quality defense.
* **tests/validator.test.ts** (4 tests): Markdown code fence parsing, JSON SyntaxError interception, JSON schema assertions.
* **tests/opencode.test.ts** (3 tests): Daemon auto-discovery, live model synchronization, adaptive 4-tier price pyramid.
* **tests/pipeline.test.ts** (4 tests): End-to-end execution, schema fallback retries, FinOps economics tracking.
* **tests/server.test.ts** (6 tests): Fastify HTTP server, `/v1/chat/completions`, SSE streaming, `/v1/metrics`.

### 2. Full System Integration Test
```bash
bun run scripts/full-system-test.ts
```
Launches a live gateway instance and executes 10 end-to-end integration tests against the live local OpenCode daemon (health check, model catalog, cascading arithmetic, independent session isolation, SSE streaming, legacy model adaptation, FinOps analytics).

---

## 5. Code Conventions & Zero Cruft Policy

1. **Zero Cruft Policy**:
   - Refactorings must physically delete legacy files rather than retaining re-export forwarding stubs (`export * from ...`).
2. **Strict i18n & English-Only Codebase**:
   - Source code (`src/`), tests (`tests/`), scripts (`scripts/`), and configs (`config.yaml`) must be **100% English**.
   - Bilingual documentation is maintained strictly in `docs/adr/zh-CN/`, `README.zh-CN.md`, and `DEVELOPMENT.zh-CN.md`.
3. **Zero Natural Language Hardcoding**:
   - Routing algorithms must never hardcode prompt character lengths or natural language keyword tables.
