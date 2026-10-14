# ADR-0020: Model-Reference Glossary — `ModelRef` as the Umbrella, `ModelIdentity` for the Resolved Fact

## Status

Proposed — 2026-10-14. Layer: cross-cutting (naming contract). Scope: request-side `model` addressing, candidate/policy types, config member refs.

## Context and Problem Statement

A client request may name what it wants in the OpenAI-compatible `model` field in several
forms, all dispatched today without a shared concept:

- a **registered model id** (transparent — `decision-pipeline.ts` "a named physical id");
- a **combo id** (`registry.isCombo()` / `resolveCombo()`);
- an **auto-tier alias** (`auto`, `auto-lite` / `auto-plus` / `auto-pro` / `auto-ultra`,
  bare `auto`/`default`/omitted — `tierFromVirtualEntry()`);

This union — the namespace of names the API boundary accepts — had no name. The dispatch
logic spread across `surfaces/decision-pipeline.ts`, `auth/model-access.ts`, and
`providers/registry.ts`, each inventing its own phrasing ("virtual tier aliases", "combo
members", "named physical id"), and the vocabulary that did exist actively misleads:

1. `router/candidate-policy.ts` exported `interface ModelRef { id; provider }`, self-described
   as a *structural subset of `ModelRegistration`* — i.e. the **resolved physical fact**, not a
   reference. A "reference" with nothing left to dereference is a misnomer, and the name
   squatted the correct umbrella term.
2. The repo already had a `Ref`-suffix family for genuinely unresolved handles —
   `ComboModelRef` (config member entry, resolved per call by `resolveCombo()`),
   `RegisteredModelRef` (frontend wire handle for pickers) — so the suffix convention existed
   in the shape of the code but had never been stated.
3. "Virtual" was drifting toward umbrella status (the `VirtualModelsPage` UI,
   `tierFromVirtualEntry`) while semantically claiming indirectness — a registered model id
   passed through the boundary is *not* virtual, so the term lies on its largest member.

Industry has the same two-layer shape everywhere but no shared name for it (see Appendix),
so borrowing an external term wholesale is impossible; the glossary must be defined locally
and defended by the layering.

## Decision Drivers

- The umbrella term must be **boundary-defined, not nature-defined** — it describes what role
  a name plays (what the client puts in `model:`), not whether indirection exists behind it.
  Any word implying indirectness (`Virtual*`) fails on transparent ids.
- `Identifier/Id` is reserved ground already: `ModelRegistration.id`, `getModel(modelId)`,
  `combo.id` each use it in a *narrow, resolved* sense; an umbrella "ModelId" would create a
  four-way collision.
- `Ref` = "unresolved handle requiring `resolve`" matches the actual architecture: the
  gateway's per-request job is re-resolution (tier pools change with health, combo membership
  with config), which identifier-style naming would falsely imply is static.
- Zero-silent-rename policy: adopting `ModelRef` for the umbrella requires renaming the
  incumbent in the **same pass** (code, comments, test titles, ADR prose), per the repo
  cleanup contract.

## Considered Options

| Option | Summary | Verdict |
| --- | --- | --- |
| A. `VirtualModelId` as umbrella | leverage existing UI/comment usage | Rejected: "virtual" asserts indirectness; registered ids are members of the union — the term lies on the transparent limb (the exact confusion this ADR exists to remove) |
| B. `ClientModelId` / `ClientModelRef` | boundary-position prefix keeps the incumbent `ModelRef` | Rejected: leaves the misnomer in place; "Ref = unresolved handle" stops being a readable family rule; discussion still needs disambiguation for "model reference" |
| C. **`ModelRef` umbrella + rename incumbent to `ModelIdentity`** | Ref suffix reserved for unresolved handles everywhere; Identity names the resolved physical fact | **Chosen** — promotes an already-implied family rule (`ComboModelRef`) to a stated convention; ~16 mechanical call sites |
| D. `ModelId` / "model identifier" as umbrella | matches OpenAI's own "Model ID" field docs | Rejected: identifier semantics promise a static entity — false for `auto-lite` (per-request pool) and combos (editable membership); plus the `id` name-root is already occupied in three narrow senses |

## Decision

### 1. Glossary (normative)

```
ModelRef        — any name a client may set in the `model` parameter of an incoming
                  request (definition form adopted from Kubernetes GIE: boundary-defined,
                  not nature-defined). Kinds:
                    transparent   registered model id      → resolves to itself
                    indirect      combo id                 → resolves via ComboConfig
                    indirect      tier alias (auto*, auto/default/omit) → resolves via
                                                            live tier pool + health
                  Type-level: `type ModelRef = string` at the API boundary; parsed form is
                  a discriminated result { kind: 'model' | 'combo' | 'tier', ... }.
Ref (suffix)    — RESERVED for unresolved model handles needing `resolve`.
                  Members: ModelRef, ComboModelRef, RegisteredModelRef.
                  A new type with the Ref suffix must be a handle, never resolved state.
ModelIdentity   — the resolved physical fact: { id, provider } (plus `tier` where the
                  caller needs tier-aware policy). Renamed from the incumbent
                  candidate-policy `ModelRef`. This is what candidate filtering,
                  policy selectors, and breaker scope operate on.
virtual entry   — DOWNGRADED from umbrella to sub-category: only combo ids and tier
                  aliases are virtual (they carry policy/indirection). The "Virtual
                  Models" console page keeps the name legitimately for exactly that set.
modelId (local) — stays narrow = a registered model's id (as in `getModel(modelId)`).
                  Never used for the umbrella.
```

Reading the whole pipeline in one rule: **Ref = pointer, Identity = fact; resolution turns
the first into a set of the second** — `ModelRef → resolve → ModelIdentity[]`.

### 2. Rename scope (same-pass, cleanup contract)

- `router/candidate-policy.ts`: `ModelRef` → `ModelIdentity`; generic constraints
  `filterCandidates<T extends ModelRef>` / `weightedShuffle<T extends ModelRef>` and the
  `weightOf(m: ModelRef)` local; doc comment reworded (it currently says "Structural subset
  of ModelRegistration the policy needs" — correct description, wrong name-holder).
- Importers: `providers/registry.ts`, `routes/console.ts`, `config/index.ts`,
  `config/types.ts` (its own `ComboModelRef` **stays** — compliant with the family rule),
  `cli/clients/base.ts`, `cli/clients/opencode.ts`, and any test files touching selector/
  policy types.
- Sweep in the same commit: `rg -n '\bModelRef\b' backend/src frontend/src backend/tests`
  must show only legitimate *handle-sense* uses (umbrella discussion, ComboModelRef,
  RegisteredModelRef); zero leftover identity-sense hits. Comments and test titles included.
- Code comments must remain self-contained: the rename must **not** sprinkle "see ADR-0020"
  references (repo-wide ADR-citation scrub, 2026-10-11).

### 3. Consolidated resolver — stated, out of scope

A single boundary seam `resolveModelRef(raw: string): ResolvedModelRef` replacing the
scattered kind-tests is the natural follow-up once the vocabulary lands. This ADR
deliberately does not schedule it; it only freezes the terms that seam will be named after.

## Consequences

**For**

- One noun for the API-boundary namespace; policy/candidate layers keep a distinct, honest
  noun (`ModelIdentity`); the `Ref` suffix becomes a readable architectural invariant.
- Whitelist entries, `/v1/models` listing items, log `model=` fields, and config member refs
  now share one vocabulary chain instead of three dialects.
- No public API or wire-format change; purely internal naming + doc.

**Against / costs**

- Mechanical touch of the policy core (`candidate-policy.ts` is hot for other ADRs —
  0008/0013/0019 adjacency); concurrent editing sessions should re-read before renaming
  (this repo has multiple live agent sessions).
- "Virtual" remains in user-facing UI (`VirtualModelsPage`) with its now-narrow meaning —
  acceptable because the page genuinely lists only indirect entries.

## Appendix — industry shapes of the same layering

| System | Logical (client-addressable) | Physical (resolved) |
| --- | --- | --- |
| Kubernetes Gateway API Inference Extension | `InferenceModel.spec.modelName` — "the model as it will be set in the `model` parameter for an incoming request" / "client model names" | `InferencePool` (group of model-server pods) |
| LiteLLM | `model group` (`model_name`; callable as a model, appears in `/v1/models`) | `deployment` (`litellm_params.model`, e.g. `azure/chatgpt-v-2`) |
| Azure OpenAI | `deployment name` (⚠️ their "deployment" is logical — opposite of LiteLLM's) | model + quota |
| AWS Bedrock | `inference profile` / `provisioned model id` | endpoint |
| OpenRouter | model slug; `auto` is just a special slug | provider routes |
| llama.cpp server | `alias` | loaded model |

No cross-industry standard name exists for the union; every player independently adopts
"logical name → resolve → physical set", which is why this ADR names the layers rather than
importing a vendor term.
