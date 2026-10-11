# Architecture Decision Records (ADR)

> 🇨🇳 Chinese translation index & docs: [Chinese Version](./zh-CN/README.md).

This project adopts Architecture Decision Records (ADR) to document key architectural decisions, motivations, context, and trade-offs, ensuring long-term consistency and traceability.

## ADR Index

| ID | Title | Status | Date | Core Summary |
| :--- | :--- | :--- | :--- | :--- |
| [ADR-0001](./0001-purge-fuzzy-semantic-cache.md) | Complete Physical Removal of Local Fuzzy Semantic Caching | **Accepted** | 2026-09-29 | Eliminates system prompt weight dominance and response cross-contamination; maximizes upstream KV prompt caching |
| [ADR-0002](./0002-dynamic-model-discovery-via-opencode.md) | 100% Dynamic Model Discovery and Adaptive Tiering via OpenCode | **Accepted** | 2026-09-29 | Purges static provider/model hardcoding; delegates discovery, tiering, and credentials to local OpenCode daemon |
| [ADR-0003](./0003-language-neutral-routing-engine.md) | Language-Neutral Multidimensional Complexity & Structured Routing Engine | **Accepted** | 2026-09-29 | Strips natural language keyword lexicons in favor of syntax punctuation density, LaTeX math, and universal acronyms |
| [ADR-0004](./0004-hierarchical-classification-and-data-flywheel.md) | Hierarchical Classification Architecture & Active Learning Data Flywheel | **Implemented** | 2026-09-29 | Deploys Layer 0 structural rules -> Layer 1 local CPU model -> Layer 2 dedicated judge model + active learning flywheel |
| [ADR-0005](./0005-auto-initializing-base-model-scaffold.md) | Auto-Initializing Local Base Model Scaffold and Deterministic Cascade | **Implemented** | 2026-09-29 | Auto-initializes micro-tensor base model (W=0, b=0); mathematically guarantees confidence 0.25 < 0.85 to cascade to Layer 2 |
| [ADR-0006](./0006-monotonic-session-ratchet-and-prefix-fingerprinting.md) | Monotonic Session Ratchet and Zero-Header Prefix Fingerprinting | **Implemented** | 2026-09-29 | Prevents mid-conversation model-thrashing and protects KV cache; tracks sessions via prefix-chain hashing |
| [ADR-0007](./0007-symmetrical-pipeline-naming-classifier-and-judge.md) | Symmetrical Pipeline Naming: Layer 1 Classifier and Layer 2 Judge | **Implemented** | 2026-09-29 | Eliminates ad-hoc spatial naming in favor of layer1-classifier (lite lead) and layer2-judge (contextual adjudicator) |
