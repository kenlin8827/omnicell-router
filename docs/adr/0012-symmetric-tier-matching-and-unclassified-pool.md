# ADR-0012: De-Residualized Tier Matching — Fully Symmetric Four Tiers + Anchored Exclusion excludeTiers + the Unclassified Fourth State

## Status

Implemented — 2026-10-09
**2026-10-10 upgrade**: 3 tiers → 4 tiers (Ultra tier added; the Plus price band changed from [0.8, 5] to [0.8, 3]; the Pro band is [3, 8]; the Ultra band is [8, +∞)).
**2026-10-10 trade-off**: name `patterns` for the four tiers were once tried, then **fully withdrawn** — vendor tier names (`flash` / `lite` / `pro` / `air` / `turbo`…) are unreliable as a cross-vendor price scale (same word, different price: `deepseek-v4.1-flash` @$0.3 and `gemini-flash` @$1.5 are both called flash yet belong in different pools). The baseline therefore became **purely price-driven**: all four tiers key solely on the price band (+ the reasoning flag → pro), with **no preset pattern at all**; name patterns remain a **user-optional** configuration per tier.

Related: [ADR-0011](0011-pure-direct-execution-no-daemon.md) (keeps its principle "unroutable supply is explicitly excluded, never silently degraded"), [ADR-0009](0009-cost-aware-resilience-and-hierarchical-retry.md) (cross-tier failover / reverse anti-downgrade), [ADR-0004](0004-hierarchical-classification-and-data-flywheel.md) (Layer 1/2 request-side tiering — **out of scope for this ADR**).

## Context

Candidate-pool membership had exactly one basis (smart match), but the early three tiers were **not symmetric**: `Lite` / `Pro` had "name pattern + price band + own-tier exclude", while `Plus` was designed as a **residual tier** — every model no one else claimed fell into it automatically. The hardcoded asymmetries that resulted:

1. `providers/tier-match.ts`: `plus: {}` (no band baseline); price bands called `bandHit` only for `lite` / `pro`; the trailing `return 'plus'` was an unconditional fallback.
2. `pages/RulesPage.tsx`: three `tier !== 'plus'` checks (payload construction ×2, input rendering ×1) → the Plus card had no price-band inputs.
3. The Plus card's exclude textarea actually read and wrote the **global** denylist `tiers.exclude`, unlike the lite/pro "own-tier veto" semantics.

Consequence: hand-writing `tiers.plus.match.minInputPerM` into `config.yaml` — `resolveTierMatch()` merges it in, but `classifyTier()` never consults it — **dead configuration**.

After the Ultra tier was added on 2026-10-10, this ADR is restated for four symmetric tiers: Lite (≤$0.8) / Plus ($0.8–$3) / Pro ($3–$8) / Ultra (≥$8). The three-tier asymmetry generalizes to a four-tier asymmetry; the solution is unchanged (de-residualize + symmetry + anchored exclusion + the unclassified fourth state).

User requirements: every tier configured the same way, every condition user-editable; explicit rejection of hidden rules like a "residual fallback"; and exclusion expressed on the **tier side** (this tier declares which tiers' models it does not accept), with those tiers' conditions applied as an exclusion filter at runtime.

Measured constraints (`~/.cache/opencode-router/catalog/`, 2026-10-09): of 8461 models in `models-dev.json`, **446 (5.3%) have no numeric `cost.input`**; all 468 in `openrouter.json` are priced. `bandHit()` returns false for `price == undefined`, so after de-residualization these 446 unpriced models belong to no tier.

## Alternatives and Rejected Rationale

| Option | Content | Verdict |
| :--- | :--- | :--- |
| A | Plus band as a "soft condition", fallback retained | **Rejected**: equivalent to having no effect — a fake config item |
| C | Keep the residual but rename to `tiers.fallbackTier` (default plus) | **Rejected**: a hidden fallback with an explicit name is still a hidden fallback |
| C' | Keep a narrow residual only for unpriced models (`unpricedTier`) | **Rejected**: encodes a data-quality problem into tier semantics |
| D₁ | `excludeTiers` on the **model side** (per-model declarations in overrides.json / opencode.jsonc) | **Rejected**: would require threading through catalog storage + new UI, and users could not see the tier rules on one screen |
| D₂ (this ADR) | `excludeTiers` on the **tier side**: this tier refuses models of which tiers | **Adopted**: zero new storage; at runtime take the referenced tiers' conditions as the filter |

## Decision

### 1. The fourth state is a "marker bit", not a tier enum member

`types/router.ts` adds `PoolMembership = TierLevel | 'unclassified'`, which `classifyTier()` returns; `ModelRegistration`'s `tier: TierLevel` stays **unchanged**, with a separate `unclassified?: boolean` added.

Rationale: `TIER_RANK`, `targetTier`, `escalateTier`, the `tierMap` in `layer1-classifier.ts`, the flywheel's `groundTruthTier`, and the session ratchet's `maxTier` are all **request-side three/four-state semantics** — forcing the fourth state into `TierLevel` would break the total ordering and the training-label type. Unclassified models still carry a placeholder `tier` but are marked out of every candidate pool and tier representative. **Layer 1/2 classifiers: zero changes.**

### 2. Full symmetry across the four tiers (five items)

Every tier uniformly gets `patterns` / `minInputPerM` / `maxInputPerM` / `exclude` / `excludeTiers`; all tier special-cases in `RulesPage.tsx` are deleted. The four-tier baseline (DEFAULT_TIER_MATCH):

- **Lite**: closed band `[0, 0.8]`
- **Plus**: closed band `[0.8, 3]`
- **Pro**: closed band `[3, 8]` (+ thinking-effort flag)
- **Ultra**: open band `[8, +∞)` (the catalogue auto-accumulates OpenAI/Claude flagship SKUs)

**Pin semantics cancelled**: the old plus pattern was the one "rescue" channel immune to exclude vetoes (`tier-match.ts`, old :90). Under symmetry each tier's pattern is subject to the decision order and its own tier gate; hard pinning goes solely through the catalog page's explicit `tier` (overrides > `configTier` — already the chain's highest authority).

### 3. Decision chain

```
denied = hits the global tiers.exclude                  // unconditional filter at the pool-query layer; vetoes even manual pins

1. explicit tier / configTier (manual pin; registry short-circuit, ignores tier gates)
2. name pattern: lite → pro → plus → ultra
3. price band bandOrder(): closed bands ascending by lower bound → open bands descending by lower bound; overlaps go to the lower-bound-lesser one; missing price never hits
4. thinking-effort flag → pro
5. nothing hits → unclassified
```

Every claim is stopped by two gate levels:

```
claim(tier, hits) = hits
                  && !(the model hits tiers[tier].match.exclude)
                  && !(the model hits the [conditions] of any tier listed in tiers[tier].match.excludeTiers)
```

What `excludeTiers` (anchored exclusion) tests is exactly "does that tier's condition set claim this model" — `matchesTierConditions()`: true if any one of **patterns / price band / thinking-effort flag** hits, and it deliberately does **not** consult the referenced tier's own exclude (the anchoring semantics is "models of those tiers", not "models in those tiers' final pools"). Self-reference (`excludeTiers` containing the tier itself) is ignored.

> **`exclude` / `excludeTiers` are not "an earlier stage" — they are gates on every claim.** Claiming is a `return`: made a standalone pre-stage placed after claiming it never executes, and placed before it can only express a global unconditional denylist (which is already `tiers.exclude`'s job).

> ⚠️ The two-segment ordering in `bandOrder()` is this ADR's key patch: open bands (no upper bound) are a **weak condition** and must sort after all closed bands, and among themselves **descending** by lower bound — otherwise an open `{min: 8}` band would swallow $15-priced high models in the band phase and empty the ultra pool.

### 4. `tiers.exclude` keeps the field, but the /tiers page drops the card

The user explicitly wants neither a "global exclusion list" card nor an "unclassified" card. Therefore:

- `tiers.exclude` still takes effect in the backend (pool-query layer `applyTierPolicy`); its editing surface is the **raw YAML page**;
- on /tiers save, the loaded `tiers.exclude` is **echoed back verbatim**: `saveConfig` shallow-merges `{...current, ...newConfig}` and `tiers` is replaced wholesale — omitting the field from the payload would **silently destroy** a user's existing denylist (`config.yaml` currently has no such field, but the save-path hazard holds for all users);
- the existing "exclude" button in the pool detail modal still writes to this field (pre-existing capability, no new UI).

### 5. Unclassified visibility: via the catalog page and logs, no new card

- The catalog page's tier suggestion gains the reason code `unclassified` (`TierReasonCode` in `lib/tierMatch.ts` + `catalogPage.ocrTierWhyUnclassified`) — a single model's "no condition hit" is visible here.
- After a config save, if a tier's pool is empty, `warnOnEmptyTierPools()` (`routes/console.ts`, called on both save paths) names the tier in gateway logs and suggests loosening match or pinning on the catalog page.
- **Unclassified models are invisible to tier routing but do not disappear**: still directly callable by model id, or via combos.

> Implementation trade-off: `pools.unclassified` was once added to `/api/ui/tier-pools` and `/tier-pools/live` with two cards built, then fully withdrawn per the user's "no residue" instruction; `resolveTierPool` still accepts `PoolMembership` (the fourth state remains usable at the pure projection layer for diagnostics), but it is no longer an API output surface.

### 6. Empty-pool behavior: degradation allowed, silence banned

With the residual in place, a tier pool could hardly ever be empty; after de-residualization, empty pools become a routine possibility. Old code on an empty pool: `tierDefaults.get('plus') || lite || pro || ultra || models[0]`, **no logging at all** (`registry.ts`, old :309-318) — "the request asked plus, actually got a lite model" left no trace. Now:

1. The fallback chain is explicit: `fallback.escalateTier` → plus → lite → pro → ultra, skipping unclassified at every step;
2. every hop logs a `console.warn` with `requested / actual / reason=empty-pool`;
3. if no tier has any routable model → throw (no more grabbing `models[0]` to pretend availability);
4. tier-representative selection becomes an **explicit two-phase** flow (first determine all members, then pick the representative), and `registerModel`, `reclassifyTiers` and `sync.ts`'s dynamic representative selection all skip unclassified — an unclassified model can never be a tier representative.

## Behavior differences (vs. the old residual semantics — must know)

1. **Unpriced + no pattern + no reasoning flag → unclassified** (old: landed in plus). 446/8461 (5.3%) of the catalog fall in this column and must be pinned explicitly on the catalog page.
2. **Price inside the plus band carrying a reasoning flag → plus** (old: landed in pro). Because the existing "band beats reasoning flag" rule now applies to plus too. Fixes: lower the plus upper bound, give the model a pro pattern, or pin it on the catalog page.
3. A price of exactly $3 (plus upper = pro lower) goes to plus; a price of exactly $8 (pro upper = ultra lower) goes to pro.
4. For configs that already wrote `tiers.plus.match.patterns`, those patterns are demoted from "rescue" to "ordinary claim". The current repo `config.yaml` plus has `*opus*` / `*sonnet*`, so their semantics change with it — to restore the old effect, give plus an inverted `excludeTiers` configuration or switch to catalog-page pinning.

## Risks / Boundaries

- The main regression (unpriced models) has no UI backstop, only catalog-page visibility — this is the user choosing "no residue" over "fully unclassified + UI visible + bulk pinning"; the cost is known and accepted.
- `tiers.exclude` moves from the /tiers page to YAML-page editing: field semantics and backend behavior are completely unchanged.
- Unit-test coverage (`backend/tests/tier-match.test.ts` fully rewritten, 15 cases / 35 assertions): four-tier symmetry, unpriced → unclassified, the plus band genuinely in effect, `bandOrder` closed/open ordering (across four tiers), overlapping bands to the lower bound, `exclude` veto, `excludeTiers` anchored veto (cross-condition patterns/band/flag, self-reference ignored), and a vetoed model catchable by another tier.

## Change surface (landed)

Backend: `types/router.ts` (`PoolMembership` four-state extension, `TIER_RANK` adds ultra = 4), `providers/tier-match.ts` (chain rewrite + four-tier `bandOrder` + `matchesTierConditions` + four-tier closed/open baselines + gates), `providers/registry.ts` (`projectedTier`, two-phase `reclassifyTiers`, `registerModel` representative protection, `getCandidateModelsForTier` filtering, `getModelForTier` explicit fallback chain [escalate, plus, lite, pro, ultra] + warn, `resolveTierPool` relaxed to `PoolMembership`), `config/types.ts` (`unclassified`, `TierPolicy.match.excludeTiers`, comments), `config/index.ts` (tiers field docs, incl. the new `tiers.*.match.excludeTiers`), `providers/boot-direct.ts`, `opencode/sync.ts` (fourth state + representative selection skips unclassified, adds the ultra representative), `routes/console.ts` (`warnOnEmptyTierPools` ×2 save paths, loop widened to 4 tiers).

Frontend: `lib/tierMatch.ts` (mirror rewrite: `Membership` / `bandOrder` / `matchesTierConditions` / `excludeTiers` gate), `pages/RulesPage.tsx` (four symmetric cards + anchored-exclusion checkboxes), `pages/CatalogSourcesPage.tsx` (`unclassified` reason code), `lib/api.ts` (`match` type gains `exclude` / `excludeTiers`, `tierDistribution` union widened to 4 tiers), `i18n/{types,locales/zh-CN,locales/en-US}.ts` (`tierLite/Plus/Pro/Ultra` translation keys).

Tests: `backend/tests/tier-match.test.ts` fully rewritten (the original 6 `toBe('plus')` residual assertions rewritten to the new semantics).

## Consequences

- The four tiers' configuration items and UI are fully identical; no field exists that "has no effect even when written"; plus/pro/ultra price bands, exclusions and anchored exclusions are all user-editable.
- Membership moved from "implicit fallback" to "explicit assignment"; the price is that unpriced / condition-less models need a one-time manual pin and are currently visible only on the catalog page.
- Empty pools changed from "silent cross-tier degradation" to "explicit degradation with logs, hard error when no model exists at all" — consistent with the resilience semantics of ADR-0009 / ADR-0011.
- The 4-tier naming (Lite/Plus/Pro/Ultra) is arranged by strength gradient and abstracts across vendors: Claude Haiku/Sonnet/Opus/Fable, GPT-5/5-Pro/5-Ultra, Gemini Flash/Pro/Ultra map onto the corresponding pools without rewriting the tier abstraction.
