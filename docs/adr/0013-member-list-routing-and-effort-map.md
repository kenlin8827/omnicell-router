# ADR-0013: Member-List Tier Routing with Inline Effort Mapping

## Status

Implemented — 2026-10-10. Supersedes the routing half of ADR-0012 (auto-match no longer decides pool membership). The ADR-0012 classifier is NOT deleted — it survives as the *suggestion engine* (catalog-page recommendations, the first-boot seed, and `/tiers` save-time checks are all built on it).

## Context

ADR-0012 finalized a fully symmetric four-tier auto-match: `patterns` claim → price bands bound → `exclude` / `excludeTiers` veto → `unclassified` as the fourth state. In production use the operator concluded:

1. **Determinism beats zero-maintenance.** The model pool is a curated set; hidden heuristics kept producing surprises (free models capturing the lite lead via cheapest-first, band-boundary ambiguity at $3/$8, missing-price models landing unclassified, catalog renames silently changing membership). The industry-standard gateway model list (LiteLLM / Portkey style, explicit whitelist) is what the operator actually wants. New models NOT auto-joining the pool is a feature, not a bug.
2. **Per-model-group thinking translation is a real need** the match system cannot express: the same requested effort must become different values per model — add (medium→high), keep (medium), reduce (medium→low), or map to none. Global rules (single default / +N boost) were explicitly rejected; a group-addressable translation table keyed by model pattern is the accepted shape.
3. The control plane was scattered (tier pin in the catalog modal, `reasoningEfforts` in JSON-only, weights in a pattern editor). A member-list view with inline per-item config is the accepted UX.

## Decision

### 1. Tier membership = explicit `members` list (the ONLY source)

```ts
interface TierMemberRule {
  pattern: string;              // glob over the FULL model id (`provider/model`); no wildcard = substring; full id = single model
  weight?: number;              // >= 1, default 1 (reserved; v1 UI does not expose)
  effortMap?: Partial<Record<ReasoningEffort, ReasoningEffort>>; // thinking-level translation, inline
}

interface TierPolicy {
  members?: TierMemberRule[];   // ORDER = priority / failover chain
  selection?: 'priority' | 'weighted' | 'round_robin';
  match?: ...                   // @deprecated — suggestion engine only, never routing
  weights?: ...                 // @deprecated — weight moved into the member rule
}
```

Claim chain for ONE registered model (pure function of `model.id` × members config):

```
for tier in [lite, plus, pro, ultra]:          // cross-tier order: lighter tiers claim first
  for rule in members[tier] (list order):      // within-tier order = priority
    if globMatch(rule.pattern, fullModelId) → claim { tier, rule, index }
nothing matched → 'unclassified'               // fourth state KEPT (ADR-0012); joins no pool
```

- `claimed index` becomes the model's chain priority (`priority = index + 1`); the first rule's model is the tier's leader. `isDefaultInTier` auto-assignment (cheapest-lite etc.) is REMOVED from boot/sync — list order is the order.
- Hand-configured models (no captured `tierMatch`) keep their explicit tier and are never member-claimed (legacy semantics preserved).
- The global `tiers.exclude` denylist stays (pool-layer filter). Per-tier `match.exclude` / `excludeTiers` / price bands retire from routing with the rest of `match`.

### 2. `effortMap` — per-model firing level translation

Application (all entry modes: auto / explicit / combo members — it is a MODEL property):

```
effectiveTarget = effortMap[requested] ?? requested        // unconfigured = passed through verbatim
actual          = downgradeReasoning(effectiveTarget, supported(model))   // capability clamp
skip candidate  if effectiveTarget !== 'none' and actual === 'none'       // honesty contract
degraded        = rank(actual) < rank(requested)            // vs the CLIENT ask, not the map target
```

- **The map participates in candidate selection** (`bestEffortMatch`): per-candidate gap = `rank(requested) − rank(actual)`; min-gap first, ties by pool order. A `none→high` map makes that candidate win no-effort requests (gap −3); a `medium→low` candidate loses to a native medium server (gap 1 vs 0).
- A `requested === 'none'` request engages effort-selection ONLY when some candidate maps `none` to a non-none level; otherwise the legacy pass-through (any model, no thinking) applies. No cross-tier search for `none`.
- Per-candidate application happens in `executeCandidatePool` (the single execution choke point): every chain member gets `downgradeReasoning(map(candidate, requested), supported(candidate))` on its OWN request copy. Without a map the request is byte-identical to today.
- Vocabulary: the full 6-level `EFFORT_LADDER` (none / low / medium / high / xhigh / max). Unknown keys/values are dropped at sanitize time.
- Response headers keep the existing contract: `X-OCR-Thinking-Actual` = what was actually sent (post-map, post-clamp); `Degraded` = actual < requested.

### 3. Retirements

| Retired from routing | Kept as |
| :--- | :--- |
| `tiers[t].match` (patterns / bands / exclude / excludeTiers) | suggestion engine input (catalog suggestions, first-boot seed) |
| catalog override tier pin (`overrides.json` `tier`) | honored by the seed once; no longer read by routing; modal editing removed |
| `tiers[t].weights` | weight lives in the member rule |
| auto `isDefaultInTier` assignment (cheapest lite etc.) | removed — list order is the order |

### 4. Migration (no dual-track — routing switches in one step)

- **First-boot auto-seed**: if NO tier defines a `members` key, the legacy pipeline (match + pins, exactly what routing did before) classifies every registered model, groups the ids per tier in the old chain order (price-pyramid leaders land at index 0), writes them as explicit `[{ pattern: id }]` lists into `config.yaml`, and logs loudly. The gateway then routes via members. (A tier with an explicit `members: []` is respected and never re-seeded.) The seed runs on the REAL boot path (`boot-direct`) — the only path that writes `config.yaml`.
- **Manual re-import is intentionally NOT provided**: the first-boot seed is the only migration path. To rebuild from scratch, delete the four `members` keys and restart (the boot seed runs again); afterwards the /tiers editor is fully manual.
- **Save-time checks**: overlap (same model claimable by 2+ tiers — runtime resolves by tier order, but it is warned) and orphan (rule matching no registered model) → non-blocking warnings on save and in a dry-run check endpoint.

### 5. "Unclassified" is still the fourth state

A registered model matching no member rule joins no pool and can never be a tier representative (ADR-0012 §1 semantics unchanged). It remains directly callable by id / combo. The catalog page gains an "unpooled" view (visibility + one-click join = append its id to a tier's members).

## Behavior differences (vs ADR-0012 routing)

1. New models do NOT join any pool automatically — add them on /tiers or via the catalog "unpooled" view.
2. Catalog renames/removals leave dangling rules — the UI flags "no longer in catalog" members (orphans).
3. A model belongs to exactly one tier (first claim in tier order wins); overlapping rules warn at save time.
4. No price participation in routing at all; `lite` leaders are whoever the list says (no more cheapest-first).
5. With zero members configured EVERYWHERE, first boot auto-seeds from the legacy result — routing breaks loudly, never silently.

## Risks / boundaries

- The ADR-0012 classifier code path (`providers/tier-match.ts`) stays alive for suggestions; its tests stay valid. Drift risk between suggestion and routing is inherent and acceptable (suggestions never route).
- Hand-edited YAML with bad rule shapes is sanitized (invalid rules dropped, invalid effort keys filtered) — never crashes routing.
- The legacy daemon sync path was DELETED in this change (`opencode/sync.ts` → removed; `opencode/connector.ts` survives only as the daemon catalog reader). There is exactly one membership/seed path: `boot-direct`.

## Change surface

- **Backend**: `providers/member-match.ts` (new: resolve/claim/effortMap helpers + seed generator), `types/router.ts` (`EffortMap`), `config/types.ts` (TierMemberRule + deprecations), `providers/registry.ts` (claim-based reclassify/pools/selection + effort-aware pick), `providers/boot-direct.ts` (claim + first-boot seed; the legacy daemon sync path is deleted — the connector survives as `opencode/connector.ts`), `pipeline/orchestrator.ts` (effort map at pick/write-back/recompute + per-candidate in executeCandidatePool), `routes/console.ts` (pool projection, save-check endpoint, warn text), `config/index.ts` (YAML comments), `config.example.yaml`.
- **Frontend**: `pages/RulesPage.tsx` (member-list editor + effortMap popover + save checks), `lib/api.ts` types, `pages/CatalogSourcesPage.tsx` (unpooled view, join action), `i18n` ×3.
- **Tests**: new `member-match.test.ts` (claim order, substring, overlap, effortMap selection); `tier-membership.test.ts` rewritten to members; `tier-match.test.ts` untouched (suggestion engine); effort-map coverage added to reasoning-effort suites.

## Consequences

- Membership, order and thinking translation are 100% explicit and reviewable in one place; no hidden heuristic can move a model or a thinking level.
- Cost of control: new models need an explicit add; catalog churn needs the orphan/unpooled views; first boot migrates once.
- lite→plus→pro→ultra remains the request-side vocabulary; the tier semantics (escalation, ratchet, failover) are untouched.