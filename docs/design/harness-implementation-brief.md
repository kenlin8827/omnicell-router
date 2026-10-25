# Harness — Implementation Brief (historical)

Execution plan written **before** the domain shipped. It is kept for its ordering rationale only:
[`ADR-0015`](../adr/0015-harness-artifacts.md) is the authority for **what exists**, and its
"Deferred" table is the authoritative list of what was planned here and deliberately not built. Where
this file disagrees with the ADR, the ADR wins.

## Progress

**Landed** — host catalog + root resolver, hash normalization, per-env manifest v2 (with the v1
migration and orphan retirement) + machine-wide claims, inventory reconciliation, the removal ops
(`move-to-trash` / `drop-entry` / `drop-server` / `prune-record`), the API
(`/sources`, `/hosts`, `/applies`, `/inventory`, `/plan`, `/apply`, `/browse`, `/install`,
`/translate*`), the three kind writers (skill tree / MCP merge / extension config + subprocess), the
post-apply probe, the `applies` ledger, the GitHub + npm + MCP-official + Smithery adapters (both MCP
registries browsable since 2026-10-25), extension discovery
with `removal` descriptors, description translation, and the console (three pages, harness rail,
installed/market tabs, list ⇄ card).

**Not landed** (ADR-0015 "Deferred" is authoritative) — MCP landings beyond opencode, extension
landings beyond opencode/pi, npm-as-skill, the PulseMCP/mcp.so/curated-list adapters,
config-declared sources, write-ahead intent, store/trash GC, adopt,
harness export/import, `canonicalKey` alias overrides.

The task numbering below is the original plan's, not a backlog to execute.

## 0. Definition of done (the whole thing)

- [ ] Skills, MCP servers and Extensions are browsable from all shipped sources, searchable, and
      installable/uninstallable per copy across every enabled host.
- [ ] Inventory reports `clean / dirty / missing / foreign / untracked` per copy and `partial` /
      `shadowed` as derived rollups, for every host in the catalog.
- [ ] Every write is plan → confirm → apply, transactional per artifact, with intent/rollback.
- [ ] `bun run typecheck`, `bun run build`, `bun run test` green; `--noUnusedLocals` audit clean.
- [ ] Manual matrix executed on a scratch `OCR_HOME` (see §7).
- [ ] ADR-0015 status flipped to `Implemented` + `docs/adr/zh-CN/0015-*.md` mirror written in the
      same commit.
- [ ] No new drift twins: one constant per default (`config/defaults.ts` + `frontend/src/lib/defaults.ts`),
      one path table (ADR-0015 §D2), one state vocabulary (ADR-0015 §D8.7).

## 0.1 MVP vs Full (read before estimating)

**MVP = T1–T5 + simplified T6 + T7 + T8 + T9 + the view toggle.** One kind (skills), one target
(universal, global scope), two sources (GitHub + manual), plus a read-only inventory that scans every
known root. It answers the pain that justified the feature: *"what is installed where, and put this
skill there."* Roughly 40% of the full brief.

| Included in MVP | Why it cannot be cut |
| :--- | :--- |
| `claims.json` single owner | without it, uninstall deletes another environment's files |
| hash normalization | otherwise every Windows copy is permanently `dirty` |
| path containment validation | zip-slip equivalent — writing `../../` from registry input |
| plan preview before write | the only safety gate that survives every later slice |
| atomic directory swap | for a single target this replaces the whole multi-target rollback machinery |
| inventory across all roots | the unique value; works without any write path |
| list ⇄ card toggle | cheap (same `ArtifactSummary`, second layout) — deferring it saves nothing |

| Deferred to v1.1 | Trigger to build it |
| :--- | :--- |
| multi-target + per-copy uninstall | a second host is actually in use |
| `probe.ts` placement verification | someone reports "installed but not loaded" |
| MCP merge | skills MVP is in use and stable |
| Extensions | MCP is stable; Pi users ask |
| skills.sh / Smithery / static sources | GitHub+manual proves insufficient |
| upstream update scan + `canonicalKey` alias overrides | second source exists |

MVP keeps T6's *intent* but not its *machinery*: stage into a temp dir inside the store, then swap
the target directory atomically (`rename`), keeping the previous directory in trash. Multi-target
rollback arrives with the second target, not before.

## 1. Pinned decisions (do not re-litigate)

| # | Decision |
| :--- | :--- |
| 1 | One materialized path, one owning environment — `<ocrHome>/harness/claims.json`; a foreign claim is transfer-only |
| 2 | No GC for store/trash in v1 — append-only + manual prune |
| 3 | codex MCP unsupported in v1 (no TOML writer in this repo) |
| 4 | `adopt` copies into the store, records `adopted: true`, no upstream pin, never updatable from a source |
| 5 | Name collision → block; operator types another name. No `name@hash` suffix |
| 6 | Pin is a union: `{git:{commitSha}}` \| `{npm:{integrity}}` \| `{clawhub:{slug,version}}`; `ref` alone is never a pin |
| 7 | `shadowed` only ever asserts "a higher-precedence candidate root exists" |

## 2. Backend file layout

New module `backend/src/harness/` — one responsibility per file, no god-module:

| File | Responsibility | Must not |
| :--- | :--- | :--- |
| `types.ts` | `HarnessKind`, `HostId`, `CopyState`, `ArtifactSummary`, `ArtifactDetail`, `InstallPayload`, `SourceAdapter`, `Pin` | contain logic |
| `hosts.ts` | host identity table (`HOSTS`: id + label, catalog order) | hold landing paths (they live in `adapters/`) |
| `adapters/<host>.ts` | one file per host: skills dirs, MCP landing, extension landing (each path once) | duplicate another host's path |
| `adapters/declarative.ts` | the shared `defineHost` rules + capability interfaces + guards | hardcode a host-specific path |
| `hash.ts` | hash normalization (LF, BOM strip, sorted paths, no mode) + content hashing | know about sources |
| `paths.ts` | target path composition + containment checks (absolute, `..`, reserved names, 240-char cap) | touch the network |
| `manifest.ts` | per-env manifest read/write, schema version + migration, advisory lock | write files outside its root |
| `claims.ts` | `path → (env, artifactId, copyId)` registry, transfer plan | delete copies |
| `store.ts` | `<ocrHome>/harness/store/<key>/<hash>/` blobs, staging, `prune` | mutate targets |
| `identity.ts` | `canonicalKey` derivation + operator alias overrides | fetch |
| `sources/registry.ts` | adapter registry + config parsing + per-source health cache | contain source logic |
| `sources/github.ts` | `owner/repo[@skill]` resolve, raw content, commit pin | write targets |
| `sources/npm.ts` | npm search + packument + `integrity` pin | install |
| `sources/mcp-official.ts` | `/v0/servers` paging, `isLatest`, launch spec | merge config |
| `sources/smithery.ts` | hosted deployments only: launch spec for its OWN hosting, `Authorization` as an env KEY, required config refused by name | invent a launch for a server it does not host |
| `sources/static.ts` | shipped OpenCode ecosystem list | hit the network |
| `sources/skills-sh.ts` | metadata only; reports `unavailable: oidc-required` without a token | block other sources |
| `planner.ts` | diff computation (install/update/remove), plan id + staleness hash | write |
| `apply.ts` | write-ahead intent, staging, per-target trash snapshot, rollback, manifest-then-clear order | decide policy |
| `inventory.ts` | scan + reconcile (`mtime+size` fast path, hash on demand) | hash everything eagerly |
| `probe.ts` | placement verification per host (CLI probe where one exists) | claim "loaded" without evidence |
| `mcp/merge.ts` | JSON/JSONC key merge with backup, env **key names** only | write TOML; store secrets |
| `mcp/launch.ts` | `claude mcp add` subprocess (timeout, captured output, command echo) | pass `-y` |
| `extensions.ts` | `pi install npm:<pkg>` subprocess + `opencode.json` `plugin[]` merge | auto-confirm |
| `ledger.ts` | harness event ring (`utils/event-ring.ts` skeleton) | own a config knob |
| `service.ts` | orchestration façade used by routes (search → aggregate → join installs) | contain policy |

Routes: `backend/src/routes/harness.ts`, mounted with the existing `/api/admin/*` auth + CSRF gate.
Config: extend `config/types.ts` + `config/index.ts` with `harness.sources[]` (mirroring
`catalog.sources` shape: `{id, type, url, enabled, priority, authEnvVar, map?}`); defaults live in
`config/defaults.ts` only.

## 3. Frontend file layout

| File | Responsibility |
| :--- | :--- |
| `pages/harness/SkillsPage.tsx` / `McpPage.tsx` / `ExtensionsPage.tsx` | thin: layout + source tabs + data fetch, no rendering detail |
| `components/harness/SourceTabs.tsx` | runtime-derived tab row (enabled/disabled + reason) |
| `components/harness/ViewToggle.tsx` | list ⇄ card, persisted per kind |
| `components/harness/ArtifactList.tsx` / `ArtifactCard.tsx` | two layouts of the **same** `ArtifactSummary` |
| `components/harness/DetailDrawer.tsx` | provenance chips, launch spec, files, targets, install state |
| `components/harness/InstallSheet.tsx` | plan diff + warnings + confirm; target rows resolved live |
| `components/harness/TargetPicker.tsx` | `Combobox`-based host/scope picker, capability-filtered |
| `components/harness/CopyManager.tsx` | per-copy install state + uninstall + transfer/adopt |
| `lib/api.ts` | mirror backend contract names 1:1 (no page prefixes) |

Routes: `App.tsx` (`/harness/skills|mcp|extensions`); nav group in `Layout.tsx`; keys
`nav.grpHarness`, `nav.skills`, `nav.mcp`, `nav.extensions` in `zh-CN.ts` + `en-US.ts` in the same
commit. All copy through `t()`; no hardcoded UI strings.

## 4. Task order (each task = one reviewable change)

| # | Task | Depends on | Acceptance |
| :--- | :--- | :--- | :--- |
| T1 | `types.ts` + `hosts.ts` + `paths.ts` + `hash.ts` | — | unit: every host × scope path; containment rejects `..`, absolute, `CON`, >240; hash stable across CRLF/LF/BOM |
| T2 | `manifest.ts` + `claims.ts` | T1 | unit: two envs cannot claim one path; lock contention reports; migration v0→v1 |
| T3 | `store.ts` + `adopt` | T2 | unit: one blob, two targets, zero refetch; adopt with no pin is not updatable |
| T4 | `inventory.ts` | T3 | unit: `dirty`/`missing`/`foreign`/`untracked` fixtures; fast path avoids full hash |
| T5 | `sources/github.ts` + `sources/npm.ts` + `identity.ts` | T1 | unit: fixture JSON normalizers, no network; canonicalKey grouping; alias override wins |
| T6 | `planner.ts` + `apply.ts` | T2–T5 | unit: intent/rollback; failure at target 2 restores 1; crash leaves intent; `409 plan_stale` |
| T7 | `routes/harness.ts` (search/inventory/plan/apply/check) | T6 | integration: route tests with temp `OCR_HOME` |
| T8 | frontend spine: routes, nav, `lib/api.ts`, `SourceTabs`, list view | T7 | renders seeded inventory; `typecheck` |
| T9 | `DetailDrawer` + `InstallSheet` + `TargetPicker` (single target) | T8 | manual: plan diff visible before confirm |
| T10 | multi-target + `CopyManager` + `ViewToggle`/`ArtifactCard` + `shadowed` | T9 | manual matrix: 3 targets, remove one copy |
| T11 | `probe.ts` + placement tri-state in UI | T10 | unit: probe absent → `unverified`; UI never says "loaded" |
| T12 | `mcp/merge.ts` + `mcp/launch.ts` + two hosts | T11 | unit: merge preserves unrelated keys; aggregator cannot override launch spec |
| T13 | `extensions.ts` (Pi subprocess, OpenCode `plugin[]`) | T12 | unit: no `-y`; captured output; ledger row |
| T14 | skills.sh + smithery + static sources + source health UI | T13 | each degrades to `unavailable + reason`; page never blanks |
| T15 | docs: ADR status flip, design sync, `zh-CN` mirror | all | drift checks pass (see §6) |

Ordering rule: **nothing in T8–T14 starts before the backend task it renders is green.** UI built on
unverified APIs is how half-features ship.

## 5. Cross-cutting rules

- Comments and docs in English; identifiers English; only product strings are localized.
- One default per constant: `config/defaults.ts` (backend) / `frontend/src/lib/defaults.ts` (mirror) —
  updated in the same commit.
- No new dependency without a stated reason; TOML is explicitly **out of scope** (no library exists
  in this repo).
- Every apply path is preceded by a plan; every plan is re-validated by hash before writing.
- Never log a credential value; MCP secrets are env **key names** only (ADR-0006 untouched).
- Deleting/renaming anything → sweep comments, docstrings, test titles, README/ADR prose in the same
  pass (repo cleanup contract).

## 6. Verification commands (run for real, report verbatim)

```bash
bun run typecheck
bun run build
bun run test                                   # isolated runner — never `bun test backend/tests`
npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters
npx tsc -p frontend --noEmit --noUnusedLocals
rg -n '[\x{4e00}-\x{9fff}]' docs/adr/0015-harness-artifacts.md docs/design/harness*.md README.md
rg -n "(//|\*).*\b(<any deleted symbol>)\b" backend/src frontend/src backend/tests   # must be empty
```

## 7. Manual matrix (scratch `OCR_HOME`, one row per cell)

| kind × host | install | check clean | hand-edit → dirty | update refused | remove copy | remove all |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| skill × universal | | | | | | |
| skill × opencode | | | | | | |
| skill × claude | | | | | | |
| mcp × opencode | | | | | | |
| mcp × claude | | | | | | |
| extension × pi | | | | | | |
| extension × opencode | | | | | | |

Plus: two environments claiming one path (`foreign` + transfer), and one crash-simulated apply
(interrupted intent surfaced, not silently resumed).

## 8. Explicit non-goals (creep guards)

Remote/multi-machine installs; publishing; ratings; dependency resolution between artifacts (only
`requires[]` preflight warnings); per-agent skill permissions (belongs to the Clients domain);
Claude plugin marketplaces; TOML config writing; symlink materialization; store GC automation.

## 9. Handoff line for the executing session

> Implement `docs/design/harness-implementation-brief.md` tasks T1–T15 in order. ADR-0015 and
> `docs/design/harness.md` are the authority for decisions; the brief is the authority for order and
> acceptance. Stop and report if a decision in §1 must change.
