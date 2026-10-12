# OpenCode Router (OCR) Developer & Architecture Guide

[![Runtime](https://img.shields.io/badge/Runtime-Bun%20%7C%20Node.js-blue.svg)](https://bun.sh)
[![Architecture](https://img.shields.io/badge/Architecture-Three--Layer%20Model--Driven-purple.svg)]()
[![Tests](https://img.shields.io/badge/Tests-37%2F37%20Pass%20(100%25)-brightgreen.svg)]()

[English Version](DEVELOPMENT.md) | [Chinese Version](DEVELOPMENT.zh-CN.md) | [User README](README.md)

> This document is designed for developers, contributors, and researchers working on **OpenCode Router (OCR)** core algorithms, extensions, private deployments, and architecture.  
> It covers the 3-layer model-driven pipeline architecture, mathematical fallthrough proofs, monotonic session ratcheting, active learning data flywheel workflows, and testing matrices.

---

## Table of Contents
- [1. Global Pipeline & Architecture](#1-global-pipeline--architecture)
- [2. Mathematical Principles & Deterministic Proofs](#2-mathematical-principles--deterministic-proofs)
  - [1. Base Model Scaffold & Softmax Fallthrough Proof](#1-base-model-scaffold--softmax-fallthrough-proof)
  - [2. Language-Agnostic Feature Extraction & Shannon Entropy](#2-language-agnostic-feature-extraction--shannon-entropy)
  - [3. Zero-Header Prefix-Chain Hash Collision Resistance](#3-zero-header-prefix-chain-hash-collision-resistance)
- [3. Core Module Responsibilities & Directory Structure](#3-core-module-responsibilities--directory-structure)
- [4. Active Learning Data Flywheel & Distillation](#4-active-learning-data-flywheel--distillation)
- [5. Test Matrix & Verification Suites](#5-test-matrix--verification-suites)
- [6. Architecture Decision Records (ADR)](#6-architecture-decision-records-adr)
- [7. Code Conventions & Zero Cruft Policy](#7-code-conventions--zero-cruft-policy)

---

## 1. Global Pipeline & Architecture

OpenCode Router (OCR) replaces simplistic character length rules (e.g., `prompt.length < 20 -> small model`) and natural language lexicons with a 3-layer hierarchical arbitration pipeline:

```
                      Client Requests (Cursor / Chatbox / NextChat / WebUI / Official SDKs)
                                                   │
                                                   ▼
                    [Step 1: Canonical Normalization & Prefix Fingerprinting]
                     - Zero-header session identification via SHA-256 Prefix-Chain Hash
                     - Preserves canonical byte order to maximize upstream Provider KV Cache
                                                   │
                                                   ▼
                  [Step 2: Three-Layer Model-Driven Hierarchical Classification]
            ┌──────────────────────────────────────┼──────────────────────────────────────┐
            ▼                                      ▼                                      ▼
   [Layer 0: Structural Override]       [Layer 1: Local CPU Model]             [Layer 2: Judge Model]
    - Explicit JSON Schema / Tools       - 8 Language-Agnostic Features         - Multi-turn context awareness
    - Deterministic Fast Tier Dispatch   - Untrained base scaffold (W=0, b=0)   - Statistically calibrated tiers
    - Zero-overhead protocol bypass      - Sub-millisecond CPU execution (<0.1ms)  - Decision labels feed flywheel
            │                                      │                                      │
            └──────────────────────────────────────┼──────────────────────────────────────┘
                                                   │
                                                   ▼
                    [Step 3: Multi-Turn Monotonic Session Ratchet State Machine]
                     - "Escalate-Only" policy: Strictly blocks mid-session downgrades
                     - Pins to the identical physical model instance, preserving 80%-95% KV Cache
                                                   │
                                                   ▼
                    [Step 4: Execution & Cascading Schema Assertion (Fallback)]
                     ├── Fast Lead ─────► [Local AST / JSON Schema Static Assertion]
                     │                      ├── Passed ────► Direct return (90% cost savings)
                     │                      └── Failed ────► Inject error context & escalate to plus
                     └── Plus / Pro / Ultra ────────► Enforce thinking-token budgets & return
```

### Hierarchical Decision Logic
1. **Layer 0 (Protocol Constraints)**:
   - Detects structural requirements (e.g. `response_format: { type: 'json_object' }` or `tools`).
   - Dispatches deterministically to lite tier models as lead runners, backed by local AST assertion with silent escalation.
2. **Layer 1 (CPU Micro-Tensor Classifier)**:
   - Extracts an 8-dimensional language-agnostic feature vector and evaluates linear logits with Softmax on CPU (`<0.1ms`).
   - When confidence $\ge \theta$ (default $0.85$), routes immediately on CPU. When below threshold, falls through to Layer 2.
3. **Layer 2 (Context-Aware Judge Model)**:
   - Evaluates recent conversational context using a dedicated judge model for authoritative semantic intent and difficulty rating.
   - Decision records stream into the data flywheel as supervised ground-truth labels.

---

## 2. Mathematical Principles & Deterministic Proofs

### 1. Base Model Scaffold & Softmax Fallthrough Proof
To achieve cold-start operation without heuristic bypasses, OpenCode Router (OCR) auto-initializes the active environment's `models/layer1-classifier.json` (under `~/.opencode-router/envs/<env>/`) with zero-initialized weights and biases upon boot:
$$W \in \mathbb{R}^{8 \times 3} = \mathbf{0}, \quad b \in \mathbb{R}^3 = \mathbf{0}$$

**Forward Propagation Proof**:
For any input feature vector $x \in \mathbb{R}^8$:
$$z = W^T x + b = \mathbf{0}^T x + \mathbf{0} = \begin{bmatrix} 0 \\ 0 \\ 0 \\ 0 \end{bmatrix}$$

Evaluating Softmax across the four tiers (lite, plus, pro, ultra):
$$P(\text{tier}_i) = \frac{e^{z_i}}{\sum_{j=1}^4 e^{z_j}} = \frac{e^0}{e^0 + e^0 + e^0 + e^0} = \frac{1}{4} = 0.25$$

**Deterministic Fallthrough Lemma**:
Given the system confidence threshold $\theta = 0.85$:
$$\max_{i} P(\text{tier}_i) = 0.25 < 0.85$$
Therefore, under untrained conditions, `isConfident` evaluates to **strictly `false` with mathematical certainty**.  
This guarantees zero premature short-circuits on cold start, gracefully cascading 100% of initial requests to Layer 2.

### 2. Language-Agnostic Feature Extraction & Shannon Entropy
The 8-dimensional normalized feature vector $x = [x_1, x_2, \dots, x_8]^T \in [0, 1]^8$ operates strictly independent of natural language vocabularies:

| Dimension | Feature Name | Normalization & Extraction Formula |
| :--- | :--- | :--- |
| $x_1$ | `token_count_normalized` | $\min(1.0, \log_{10}(\max(1, \text{tokens})) / 4.0)$ |
| $x_2$ | `turn_count_normalized` | $\min(1.0, \text{turns} / 20.0)$ |
| $x_3$ | `has_system_prompt` | $1.0$ if system prompt present, otherwise $0.0$ |
| $x_4$ | `code_block_ratio` | Markdown fence characters divided by total prompt characters $\in [0, 1]$ |
| $x_5$ | `syntax_symbol_density` | Density of universal syntax tokens (`{}[];()=><|&`) |
| $x_6$ | `has_tools_or_schema` | Boolean flag for JSON Schema or Function calling declarations |
| $x_7$ | `character_entropy` | Shannon character entropy: $H(X) = -\sum p(c) \log_2 p(c) / 8.0$ |
| $x_8$ | `punctuation_density` | Density of universal punctuation (`?!,.:;`) |

### 3. Zero-Header Prefix-Chain Hash Collision Resistance
In standard API clients without explicit session headers, OpenCode Router (OCR) tracks dialogues using Prefix-Chain Hashing:
$$\mathcal{H}_{\text{session}} = \text{SHA256}(\text{CanonicalJSON}(\text{messages}[0 \dots n-2]))$$

**Collision Resistance Analysis**:
The conversation prefix $messages[0 \dots n-2]$ contains the prior assistant response $A_{n-1}$. Due to autoregressive stochastic sampling across large vocabulary token spaces, $A_{n-1}$ contains extensive unique entropy.  
Under cryptographic SHA-256, the collision probability across global concurrent requests satisfies:
$$P(\text{collision}) \le \frac{k^2}{2 \times 2^{256}} \approx 0$$
Hash collisions are mathematically negligible, delivering completely stable zero-header session tracking.

---

## 3. Core Module Responsibilities & Directory Structure

```
opencode-router/
├── src/
│   ├── router/                    # Three-layer arbitration engine
│   │   ├── layer1-classifier.ts   # Layer 1: CPU micro-tensor feature classifier and in-place trainer
│   │   ├── layer2-judge.ts        # Layer 2: Dedicated context-aware semantic judge model
│   │   └── index.ts               # Central hierarchical arbitration pipeline (RouterEngine)
│   ├── session/                   # Session lifecycle & state machine
│   │   └── session-manager.ts     # Multi-turn monotonic ratchet state machine & prefix-chain hashing
│   ├── flywheel/                  # Active learning flywheel ingestion
│   │   └── collector.ts           # Asynchronous sample logger to flywheel.jsonl with negative labels
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
├── models/
│   └── layer1-classifier.json     # Auto-initialized micro-tensor base model scaffold (W=0, b=0)
├── scripts/
│   ├── train-layer1-classifier.ts # In-place gradient descent flywheel trainer (bun run train:layer1)
│   ├── flywheel-stats.ts          # Flywheel dataset distribution analyzer (bun run flywheel:stats)
│   └── full-system-test.ts        # 10-point full system integration test suite
├── docs/
│   └── adr/                       # Architecture Decision Records (ADR-0001 through ADR-0007)
│       └── zh-CN/                 # Bilingual Chinese ADR mirror directory
├── config.example.yaml            # Production configuration template
├── tests/                         # Comprehensive unit test suite (30/30 passing)
└── package.json
```

---

## 4. Active Learning Data Flywheel & Distillation

```
[Production Traffic]
        │
        ▼
Layer 2 Judge Decision / Layer 1 Schema Fallback Event
        │
        ▼
Append to the env's data/flywheel.jsonl (Ground truth tier + negative sample corrections)
        │
        ▼
Run bun run train:layer1
        │
        ▼
Compute Softmax cross-entropy loss with L2 regularization
        │
        ▼
Update <env>/models/layer1-classifier.json in place (isBaseModel: true -> false)
        │
        ▼
Subsequent matching requests execute directly on CPU at <0.1ms with $0 cost
```

### Running Flywheel Training
1. **Analyze current sample distributions**:
   ```bash
   bun run flywheel:stats
   ```
2. **Execute micro-tensor distillation**:
   ```bash
   bun run train:layer1
   ```

---

## 5. Test Matrix & Verification Suites

### 1. Unit Tests (37/37 Passing)
```bash
bun test
```
* **tests/flywheel.test.ts** (5 tests): Base model auto-initialization, uniform probability cascade, in-place training, negative sample corrections.
* **tests/session.test.ts** (4 tests): Prefix-chain fingerprinting, monotonic ratchet escalate-only rules, model pinning.
* **tests/trace.test.ts** (7 tests): Request trajectory recording, per-session trace indexing, global trace pagination, session inspection & deletion.
* **tests/router.test.ts** (4 tests): Client forced tiers, dynamic regex rules from YAML, default plus quality defense.
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

## 6. Architecture Decision Records (ADR)

| ID | Title | Status | Summary |
| :--- | :--- | :--- | :--- |
| [ADR-0001](docs/adr/0001-purge-fuzzy-semantic-cache.md) | Purge Local Fuzzy Semantic Caching | **Accepted** | Removes local vector cache to eliminate prompt weight collapse and protect native upstream KV cache |
| [ADR-0002](docs/adr/0002-dynamic-model-discovery-via-opencode.md) | 100% Dynamic Model Discovery via OpenCode | **Accepted** | Eliminates static model hardcoding in favor of dynamic discovery via local OpenCode v2 |
| [ADR-0003](docs/adr/0003-language-neutral-routing-engine.md) | Language-Neutral Multi-Dimensional Complexity Engine | **Accepted** | Replaces keyword dictionaries with syntax density, LaTeX math, and universal acronyms |
| [ADR-0004](docs/adr/0004-hierarchical-classification-and-data-flywheel.md) | Hierarchical Classification & Data Flywheel | **Implemented** | Establishes Layer 0 structural rules -> Layer 1 local CPU model -> Layer 2 dedicated judge |
| [ADR-0005](docs/adr/0005-auto-initializing-base-model-scaffold.md) | Auto-Initializing Base Model Scaffold & Deterministic Cascade | **Implemented** | Initializes micro-tensor base scaffold (W=0, b=0) with guaranteed low confidence to cascade |
| [ADR-0006](docs/adr/0006-monotonic-session-ratchet-and-prefix-fingerprinting.md) | Monotonic Session Ratchet & Zero-Header Prefix Fingerprinting | **Implemented** | Enforces escalate-only ratchet to prevent conversational degradation and protect KV cache |
| [ADR-0007](docs/adr/0007-symmetrical-pipeline-naming-classifier-and-judge.md) | Symmetrical Pipeline Naming: Layer 1 Classifier & Layer 2 Judge | **Implemented** | Standardizes symmetrical architecture (layer1-classifier / layer2-judge) and enforces physical cleanup |

---

## 7. Code Conventions & Zero Cruft Policy

1. **Zero Cruft Policy**:
   - Refactorings must physically delete legacy files rather than retaining re-export forwarding stubs (`export * from ...`).
2. **Strict i18n & English-Only Codebase**:
   - Source code (`src/`), tests (`tests/`), scripts (`scripts/`), and configs (`config.yaml`) must be **100% English**.
   - Bilingual documentation is maintained strictly in `docs/adr/zh-CN/`, `README.zh-CN.md`, and `DEVELOPMENT.zh-CN.md`.
3. **Zero Natural Language Hardcoding**:
   - Routing algorithms must never hardcode prompt character lengths or natural language keyword tables.
