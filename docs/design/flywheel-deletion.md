# Design: Flywheel Dataset Deletion — Retention · Prune API · Batch Delete · Reset

Status: scope approved; §3 contracts are FROZEN so BE/FE build in parallel. @architect, 2026-10-12.
Amends ADR-0004's append-only narrative (§7). This doc specifies; it implements nothing.
**Amended 2026-10-13 (0.0.1 no-history policy): the `dropLegacy` prune option and the legacy-row
classification are retired — every `dropped.legacy` field, the third Switch and the v1 migration
branch are gone; a pre-v2 line parses as malformed. The §3 snippets below show the retired shape.**

## 1. Verified facts
- Auth: `/api/admin/*` is whitelisted from client API-key auth (server.ts:182-194); when webAuth is
  active the console gate requires a session cookie or the master adminApiKey (server.ts:136-163).
  Deletion endpoints inherit this gate unchanged — no new middleware. With webAuth off, admin routes
  are open (local-gateway model; same exposure as the existing destructive `DELETE /flywheel/labels`).
- `flywheel.*` config is restart-scoped (no hot applyConfig; only decision-capture has one).
- `FlywheelDataset.ensureIndexed()` self-heals on file shrink (dataset.ts:167-173), but shrink
  detection is racy: a concurrent append can restore size past indexedBytes before the next index
  pass, leaving stale byte offsets → an inode guard is required (D5).
- Next free ADR id: 0017.

## 2. Decisions
| # | Decision | Rationale / rejected alternatives |
|---|---|---|
| D1 | Deletion = whole-record discard via atomic rewrite (tmp + rename); surviving lines copied verbatim | Never mutate in place. Rejected: tombstone flags (mutate history, break the overlay-only correction contract); SQLite migration (a ~150-line rewrite engine covers all four ops and matches every JSONL precedent in-repo — cp-less) |
| D2 | One shared engine `backend/src/flywheel/prune.ts` (NEW); the CLI script becomes a thin wrapper; rewrites fully synchronous | All four ops are filter-and-rewrite variants; sync fs means single-threaded JS guarantees no in-process interleave — no lock needed. Huge-file stall is a marked ceiling with a worker/streams upgrade path (same treatment as the sync training loop, trainer.ts:11-15). Rejected: shelling out to the CLI from HTTP; putting the engine in dataset.ts (that class must stay the trusted non-mutating read side) |
| D3 | Backup matrix — prune apply: full `.bak-<ts>` + rotate keep newest 3 · batch delete: removed lines appended verbatim to sidecar `<datasetPath>.deleted.jsonl` · reset: `.bak-<ts>` of dataset AND of a non-empty labels overlay · retention sweep: NONE | A full-file backup per small delete is O(dataset) churn (800 MB copy for 5 rows); the sidecar is O(deleted), restore = append back. Retention-no-backup matches the capture/trace sweep precedent — bounded disk IS the feature; default-off (D4) is the guard. Sidecar is unbounded/human-deletable (grows only at human delete rate — YAGNI on caps) |
| D4 | Retention knobs `flywheel.retentionDays` + `flywheel.maxFileSizeMB`; `0`/unset = disabled (backward-compat); negative clamped to 0 + one warn; age pass first, then size trim oldest-first, in ONE combined rewrite; unparseable-timestamp records always kept; malformed lines kept (hygiene is prune's job); sweep at boot + hourly `unref`'d timer inside FlywheelCollector, only when `enabled`; disabling never deletes | Exact CaptureRecorder pattern (recorder.ts:344-348,415-419,1045-1075). Rejected: write-pause cap like decision-capture's 64 MB — pausing collection loses NEW ground truth to save OLD data, backwards for a training set |
| D5 | Consistency: HTTP handlers call `dataset.invalidate()` right after a successful rewrite; external rewrites (timer sweep, offline CLI) self-heal via a NEW inode-change guard in `ensureIndexed()`; HTTP destructive endpoints 409 while `trainer.isTraining()`; the timer sweep does NOT check the trainer | `rename` always swaps the inode → deterministic invalidation, closing the append/shrink race. The sync training loop cannot interleave with a sync sweep; a sweep landing in train()'s single setImmediate gap merely re-indexes before trainingSamples() — consistent, not corrupt |
| D6 | All three endpoints are POST; the typed confirmation word guards RESET only | Repo precedent: destructive admin actions are POST (metrics/reset, circuit-breakers/reset, model/rollback); DELETE-with-body is non-standard. No single-row `DELETE /samples/:id` — a batch of one covers it (cp-less). Per-row delete/prune rely on UI confirm dialogs + dry-run default + backups. CSRF on cookie sessions is pre-existing across ALL admin writes — flag-only, out of scope |
| D7 | Batch delete is partial-success + idempotent: 200 with `deleted` count and `notFound[]`; all-missing → 200 `deleted:0`; cap 1000 ids/call; empty/invalid → 400 | A whole-batch 404 is wrong when some ids existed; a re-click after partial failure is safe |
| D8 | Reset empties dataset + labels overlay (both archived); NEVER touches `models/layer1-classifier.json` / `.previous`; response carries `modelUntouched: true` | Data lifecycle ≠ deployed weights; the model has its own rollback/retrain controls — a data op must never silently change live routing. Rejected: a `deleteModel` flag (YAGNI) |
| D9 | Every removal path purges removed ids from the labels overlay (atomic rewrite); `removedLabels` reported in all responses | The overlay must not accumulate orphans keyed to dead records; reset clears it wholesale |
| D10 | Update the "nothing mutates recorded history" comments (dataset.ts:20-22, routes/flywheel.ts:13-15) to: append-only in normal operation; lifecycle ops (prune/retention/delete/reset) discard whole records via atomic rewrite under the D3 backup policy; corrections remain overlay-only | Comments must not lie (R4) |

## 3. REST contracts (FROZEN)
Error envelope `{ "error": "<msg>" }` (matches existing flywheel routes). Shared codes: `404`
`"No dataset file at <path>"` · `409` `"A training run is in progress; <op> is paused."` · `400` per
endpoint. Every success path calls `dataset.invalidate()` before responding.

### 3.1 `POST /api/admin/flywheel/prune`
Request (all optional; present-but-non-boolean → 400) — defaults replicate the CLI (dry-run):
`{ "apply": false, "dropSynthetic": true, "dropDuplicates": true, "dropLegacy": false }`
200: `{ "ok": true, "applied": bool, "total": n, "kept": n, "dropped": { "synthetic": n, "duplicate": n, "legacy": n, "malformed": n }, "removedLabels": n, "backupPath": string|null }`
`applied:true` only when apply was requested AND total>kept; nothing-to-prune → no rewrite, no backup
(mtime untouched), `applied:false`. `backupPath` is set only when this call wrote a `.bak`.

### 3.2 `POST /api/admin/flywheel/samples/delete`
Request: `{ "ids": ["a","b"] }` — required, 1..1000 non-empty strings, server dedupes; else 400.
200: `{ "ok": true, "deleted": n, "notFound": ["b"], "removedLabels": n, "sidecarPath": "<abs>.deleted.jsonl" }`

### 3.3 `POST /api/admin/flywheel/reset`
Request: `{ "confirm": "RESET" }` exact, case-sensitive; else 400
`"Body must include { \"confirm\": \"RESET\" } (exact, case-sensitive)."`
200: `{ "ok": true, "removedRecords": n, "removedLabels": n, "backupPath": string|null, "labelsBackupPath": string|null, "modelUntouched": true }`
Empty/missing dataset → 200 `removedRecords:0, backupPath:null` (idempotent); `labelsBackupPath` is
null when the overlay was empty/absent.

### 3.4 `GET /api/admin/flywheel/stats` — additive field only (old clients unaffected)
`"retention": { "retentionDays": n, "maxFileSizeMB": n, "enabled": bool, "lastSweepAt": string|null, "lastRemoved": n|null }`

## 4. Config
| Key | Type | Default | Semantics |
|---|---|---|---|
| `flywheel.retentionDays` | number | `0` = off | Drop records older than N days (by `timestamp`); 0/unset = never; restart-scoped |
| `flywheel.maxFileSizeMB` | number | `0` = off | After the age pass, trim oldest-first until file ≤ N MB; 0/unset = uncapped; restart-scoped |

`MB` capitalized to match `requestCapture.maxTotalMB`. `FlywheelConfig` (types.ts:303-308) gains both
as optional fields; `DEFAULT_CONFIG.flywheel` (config/index.ts:46-55) gains explicit zeros.
`YAML_FIELD_COMMENTS` additions (Chinese is correct here — user-facing config.yaml docs):
- `flywheel.retentionDays`: 样本保留天数（0 或不填=不自动清理；启用后启动时+每小时自动删除超龄样本；自动清理不生成备份、删除不可恢复，请谨慎设置）
- `flywheel.maxFileSizeMB`: 数据集文件大小上限 MB（0 或不填=不限制；超出后从最旧样本开始裁剪；在保留天数清理之后执行；自动清理不生成备份）

SettingsPage Section 3 (flywheel): two number inputs (pattern of `cache.ttlSeconds`,
SettingsPage.tsx:212-218) + a "restart required" hint line.

## 5. Red-lines
R1 never mutate a record in place — whole-line discard only, survivors verbatim. · R2 corrections
stay overlay-only (`setLabel`); deletion is never a label/tombstone edit. · R3 every rewrite is
atomic tmp+rename; retention-no-backup is the only exception, default-off, warned in config docs. ·
R4 append-only narrative comments updated (D10). · R5 no hardcoded UI strings — `t()` everywhere;
Chinese only in zh-CN.ts / YAML_FIELD_COMMENTS / ADR zh mirror; all code comments English. · R6 any
dropdown → `components/Combobox.tsx`, never native `<select>`. · R7 the /api/admin auth gate is
inherited unchanged, never weakened.

## 6. Tasks (file-by-file, acceptance criteria per row)
### BACKEND (dev B)
| # | File | Work → acceptance |
|---|---|---|
| BE-1 | `backend/src/flywheel/prune.ts` NEW | Engine: pure `planPrune(lines, opts)` counters; `rewriteDataset(path, filter, {backup, rotate})`; `deleteRecordsById(path, ids)`; `resetDataset(path)`; `applyRetention(path, cfg)`; `pruneLabelOverlay(labelsPath, keepIdsOrNull)`; `rotateBackups(path, keep=3)`. All sync fs, tmp+rename. Header comment marks the sync-stall ceiling + worker upgrade path (cp-marked). → Planner unit-testable with zero fs; no partial file on throw; rotation keeps exactly 3; sidecar lines byte-identical; overlay purge works for all four callers |
| BE-2 | `backend/src/flywheel/dataset.ts` | Inode guard in `ensureIndexed()` (store `statSync().ino` at open; invalidate on change) + header narrative update (D10). → Externally replacing the file with an equal-or-larger rewrite is picked up on the next query; no stale-offset reads |
| BE-3 | `backend/src/config/types.ts` + `config/index.ts` | §4 keys, defaults, YAML_FIELD_COMMENTS. → Fresh config.yaml shows both keys with the Chinese comments; absent keys load disabled |
| BE-4 | `backend/src/flywheel/collector.ts` | Retention sweep: boot + hourly unref'd timer when `enabled && (retentionDays>0 || maxFileSizeMB>0)`; clamp negatives; missing-file no-op; track `{lastSweepAt,lastRemoved}` via `getRetentionState()`; failures `console.warn('[Flywheel] …')` only, timer survives. → Disabled knobs = zero fs writes (backward compat); only expired/over-cap records removed; disabling never deletes |
| BE-5 | `backend/src/routes/flywheel.ts` | Implement §3.1-3.4 exactly (3 POSTs + stats block wired to collector state + config echo); 409 via `trainer.isTraining()`; `dataset.invalidate()` after each rewrite; header narrative update. → Contract tests (QA-2) green; existing 5 endpoints behaviorally unchanged; model files untouched by any route |
| BE-6 | `scripts/flywheel-prune.ts` | Thin wrapper over prune.ts (flags + output format preserved; gains rotation). → `bun run flywheel:prune` dry-run prints the same table; `--apply` rewrites + `.bak` |

### FRONTEND (dev F — starts day 1 against frozen §3/§4; mocks endpoints until BE-5 lands)
| # | File | Work → acceptance |
|---|---|---|
| FE-1 | `frontend/src/lib/api.ts` | Types + `pruneFlywheel(body)`, `deleteFlywheelSamples(ids)`, `resetFlywheelDataset(confirm)`, `retention` on the summary type; `throwFor` pattern as siblings. → Signatures match §3; typecheck clean |
| FE-2 | `frontend/src/pages/FlywheelPage.tsx` | Row checkboxes (`selectedIds: Set<string>`, checkbox column left of each row, header checkbox = select-all-visible-page, indeterminate partial) + "Delete {n}" toolbar button beside *Clear human labels* (:523), disabled when selection empty or training + existing `confirmDialog` + toast deleted/notFound + reload summary/samples; selection clears on page/filter change and after success. → Mixed existing/missing ids shows both counts; no hardcoded strings (R5) |
| FE-3 | same | Prune modal from a "Prune" button in the dataset-card header (:403-421): 3 Switch options (drop test traffic ON / duplicates ON / legacy v1 OFF), Preview → count breakdown inline, Apply → confirmDialog ("file rewritten, .bak backup kept") → toast dropped + backupPath; "Nothing to prune" empty state. → Preview performs zero writes (dry-run default); Apply disabled while training; numbers rendered from the response, not recomputed |
| FE-4 | same | Danger-zone card (red border) below the sample browser + reset modal with a text input; confirm button disabled until input === `RESET` exactly (word shown in desc). Desc states: labels cleared, backups kept, model weights NOT touched. → Wrong word cannot submit; success toast includes the model-kept note; summary/samples/training reload |
| FE-5 | `frontend/src/pages/SettingsPage.tsx` | Two number inputs (retentionDays, maxFileSizeMB) + restart hint in Section 3. → Values persist under `flywheel.*` via the existing config save |
| FE-6 | `frontend/src/i18n/locales/en-US.ts` + `zh-CN.ts` | §8 key list, 1:1 parity in both locales. → `rg '[\u4e00-\u9fff]' frontend/src -g '!zh-CN.ts'` finds nothing new; every `t()` key resolves in both locales |

No new dropdowns anywhere (R6 trivially satisfied; if one appears, use Combobox).

## 7. ADR recommendation
**Write a short ADR-0017** — `docs/adr/0017-flywheel-dataset-lifecycle.md` (madr style, English +
`docs/adr/zh-CN/` mirror; next free id verified: 0001-0016 exist). ADR-0004 established
"append-only, nothing mutates recorded history" as a governing contract that code comments cite
verbatim; four sanctioned destructive operations amend that invariant — even under governance mode
`none`, leaving 0004 unamended makes the corpus lie. ~1 page: decision (whole-record discard, D3
backup matrix, default-off retention, overlay-only corrections preserved), rejected alternatives
(tombstones, SQLite, write-pause cap), consequences; add a one-line "Amended by ADR-0017 (dataset
lifecycle)" note to ADR-0004. Do NOT supersede 0004 — the hierarchical pipeline decision stands.
Write it LAST so it documents what shipped. (Not written by this doc.)

## 8. i18n keys (en-US values authored by FE dev; zh-CN mirrors 1:1, same keys)
`flywheel.`: selectAll · selectedCount `{n} selected` · deleteSelected `Delete {n}` ·
deleteConfirmTitle · deleteConfirmDesc (names the sidecar copy + irreversibility) · deleteDone
`Deleted {deleted} records ({notFound} not found)` · deleteFailed · prune · pruneTitle · pruneDesc ·
pruneOptSynthetic / pruneOptDuplicates / pruneOptLegacy · prunePreview · pruneApply ·
pruneApplyConfirmTitle · pruneApplyConfirmDesc · pruneResult `Kept {kept} of {total} — synthetic {s}, duplicate {d}, legacy {l}, malformed {m}` ·
pruneNothing · pruneBackup `Backup: {path}` · pruneDone · pruneFailed · resetZoneTitle `Danger zone` ·
resetZoneDesc (labels cleared, backups kept, model weights NOT touched — rollback/retrain separate) ·
resetButton · resetModalTitle · resetModalDesc `Type RESET below to confirm…` · resetWordLabel ·
resetDone · resetFailed · retentionActive `Retention: {days}d / {mb}MB cap` · retentionLastSweep
`Last sweep {time} — {n} removed`.
`settings.`: flywheelRetentionDays `Sample retention (days, 0 = keep forever)` ·
flywheelMaxFileSizeMB `Dataset size cap (MB, 0 = uncapped)` · flywheelRestartHint
`Flywheel settings apply after a gateway restart.`

## 9. QA scope (dev Q)
Conventions: `node:test` + `assert/strict`, `app.inject`, tmp dirs under `./data/test_*` with
`after()` cleanup, `webAuth:{enabled:false}` (per flywheel-http.test.ts:15-34). Gates: `bun run
typecheck` + `bun run test` (isolated runner ONLY — bare `bun test backend/tests` is unreliable).
| # | File | Coverage |
|---|---|---|
| QA-1 | `backend/tests/flywheel-prune.test.ts` NEW | Engine units: dry-run purity (zero writes, mtime untouched); survivors byte-identical; backup on prune/reset + rotate-keep-3; sidecar append + byte-identity; overlay orphan purge on ALL four paths; reset archives a non-empty overlay, skips an empty one; retention: age cutoff, size trim oldest-first, 0/unset disabled (backward compat), negative clamp, unparseable-ts kept, missing-file no-op, combined age+size single pass |
| QA-2 | `backend/tests/flywheel-http.test.ts` EXTEND | §3 contracts: prune preview↔apply count parity, 400 bad types, 404 no dataset; delete partial-notFound 200, empty/>1000 ids 400, SAME-instance stats/samples reflect the deletion (proves invalidate); reset wrong-word 400 exact message, success clears overlay + leaves model file untouched (assert existence/mtime), idempotent re-reset; 409 paths (stub trainer state or skip-with-reason); stats `retention` shape; inode-guard re-index after external replace |
| QA-3 | regression | Both gates green; existing flywheel tests unmodified + passing; CLI smoke: dry-run then `--apply` on a temp fixture, verify `.bak` |

## 10. Implementation order (BE ∥ FE from day 1)
1. BE-1 engine (QA-1 written against it as it lands)
2. BE-3 config → BE-4 collector retention sweep
3. BE-2 inode guard + narrative comments (small, independent)
4. BE-5 routes (needs BE-1; stats block needs BE-4's getRetentionState)
5. FE-1 api client + FE-6 i18n keys (day 1, no backend needed)
6. FE-2 bulk delete → FE-3 prune modal → FE-4 reset zone → FE-5 settings fields
7. BE-6 CLI refactor (any time after BE-1)
8. QA-2 HTTP contract tests (after BE-5) → QA-3 full regression gate
9. ADR-0017 + zh-CN mirror + ADR-0004 amendment note (last)
Checkpoints: after 4+6a → e2e delete/prune/reset flows in the console; after 2+FE-5 → retention
round-trip (settings save → restart → stats block shows knobs). Every merge passes both gates.

## 11. Risks
| Risk | L | I | Mitigation |
|---|---|---|---|
| Sync rewrite stalls the event loop on huge datasets (~1-3 s @ 800 MB) | M | M | Marked ceiling + worker upgrade path (cp-marked); HTTP calls are explicit operator actions; hourly timer spreads automated work |
| In-flight `appendFile` (fd opened pre-rename) loses ≤1 record during a rewrite | L | L | Accepted + documented (sample data, fail-open sink); microsecond window |
| `.bak` churn fills disk | M | M | Rotate keep-3; O(deleted) sidecar for row deletes; retention writes no backups |
| Misconfigured retentionDays silently eats history | L | H | Default off; restart-scoped (no accidental hot toggle); Chinese config comment warns no-backup/unrecoverable; stats + UI surface lastSweep; ADR records the trade-off |
| Stale index after external rewrite (append/shrink race) | M | H | BE-2 inode guard (deterministic); shrink detection remains as a second net |
| CSRF on cookie-authed admin writes | — | — | PRE-EXISTING for all /api/admin writes — flag-only, out of scope (R7 keeps the posture unchanged) |
| Offline CLI prune while the gateway runs | L | M | Inode guard self-heals the index; docs steer operators to the HTTP endpoint while the gateway is up |
