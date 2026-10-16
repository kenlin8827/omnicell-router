# Quota P9 — Unified Model Audit & Consolidation Plan

Work order: *"P1–P8 若长出并行形状/重复 loader,此阶段收敛成单一 QuotaSnapshot 读写路径"* — audit-only pass over the live (largely uncommitted) working tree, 2026-10-16. Read-only analysis; no source file was modified; nothing was executed (test anchors are listed, not run). Governing record: ADR-0009 (+ `.ocp/adr-backlog.md` ledger lines P1/P2/P3/P4/P6/P7/P8; P12 owns the ADR backfill).

Scope honored: quota internals only; display-only plane preserved; probe-failure≠quota-failure firewall untouched; L-d iron rules still bind operator config only; frontend mirrors may gain fields, never rename wire names. HOT sibling-session files (`quota/prober.ts`, `quota/adapters/volcengine.ts`, `tests/quota-billing-shim.test.ts`; `quota/engine.ts` per the dispatch note) are touched only where a batch genuinely requires it, and those batches are marked.

---

## 0. What already converged (no action — do not "fix")

These are the P9 target shapes that P1–P8 already landed correctly:

- **Single snapshot→view builder**: `quotaViewFor` (console.ts:512-560) is the ONE `QuotaSnapshot`→`AccountQuotaView` reader, reused by all four wire surfaces — account-health overlay (console.ts:2442), pair directory (771), ledger rows (850), manual-write/delete echoes (1461, 1487). Badge computation single-sourced in `store.badgeState` (store.ts:235-249), its only caller being `quotaViewFor`.
- **Single connected-pair enumeration**: `enumerateConnectedPairs` (console.ts:740-757) extracted once, consumed by pair rows (765), ledger identity join (846) and the manual default-prefix resolution (1391). No residual join re-implements it.
- **TTL semantics single-sourced in store**: `effectiveTtl` (store.ts:50) and `clampManualTtl` (store.ts:43) each have exactly one definition; console consumes via import (console.ts:530, 1436).
- **Ledger aggregation layered, not duplicated**: `getAccountPairLedger` (trace/tracker.ts:406-441) wraps `getAccountPairUsageStats` with the durable-store pushdown + memory-ring fallback — one attribution rule.
- **Harvest call sites are exactly two by design**: registry.execute central success site (providers/registry.ts:904-911) + the native systemone leg (protocols/systemone/decide.ts:239-246). Not duplication — the converted leg already flows through the central site.
- **Frontend wire mirrors are name-faithful**: `AccountQuotaView`, `QuotaSnapshot`, `QuotaPairRow`, `QuotaLedgerRow/Totals`, `FamilyCatalogEntry`, `QuotaProbeConfigEntry` (api.ts:2276-2608) all mirror backend contract names 1:1 per the AGENTS.md convention; no wire-field drift found.

## 1. Findings table

Severity: **HOT** = runtime-invariant / user-visible divergence already present or one edit away. **WARM** = correctness-adjacent drift risk (identity strings, formats). **COSMETIC** = identical-bytes repetition, no divergence mechanism yet.

| # | Item | Evidence (file:line ×2+) | Severity | Proposed single source of truth |
|---|------|--------------------------|----------|--------------------------------|
| F1 | Channel-disclosure / badge-vocabulary resolver implemented 3× (manual / measured / folk-trial / stale-since branches) | `frontend/src/pages/QuotaPage.tsx:298-344` (`evidenceFor`) × `frontend/src/pages/KeysPage.tsx:270-304` (tooltip lines: folk 277-279, manual 300-303) × `frontend/src/components/QuotaManualSnapshotPanel.tsx:144-152` (`manualWord`) | **HOT** — divergence is already observable: KeysPage.tsx:304 prints the RAW `entryId` sentinel (`headers`/`manual`) untranslated, while QuotaPage.tsx:523-530 translates it; P8's "paste box and badge can never disagree" promise is broken on KeysPage | New `frontend/src/lib/quota-display.ts`: pure `evidenceChannel(quota) → {channel:'manual'\|'measured'\|'endpoint'\|'declared'\|'unverified', stale, folk?}` discriminator + `entryIdLabel(entryId, t)`. Surfaces map discriminator → their OWN i18n keys (copy stays per-surface, see do-not #7) |
| F2 | Percent tier thresholds (<10 critical / <25 low) + color mapping 2× | `QuotaPage.tsx:155` + `165-167` × `KeysPage.tsx:258` | COSMETIC (drift risk only) | Same `quota-display.ts`: `pctTier(pct)` |
| F3 | `fmtDur` / `fmtAbs` byte-identical duplicates | `QuotaPage.tsx:66-75` × `QuotaManualSnapshotPanel.tsx:115-124`; `QuotaPage.tsx:144-148` × `QuotaManualSnapshotPanel.tsx:156-160` | COSMETIC (identical bytes — cheapest possible merge) | Same `quota-display.ts`. (`QuotaFamiliesPanel.tsx:33 fmtTtl` is a genuinely different minutes-granularity formatter — leave.) |
| F4 | Snapshot precedence matrix encoded ad hoc in three write methods + cross-referencing prose in 3 places; NO single predicate | `store.ts:167-175` (`putMeasured` refusal: own-kind only) × `store.ts:191-196` (`putManual` unconditional) × `store.ts:154-158` (`put` unconditional); prose copies: `store.ts:177-190`, `types.ts:36-46`, `console.ts:1349-1359` | **HOT** invariant — the matrix (manual>all at paste; landing probed/forked/declared>manual; measured never overwrites non-measured) exists only as comments; a future source (first `declared` writer, P7 outcomes) must edit N sites and can silently break a row | `store.ts` exports pure `snapshotMayReplace(existing: QuotaSnapshot \| undefined, incoming: QuotaSource): boolean`; `putMeasured`/`putManual` delegate (behavior-identical row-by-row); the three prose copies collapse to a pointer at the predicate |
| F5 | Adapter-target TTL expression `target.kind === 'dsl' ? clampTtl(target.entry.cacheTtlMs) : 15 * 60_000` 3× inside one file | `prober.ts:222` × `prober.ts:229` × `prober.ts:267` | WARM (scheduling cadence drift) — **HOT FILE** (sibling session live-editing prober) | Private `targetTtl(target)` in `prober.ts`; `getTtlFor` + `runOne` delegate |
| F6 | `adapter:<id>` entryId formatting 3× | `engine.ts:371` × `console.ts:1287` (coverage row) × `console.ts:1697` (instantiate live echo) | WARM — identity-string format; drift breaks tooltip↔coverage cross-reference | `adapterEntryId(id)` exported from `engine.ts` (the definition site); console imports |
| F7 | `fam:` tag RE-IMPLEMENTED despite the helper existing — the explicit "later batch should have reused earlier batch" case | `family-templates.ts:130-132` (`familyTag`) × `console.ts:1635` (inline `` `fam:${tpl.family}:` ``) × `console.ts:1665` (hardcoded literal `'fam:'` prefix test) | WARM — the tag is the re-instantiation idempotency key; format drift orphans previously generated entries | `family-templates.ts` exports `familyTagPrefix(family)` + `isFamilyTagged(forkedFrom)`; console consumes both |
| F8 | Synthetic manual `QuotaProbeEntry` scaffolding + `resolveWindows` invocation 2× (write path vs preview path — the "paste box and badge cannot disagree" invariant rides on both staying in lockstep) | `console.ts:632-659` (`resolveManualWindows`) × `console.ts:1536-1560` (preview: same `{id: MANUAL_ENTRY_ID, url:'/manual-*', auth:'bearer', builtin:false, form:'static'}` scaffold + `resolveWindows(_, doc, ()=>null)`) | WARM | One helper `resolveThroughSyntheticEntry(providerId, specs, doc, urlTag)` inside the new manual module (F11) |
| F9 | `num`/`toFiniteNumber` byte-identical ×4 | `dsl.ts:43-50` × `adapters/minimax.ts:96-103` × `adapters/volcengine.ts:109-116` × `adapters/aliyun.ts:108-115` | COSMETIC — no cycle blocks the merge (dsl imports only types; adapters may import dsl) | Export `toFiniteNumber` from `dsl.ts`; adapters import. **Split**: safe half (dsl+minimax) now; volcengine (HOT) + aliyun (P7 pending approval) deferred |
| F10 | `LAST_BODY_MAX_CHARS`/`LAST_BODY_MAX_JSON_CHARS` copied with "mirrors engine.ts — local copy avoids the cycle" comments ×3 | `engine.ts:47-49` × `adapters/minimax.ts:62-65` × `adapters/aliyun.ts:63-64` | COSMETIC→WARM (the comment admits mirror-drift risk; the cycle IS solvable — `types.ts` imports nothing) | Both constants move to `types.ts`; engine + adapters import. aliyun half carries the P7-pending flag |
| F11 | Manual-channel DOMAIN logic (~250 lines: validators, key sets, window resolver, warnings builder, leaf flattener, snapshot construction, delete guard) embedded in the route file — a second "loader" grew outside `quota/`, against the L-d precedent (`buildConfigEntry` lives in engine.ts) | `console.ts:574-711` (MANUAL_* key sets, `validateManualWindow`, `resolveManualWindows`, `manualPasteWarnings`, `flattenLeaves`) × `console.ts:1360-1488` (snapshot construction 1448-1459; not-manual delete guard 1476-1486) | **HOT per the P9 mandate** — this IS the "parallel loader" the work order names; the manual write path constructs `QuotaSnapshot` outside the quota module | New `backend/src/quota/manual.ts`: validation + resolution + `buildManualSnapshot(input) -> {snapshot?, error?}` + clear-guard predicate; `manualPasteWarnings(providerId, proberOff, covered)` takes booleans (no prober singleton inside the domain module). console.ts keeps HTTP decode + status mapping only. Wire shapes identical |
| F12 | `covered:` plan-membership one-liner `getQuotaProber()?.getPlan().byProvider.has(pid) ?? false` 3× | `console.ts:770` × `console.ts:861` × `console.ts:669` (manualPasteWarnings variant) | COSMETIC | `isProviderCovered(providerId)` in console.ts (rides batch 3 for free) |
| F13 | Contract-name drift: backend `QuotaEvent` vs frontend mirror `QuotaEventRow` | `events.ts:24` × `api.ts:2364` (only consumer: `api.ts:2382`) | COSMETIC — frontend-internal type name, zero wire impact | Rename mirror to `QuotaEvent`. **SKIP** per work order (cosmetic-only) |
| F14 | Frontend sentinel constants re-declared (`QUOTA_MEASURED_ENTRY_ID`/`QUOTA_MANUAL_ENTRY_ID`) | `api.ts:2241,2245` × backend `harvest.ts:46` / `store.ts:37` | NOT a finding — this is the correct wire-mirror pattern. The defect is the missing translation dispatch on KeysPage, which F1's `entryIdLabel` fixes | (folded into F1) |

## 2. Implementation batches

Dependency-ordered; each batch ≤8 files; each lands as ONE commit (code + doc residue together, per the cleanup contract). Full-suite baseline to restore before starting: 1668± pass / 0 fail / 119 files via `bun run test` (isolated runner — never `bun test backend/tests`). Per-batch anchors list the test files that MUST stay green; run the full suite once at the end of all batches, not per batch.

### Batch 1 — store precedence predicate (F4)

- **Files (2)**: `backend/src/quota/store.ts`, `backend/src/quota/types.ts` (comment sweep only).
- **Change**: add exported pure `snapshotMayReplace(existing, incoming)`; `putMeasured`/`putManual` delegate; collapse the three prose matrix copies to one docstring + pointers. Pre-landing audit step: grep `\.put(` across `backend/tests` — any test seeding a `measured` snapshot through the unconditional `put()` keeps working because `put` itself stays unconditional (the engine-landing row of the matrix is "always allow"); only the two channel methods enforce.
- **Regression anchors**: `quota-harvest.test.ts`, `quota-manual.test.ts`, `quota-engine.test.ts`, `quota-ledger.test.ts`, `breaker-quota-cooldown.test.ts` (reads the store fail-open).
- **Rollback**: single-commit revert; the predicate is additive — method signatures and return semantics unchanged, no persisted-file format change.
- **Effort: S — EXECUTE** (hot-path invariant, cheapest batch, zero hot files).

### Batch 2 — entryId / family-tag identity SSOT (F6, F7)

- **Files (3)**: `backend/src/quota/engine.ts` (**HOT** — exactly two lines: export `adapterEntryId`, use it at the probePair stamp site), `backend/src/quota/family-templates.ts` (add `familyTagPrefix` + `isFamilyTagged`), `backend/src/routes/console.ts` (consume at 1287/1697/1635/1665).
- **Regression anchors**: `quota-engine.test.ts`, `quota-family-templates.test.ts`, `quota-manual.test.ts`, `quota-declarations-batch1.test.ts`, `quota-billing-shim.test.ts` (**HOT test — must stay green, must NOT be edited**).
- **Rollback**: revert; emitted strings are byte-identical before/after (format centralized, not changed) — zero wire/tooltip impact, safe to revert independently of batch 1.
- **Effort: S — EXECUTE, hot-file gated**: land only after the sibling session quiesces on engine.ts, or apply as an isolated hunk agreed with the sibling owner. Do not rebase a live-edited engine.ts blind.

### Batch 3 — manual-channel domain extraction (F11, F8, F12)

- **Files (3)**: new `backend/src/quota/manual.ts`, `backend/src/routes/console.ts` (routes 3E become thin HTTP), `backend/tests/quota-manual.test.ts` ONLY if it imports moved symbols (verified: it drives `createServer` routes — expected untouched).
- **Constraint checks**: `buildQuotaLedgerView` / `AccountQuotaView` / `QuotaLedgerRow` exports STAY in console.ts (`quota-ledger.test.ts:10` imports `buildQuotaLedgerView` from `routes/console.js`). Request/response shapes, status codes, `reasonCode`s and warning sentences unchanged (server-owned copy renders verbatim on the frontend — do not reword).
- **Regression anchors**: `quota-manual.test.ts` (primary), `quota-ledger.test.ts`, `quota-engine.test.ts`, `quota-family-templates.test.ts`.
- **Rollback**: revert the commit; `manual.ts` is new — deleting it restores the prior state wholesale. No persisted-state or wire-format coupling.
- **Effort: M — EXECUTE** (the core P9 mandate: converge the second loader into `quota/`, making the manual write path a domain function over the SAME store methods batch 1 unified).

### Batch 4 — frontend display convergence (F1, F2, F3)

- **Files (4)**: new `frontend/src/lib/quota-display.ts`, `frontend/src/pages/QuotaPage.tsx`, `frontend/src/pages/KeysPage.tsx`, `frontend/src/components/QuotaManualSnapshotPanel.tsx`.
- **Design line**: the shared module exports the DISCRIMINATOR (channel/stale/folk/pctTier/entryIdLabel/fmtDur/fmtAbs) — never i18n keys. QuotaPage maps it to `quotaPage.state*`/`srcNote*`, KeysPage to `op.quota*`, ManualPanel to its two `quotaPage.stateManual*` words. Both vocabulary tables stay untouched (the zh-CN sync-framing recast is ratified product copy).
- **ONE deliberate user-visible delta** (needs a nod at review, not an API change): KeysPage's tooltip gains sentinel translation (`headers`/`manual` → the localized channel word) via `entryIdLabel` — it currently prints the raw sentinel (KeysPage.tsx:304), contradicting QuotaPage.tsx:523-530 and the P8 "can never disagree" invariant. Everything else is pixel-identical.
- **Regression anchors**: no frontend unit tests exist — `bun run typecheck` (exit 0) + `bun run build:frontend`; backend suite untouched. Manual smoke: QuotaPage pill+tooltip, KeysPage badge tooltip, Settings manual panel stored-view rows.
- **Rollback**: revert; new lib file deleted, pages restore inline copies. No wire/type renames — cannot break the mirror contract.
- **Effort: M — EXECUTE** (hot-path: fixes an observable cross-surface divergence).

### Batch 5 — prober TTL expression fold (F5)

- **Files (1)**: `backend/src/quota/prober.ts` (**HOT — pure hot file**).
- **Change**: private `targetTtl(target)`; `runOne` (×2) and `getTtlFor` delegate. Value semantics unchanged (adapter cadence keeps its own 15-min literal — see do-not #2; do NOT substitute `MEASURED_TTL_MS`).
- **Regression anchors**: `quota-engine.test.ts` (scheduler/due-date sections), `breaker-quota-cooldown.test.ts` (adjacent, unaffected — green-only check).
- **Rollback**: trivial revert (single file, expression-level).
- **Effort: S — EXECUTE-DEFERRED**: schedule LAST and only after the sibling session lands its prober edits. If the sibling is still live at P9 execution time, SKIP-and-hand-off: leave this finding documented for the sibling to fold into their own diff (they own the file).

### Batch 6 — shared numeric / body-cap constants (F9, F10)

- **Files (safe half, 4)**: `backend/src/quota/types.ts` (receives the two body-cap constants), `backend/src/quota/dsl.ts` (exports `toFiniteNumber`), `backend/src/quota/engine.ts` (**HOT** — imports constants instead of defining them; ~3-line delta), `backend/src/quota/adapters/minimax.ts` (imports both; deletes local copies + the "avoids the cycle" comments — comment-residue sweep is part of the cleanup contract).
- **Deferred half (marked, do NOT land now)**: `adapters/volcengine.ts` (HOT sibling file) and `adapters/aliyun.ts` (P7 pending user approval — the skeleton may be redesigned; editing it now risks rework and entangles the approval diff). Leave both a one-line follow-up note in the batch commit message.
- **Regression anchors**: `quota-dsl.test.ts`, `quota-engine.test.ts`, `quota-declarations-batch1.test.ts`, `quota-billing-shim.test.ts` (HOT, green-only), `quota-aliyun-adapter.test.ts` (green-only — aliyun itself untouched in the safe half).
- **Rollback**: revert; constants are value-identical (32_768 / 262_144), no capture-shape change.
- **Effort: S — EXECUTE safe half / DEFER hot+P7 half.**

### Explicit SKIPs (cosmetic-only merges — the work order requires converging divergent shapes, not deduplicating stable bytes)

| Candidate | Verdict | Why |
|-----------|---------|-----|
| F13 `QuotaEventRow` → `QuotaEvent` frontend rename | **SKIP** | Zero divergence mechanism (single consumer); churn without payoff |
| `MONO`/`TH`/`TD` style-constant merge across QuotaPage + 2 panels | **SKIP** | Font stacks differ semi-deliberately (CJK fallbacks on the manual panel); page-level visual identity, semantic drift impossible |
| Splitting the quota surface out of console.ts into `routes/quota.ts` | **SKIP** | Structural move only; route-registration churn + `quota-ledger.test.ts` import breakage; converges nothing the work order names. Revisit if console.ts grows past ~4.5k lines |
| Unifying snapshot CONSTRUCTION across engine/harvest/manual into one factory | **SKIP** | Fields genuinely differ per channel (ttlMs/note vs successStreak vs neither); a union factory re-encodes the difference with no caller benefit (cp-abstract: wrong abstraction > duplication). The converged point is the store gate (batch 1), not the constructors |
| `fmtTtl` (QuotaFamiliesPanel.tsx:33) folded into `fmtDur` | **SKIP** | Different granularity contract (minutes, no day bucket) — a variant, not a duplicate |

## 3. Do NOT consolidate (looks duplicated, must stay separate)

1. **`prober.pairsOf` vs `console.enumerateConnectedPairs`** — pairsOf carries RAW keys (in-process probe credential, the consumer contract); enumerate is display-safe-prefix-only by construction. Merging either leaks raw-key handling toward the display plane or strips the prober's credential. Parallel enumeration IS the security posture, not an accident.
2. **The four "15 minutes"** — `clampTtl` default (engine.ts:41), adapter scheduling cadence (prober.ts:222/229/267), `MEASURED_TTL_MS` harvest freshness (harvest.ts:43), `FAMILY_CACHE_TTL_MS` preset TTL (family-templates.ts:141) — are four distinct concepts that coincidentally share a value. One knob must not silently move the other three (changing harvest freshness is not changing adapter probe cadence). Fold the EXPRESSION (batch 5), never the constants.
3. **`volcengine.extractResetMs` vs `dsl.parseResetTime`** — extractResetMs is a deliberate SUBSET (epoch s/ms + digit strings); parseResetTime also accepts ISO/duration forms. Swapping widens the accepted wire vocabulary of a fact-sheet-pinned HOT adapter ("the code follows the sheets") — a behavior change disguised as dedup.
4. **`aliyun.authClassCode` vs `volcengine.isAuthErrorCode`** — per-provider error-code vocabularies pinned by their own fact sheets; the overlap is coincidental (`NotApplicable` = wrong billing site, meaningful only to Aliyun; `accessdenied` casing only to Volcengine). A shared regex would couple two providers' auth verdicts.
5. **`breaker.quotaCooldownMs` direct store read vs `quotaViewFor`** — the trip-duration evidence read (circuit-breaker-manager.ts:857-869) is fail-open and view-independent BY FIREWALL DESIGN: routing it through the console view-builder would couple a breaker decision to a display contract. The quota plane feeds the breaker exactly one value (earliest future resetAt) in one direction.
6. **Per-channel snapshot constructors** (engine.probePair:428-437 / harvest:182-189 / manual:1448-1458) — see SKIP table; the convergence point is `snapshotMayReplace` at the store gate.
7. **The two i18n vocabulary tables** (`quotaPage.state*`/`srcNote*` vs `op.quota*`) — ratified product copy per surface (the zh-CN sync-framing recast, commit 6a9cb18). Batch 4 single-sources the LOGIC (which channel, which note lines) and explicitly never merges the WORDS.
8. **`events.ts` QuotaEventLog vs the ratelimit ledger** — "mirrors the ratelimit ledger exactly (precedent acknowledged, code original)": parallel by design over different tables/rings; a shared generic ledger abstraction is exactly the premature generalization the file headers disclaim.
9. **`runDslProbe` vs adapter HTTP plumbing** — the engine's single-URL GET vs the adapters' multi-URL/signed shapes IS the DSL-ban boundary (banned classes 4/5 are why adapters exist). Shared HTTP scaffolding would recreate the banned-class surface.
10. **Frontend sentinel constants** (api.ts:2241/2245) — wire mirrors of backend constants are the repo's mirror pattern, not duplication to remove.

## 4. TOP-3 risks of executing P9 while a sibling session is live-editing engine/prober

1. **Silent lost-update on uncommitted hot files.** The whole P2–P8 tree is uncommitted — git offers NO safety net for concurrent edits. Batches 2/5/6 touch `engine.ts`/`prober.ts` in the same regions the sibling is editing (probePair stamping, runOne arming, adapter ctx threading); a stale-read-then-write overwrites their in-flight change with no conflict signal (cp-dataloss applies to code, not just data). **Mitigation**: hot-file batches land ONLY after the sibling quiesces or commits; apply them as isolated single-hunk diffs; re-read each file immediately before writing.
2. **Moving-target verification.** `quota-engine.test.ts` is itself modified in the working tree and `quota-billing-shim.test.ts` is hot — a "green" anchor run mid-sibling-edit certifies a transient state. Worse, P7 is AWAITING USER APPROVAL: if approval reshapes `QuotaAdapterContext`/`probePair` threading or the aliyun skeleton, batch-6 extractions built on the skeleton get silently invalidated, and a batch certified green today can break the sibling's next assertion. **Mitigation**: run anchors immediately before AND after each hot-adjacent batch; treat aliyun/volcengine as frozen until P7 resolves; require one full-suite pass only after ALL sessions quiesce, never as a mid-flight gate.
3. **Review/bisect entanglement.** Two sessions claiming overlapping files in one uncommitted tree produce a combined diff nobody can attribute: P9's pure-refactor guarantee ("no behavior change") becomes unauditable when interleaved with the sibling's feature edits, breaking bisect and the ≤8-file review contract (cp-scope). **Mitigation**: P9 lands as its own commit series on a clean checkpoint (ask the sibling to commit or stash first); if that is impossible, execute only batches 1/3/4 (zero hot files) and hand batches 2/5/6 to the sibling session as annotated follow-ups.

---

*Audit performed read-only against the working tree at a1c5e90 + uncommitted P2–P8. No tests were run for this document (per dispatch instruction). Line numbers are working-tree positions as of 2026-10-16 and will shift under the sibling session — re-locate by symbol name before editing.*
