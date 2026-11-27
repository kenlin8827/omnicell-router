# ADR-0031 — Model Profiles Are Removed: Direct Rows and Smart-Assign Are the Whole Story

- **Status:** Implemented
- **Date:** 2026-11-15
- **Supersedes:** the model-profile surface (config `routing.modelProfiles`, the `/model-profiles` console page, client profile links and their write-through)
- **Relates to:** [ADR-0003](./0003-model-addressing-and-tier-membership.md) (model addressing — profiles never routed), [ADR-0016](./0016-config-schema-evolution.md) (the v1→v2 migration), [ADR-0026](./0026-mitm-canonical-seam.md) (precedent: delete, don't deprecate)

## Context

The model-profile mechanism was a named `slot → modelRef` table in config. A hooked client picked a profile, bound its agents/subagents to slot keys, and one apply wrote every resolved modelRef into the client's own config; saving a profile later re-resolved and rewrote every slot-linked row (write-through), while manually pinned rows stayed untouched. Profiles never routed — the gateway never resolved a profile id at request time.

The field data settled the question this ADR answers: `modelProfiles` was `[]` on every observed deployment and no client had ever linked one (`profile: ""`, `bindings: {}` across the whole `profileMemory` ledger). Meanwhile the two mechanisms that actually carry the workflow kept shipping:

- the **tier aliases** (`auto/lite/plus/pro/ultra`) already express "this role gets smart per-request routing" with zero per-role configuration;
- the **clients page rows** (direct per-agent model refs, native pins included) plus **smart-assign** (one decider call assigning a model per role) cover explicit assignment end to end.

What profiles uniquely added was cross-client batch rebinding — change the table once, every hooked client's linked row follows. That value never materialized for a single-operator local gateway, and the concept cost was real: slots, bindings, `slot:` link tags, write-through vs manual-pin vs inherit row states, a dedicated console page, and an extra profile branch in every client adapter and in the setup payload's validation path.

## Decision

### 1. Deleted, not deprecated

Following the ADR-0026 precedent, the mechanism is removed whole. The following **do not exist**:

- config: `ModelProfileConfig`, `RouterConfig.modelProfiles`, the `modelProfiles` comment entries, the `routing.modelProfiles` layout move;
- console routes: the setup payload's `profile` field and its slot-resolution/validation branch, `refreshClientProfileBindings` and both config-save write-through call sites;
- client adapters: `ModelProfileBinding`, `ClientHookStatus.profile`, `ClientAdapter.refreshProfileBindings`, the opencode/pi/omp sidecar profile echo, the profile un-link sweeps;
- sidecars: pi's `models.json.ocr-meta.json` and omp's `models.yml.ocr-meta.json` held only the echo, so they are legacy-only — deleted on teardown, never read or written. opencode's `opencode.jsonc.ocr-meta.json` keeps its live job (the previous-default-model memory); the retired `profile` key is stripped on every write, so old sidecars converge clean;
- frontend: `ModelProfilesPage`, the `/model-profiles` route and nav entry, the profile selector and `slot:` link-tag vocabulary in the agent row table / `ClientsPage` / `SmartAssignDialog` (the profile-mode candidate path — the decider now always assigns direct gateway model refs), `getModelProfiles` / `saveModelProfiles`, and the eight locale namespaces.

The link tables themselves **stay**: per-agent/per-role model assignment on the clients page is the surviving feature, now with exactly two row states — a gateway model ref, or empty (inherit). `linksOn` and the form memory (`clientProfileMemory`) keep their roles, minus the retired `profile`/`bindings` fields.

### 2. Schema v2: the chain appends, the key vanishes

`SCHEMA_VERSION` moves 1 → 2 with a new frozen `migrations/v1-to-v2.ts`:

- `routing.modelProfiles` is dropped and the move row is removed from `SECTION_MOVES_V2` (derived by filtering `SECTION_MOVES_V1` — the frozen v1 table stays the single source), so the retired key can never re-persist;
- stale profile-link bookkeeping (`profile`/`bindings`) is stripped from every `routing.profileMemory` entry; the live form-memory fields survive untouched;
- the step touches the `routing` group only when it already exists — a junk input still migrates to the same minimal skeleton.

The frozen `v0-to-v1.ts` keeps describing the v1 format (which historically had the section) via a local `LegacyModelProfileConfig` declaration — the removed config type is not resurrected for it.

### 3. What was not removed

- `clientProfileMemory` keeps its config-key name: renaming a live key costs a migration and buys nothing — the entry doc now says what it is (per-client console form memory), not what it once held.
- The `harness/` host `profile` vocabulary (DSH plugin profiles) is an unrelated mechanism and is untouched.
- Smart-assign keeps its `{ id, note }` candidate shape; `note` is now plain caller context.

## Consequences

- Setup payloads shrink to one agent-binding source (`agentModels`), and the console's row table loses its three-state semantics — the cognitive surface of the routing group shrinks by one concept (profiles), one page, and one link-tag namespace.
- Cross-client model changes are now N explicit setups (or re-running smart-assign per client). If multi-client batch rebinding ever becomes a real workflow, it should return as a *preset derived from the clients page drafts*, not as a parallel slot-table mechanism.
- **Amended (follow-catalog auto-resync):** hooked clients with `clientProfileMemory.modelMode=follow` and gateway plugins with `modelListMode=follow` are rewritten by an event-driven N-setup service (`cli/clients/follow-catalog-sync.ts`) when a Key's `modelAccess` changes or the live model pool rebuilds (enabled / expiry / delete only affect auth — no catalog rewrite). Default ON (`client.autoResyncFollowCatalogs`); running clients are queued as pending (no silent `acknowledgeRunning`). **No background retry loop** — open issues wait for a manual console retry (optional `acknowledgeRunning`) or the next key/pool event; auto-polling `ide_running` would write behind the operator, and hard fails do not heal by waiting. This is **not** a profile table or `refreshProfileBindings` revival — the index is the existing form memory / plugin config, and each target is still one setup or one plugin-config write.
- The live config upgrade happens at boot (ADR-0016 chain); a v1 file loaded by an older build draws the one-shot version warning, per the strict read contract.
