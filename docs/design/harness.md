# Harness — Skills, MCP Servers, Plugins

Design companion to [ADR-0015](../adr/0015-harness-artifacts.md). Vocabulary is fixed there
(`client` = traffic hook, `harness` = artifact host). **ADR-0015 is the authority**: it records the
shipped surface, and its "Deferred" list names what does not exist. This document supplements it with
the page anatomy and data-model reasoning; where the two disagree, the ADR wins.

## 1. Scope

In scope: browse three artifact registries, plan an install, materialize it into a chosen
(host × rootId) target, keep an inventory with drift detection, remove tracked copies. Installs land
in the USER-LEVEL roots only: `scope` is still part of the wire shape, but `ENABLED_SCOPES` is
`['global']`, so a `project` request is refused with `unsupported_scope` (ADR-0015 §D2 "Scope").

Out of scope (v1):

- installing harness artifacts **into a remote machine** — local filesystem only;
- multi-tenant/marketplace features, ratings, publishing;
- Claude Code plugin marketplaces and Codex plugin surfaces (no first-class registry);
- any gateway-routing effect. Harness state never influences routing, credentials, or provider defs.

## 2. Navigation and routes

One sidebar group, three routes — one page per kind, because the three have different lifecycles,
different risk levels and different poll/cache behaviour.

```
nav group "Harness"          routes                                  page scope
├── Skills      ───────────► /harness/skills[/:harness]              pinned to ONE READER
├── MCP Servers ───────────► /harness/mcp[/:harness]                 pinned to a landing harness
└── Plugins  ───────────► /harness/plugins[/:harness]          pinned to ONE runtime
```

Each page has two tabs — `Installed` (the local inventory) and that kind's market — because installing
produces exactly the row the other tab lists. Every page is pinned to ONE harness and the URL carries the
pick (an unknown or missing segment is replaced, never pushed, so a stale bookmark lands somewhere
valid). The rail's TITLE is fixed — one column header, `HARNESS`, on all three pages, because it is the
same control everywhere. What the pick MEANS differs, and the hint under the rail says which: on
Plugins the runtime is the artifact's identity; on MCP it is the config landing the install fans out
from; on Skills it is a READER — ten runtimes load one `.agents/skills` tree, so the rail narrows to
"what this runtime can load" while writes stay owner-only (`skillReaders()` / `skillOwner()`,
ADR-0015 §D2).

The rail is a picker over the 18-row catalog, but its ENTRIES are the hosts detected on this
machine (executable on PATH, config dir, or an existing skills root — measured by the backend, never
configured), plus any host whose rows are already landed there; `universal` is always an entry, so a
fresh machine still has a landing spot. It filters by name once the list is longer than a glance (>8
entries, the same threshold the shared `Combobox` uses). The ACTIVE host is never filtered away: the
rail must still answer "where am I" while the operator types a name that excludes it.

A rail pick changes the SCOPE, never the view: the `?tab=` query rides along with the URL, so an
operator reading the market catalog keeps the market catalog for the next runtime, and one reading
`Installed` stays there. Back/Forward replays whatever each address recorded — a harness change is
simply a new segment with the same query. Switching tabs is always the operator's own click; the
rail's badge count never forces a view.

Source chips are derived from `GET /sources`, filtered by the page's kind and by the source's declared
`hosts`. A source that cannot serve renders disabled with its measured reason — never hidden, never
silently dropped. The registry decides WHICH sources exist and what they can do; their names and
reasons are the console's copy (`harness.sourceNames.<id>` / `harness.sourceWhy.<id>`, all eight
locales), with the backend `label` / `unavailableReason` as the fallback for an id the table has no
string for. A browse answer's `note` follows the same rule through its `noteCode`.

Chip ORDER is the registry array order, so it is a deliberate choice and not an accident of the
list: the market opens on the first enabled+browsable source, and the array's principle is
low-noise first — the order follows how far a row's claim reaches. Two built-in directories remain
(owner decision, 2026-10-31, ADR-0015 §D6): ClawHub for skills and pi.dev for plugins, each a
catalog whose row IS the artifact; operator git marketplaces are FEDERATED into the same answer,
not chips of their own (§D12). GitHub and npm survive as INSTALL RESOLVERS, never as discovery
chips. A disabled
chip, when one exists, also sorts behind the live ones: a dead chip in front of a working
catalogue reads as "the market is broken".

On the `Installed` tab each chip also carries the number of rows it would show. That number is a
FACET: it is computed from the rows the other controls (search, issues filter, host) already keep, so
a count can never disagree with the table it selects, and `all` counts the same list. A chip matches
the union of `sourceId` (the writer that produced the payload) and `listedOn` (the surfaces the row was
browsed on) — a Pi-catalog package installs through npm, so both chips must find it, while the row's
own source cell names the BROWSE surface (the install source) and falls back to the writer
(ADR-0015 §D8.6). The market tab's chips carry no counts:
each one would cost an upstream request per source, and a catalog's own match count is not the
reachable row count of this market.

The `Installed` tab renders only sources that have at least one installed row on that page (kind +
harness scope), because a facet with nothing behind it can only empty the table. That predicate is
deliberately UNFACETTED: a chip whose count the current search narrowed to 0 stays visible, so typing
never makes the whole chip row — `all` included — disappear.

Route registration is one line per route in `frontend/src/App.tsx`; nav entries live in the
`Layout.tsx` group table (`nav.grpHarness` + `nav.skills` / `nav.mcp` / `nav.plugins`), with every
locale entry in the same commit. No hardcoded UI strings (repo rule).

## 3. Page anatomy

Every page reuses one layout: `Toolbar (search / filter) → ArtifactList → DetailDrawer → InstallSheet`.

```
┌ Skills ────────────────────────────────────────────────────────────────────────┐
│ [ClawHub]                            search: ______________                │
│ ┌────────────┬───────────────────┬────────┬──────────┬──────────┬────────────┐  │
│ │ name       │ canonical source  │ listed │ trust    │ audit    │ installed  │  │
│ │ tdd        │ gh:mattpocock/…   │ 2 src  │ community│ pass     │ global·univ│  │
│ │ brave      │ official:ai.brave │ 3 src  │ official │ audited  │ —          │  │
│ └────────────┴───────────────────┴────────┴──────────┴──────────┴────────────┘  │
│                              ↓ click                                            │
│ ┌ DetailDrawer ────────────────────────────────────────────────────────────────┐│
│ │ sources: official (authoritative) · Smithery (hosts its own)                 ││
│ │ launch spec: npx -y @brave/search   ← from official record, not overridable  ││
│ │ files: SKILL.md, references/*.md    content hash: a1b2…                      ││
│ │ targets: [x] universal  [ ] claude  [x] opencode    [Install…]               ││
│ └──────────────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

- One row per **artifact**, not per listing (`canonicalKey`, ADR-0015 §D7). The `listed` column
  counts sources; the drawer shows provenance chips.
- Target selector = `Combobox` (repo rule: never a native `<select>`), options filtered by the
  artifact's declared hosts. Multi-select is expressed as repeated target rows, not a free checkbox
  grid, so each row can show its own resolved path.
- The install sheet always renders the dry-run diff before the confirm button becomes enabled.
- The aggregated tab merges results with `Promise.allSettled`; per-source failures render as a chip
  on that source's tab and never block the list.

### 3.1 One view model, two layouts (list ⇄ card)

Every source is converted once, server-side, into a source-agnostic object; both layouts render the
same object, so onboarding a marketplace never adds JSX.

```ts
interface ArtifactSummary {
  canonicalKey: string;              // ADR-0015 §D7
  kind: 'skill' | 'mcp' | 'plugin';
  name: string;
  summary: string;                   // one line, source-agnostic
  listedOn: { sourceId: string; label: string; trust: TrustTier; url?: string }[];
  trust: TrustTier;
  audit: { status: 'pass' | 'warn' | 'fail'; summary: string } | null;  // null = unaudited
  metrics: { downloads?: number; updatedAt?: string };
  targets: HostId[];                 // where it CAN go (capability-filtered)
  installs: CopyState[];             // where it IS (manifest join, §5.3)
  meta: Record<string, string>;      // source-specific chips, rendered generically
}
```

```
source adapter ──raw──► normalizer ──► ArtifactSummary / ArtifactDetail ──► view mapper ──► List | Card
                                                ▲
                        manifest join (installs) ┘
```

- **List** = dense rows: name · canonical source · trust · audit · installed rollup · actions.
- **Card** = the same fields in a 1–4 column grid (breakpoints), with the source chips and install
  badges in the header; nothing is card-only or list-only, so a bug reproduces in both.
- The **host tag is a row field, not page chrome.** A pinned page shows every row the selected
  runtime can *load*, while ownership stays per copy: one skill sits in the shared `.agents/skills`
  tree (`Universal`, read by ten runtimes) and another in the runtime's own directory (that runtime
  only). Dropping the tag because "the page is already pinned" makes a reader-scoped row look
  runtime-scoped, so it renders in both layouts, labelled with the host catalog's own name and
  tooltipped with the copy's real path.
- Toggle state persists per page (`localStorage: harness.view.<kind>`); default `list`.
- Actions are identical in both layouts: `Install` (not installed) · `Update` (stale) · `Remove`
  (installed) · `Manage copies` (when `installs.length > 1`).
- Pagination reuses `frontend/src/components/Pagination.tsx`; unbounded scroll is banned for registry
  lists (no total = no honest page count).

## 4. Host × kind matrix

`√` supported · `—` not applicable · `?` unknown (read the adapter before wiring) · `v` needs vendor
verification.

| host | skills | mcp | plugins | notes |
| :--- | :--- | :--- | :--- | :--- |
| universal | √ | — | — | `.agents/skills` only |
| opencode | √ | √ | √ | `opencode.json` `mcp` + `plugin[]`; root may be relocated by `OPENCODE_CONFIG_DIR` |
| claude | √ | √ v | — | `~/.claude.json` / project `.mcp.json`; has `claude mcp add` CLI |
| codex | √ | **—** | — | codex adapter writes `~/.codex/config.json`, **not** `config.toml`; no TOML writer in this repo → MCP only via `codex mcp add`, else not offered |
| pi | √ | via plugin | √ | MCP arrives as `pi-mcp-adapter`; `pi install` runs npm lifecycle scripts |
| dsh | ? | ? | ? | per-profile `$DSH_HOME/profiles/<name>/cordis.patch.yml` (`dsh.ts:15-25`) |
| cursor | √ v | v | — | `~/.cursor/mcp.json` |
| github-copilot / vscode | √ | v | — | `<repo>/.vscode/mcp.json` |
| gemini-cli | √ | v | — | `~/.gemini/settings.json` |
| cline | √ | v | — | `cline_mcp_settings.json` |
| amp | √ | v | — | `~/.config/agents/skills` (distinct from `~/.agents`) |
| windsurf | √ | v | — | `~/.codeium/windsurf/mcp_config.json` |
| zed | √ | v | — | `context_servers` |
| grok | √ | — | — | `~/.grok/skills`; the `.grok-plugin` market form is declared, but no verified MCP or plugin landing |

`opencode-proxy` never appears: it is a hook mode of `opencode`, not a separate host. Hosts are **not**
`SupportedClient` — Cursor/VS Code/Zed will never be traffic clients, and welding the two would pollute
the traffic domain (ADR-0015 §D2).

**A host is a reader, not a location.** Ten hosts read the project `.agents/skills`, five read the
global one, so one directory has many readers and exactly one owner: the first adapter in registry
order that resolves to that path (`skillOwner()` in `adapters/index.ts`). Installation, the inventory
scan and the console all apply that rule. Without it the same directory is recorded as `codex` by an
install and reported as `universal` by a scan — the list and the dialog disagree about what was
installed where.

## 5. Data model

### 5.1 Manifest — per environment; content in a machine-wide store

| Layer | Path | Holds |
| :--- | :--- | :--- |
| intent | `<env>/harness/manifest.json` | this environment's desired copies |
| store | `<ocrHome>/harness/store/<key>/<hash>/` | one download per content hash (machine-wide) |
| trash | `<ocrHome>/harness/trash/<ts>/` | rollback + removal snapshots |

Written atomically (tmp file + rename). There is **no advisory lock**: desktop + CLI are assumed to be
the same environment writing serially, and a concurrent second writer can lose a copy record. A single
`<ocrHome>/harness/manifest.json` is wrong: every environment would share it, losing copy records and
manufacturing `dirty` states.

```jsonc
{
  "version": 1,
  "artifacts": [{
    "id": "skill:gh:mattpocock/skills#skills/tdd",   // canonicalKey (ADR-0015 §D7)
    "kind": "skill",
    "name": "tdd",
    "source": { "sourceId": "github", "ref": "main", "commitSha": "<sha>", "contentHash": "sha256:…" },
    "listedOn": ["github"],
    "trust": "community",
    "storeRef": "…@sha256:…",
    "copies": [{
      "scope": "global",
      "host": "universal",
      "rootId": "default",
      "path": "~/.agents/skills/tdd",
      "contentHash": "sha256:…",
      "placement": "materialized",
      "dirty": false,
      "installedAt": "2026-10-24T00:00:00.000Z"
    }]
  }]
}
```

`ref` alone is banned as a pin: `commitSha` + `contentHash` are mandatory — a ClawHub skill pins the
registry version instead (`{ clawhub: { slug, version } }`, its deterministic per-version archive
being the registry-store counterpart of a commit) — so rollback and reproducibility exist from day
one.

`contentHash` is a stable hash over the artifact's sorted `(relative path, bytes)` pairs. It is what
makes "is this copy still ours?" answerable offline; a `dirty: true` copy blocks overwrite until the
operator confirms.

### 5.2 Identity and aggregation

| Kind | `canonicalKey` | Fallbacks |
| :--- | :--- | :--- |
| skill | `gh:<owner>/<repo>#<path>` | `npm:<pkg>#<path>` → `url:<host>/<slug>` |
| mcp | official reverse-DNS `name` (e.g. `ac.inference.sh/mcp`) | npm package name → `url:<host+path>` |
| plugin | `npm:<name>` | — |

**Aggregation is designed, not shipped.** The marketplace browses ONE source at a time
(`GET /browse?source=…`) and returns that source's normalized `MarketItem[]`; there is no fan-out
merge, no trust-tier field arbitration and no `conflicts[]` surface in this build. What IS shipped is
the identity scheme those would stand on:

1. each adapter normalizes its vendor payload into one shape (the page never learns a vendor's JSON);
2. identity is derived per kind (`<sourceId>:<ref>[#detail]`), never guessed by string similarity —
   the upstream names genuinely differ (`ac.inference.sh/mcp` vs `brave` vs `@brave/search`), so a
   similarity heuristic would merge unrelated servers;
3. `listedOn` records every surface the row was browsed on (writer source first) and `trust` is stored
   on the record — see ADR-0015 §D8.6 for why a catalog row's writer and its discovery surface differ.

Adding the merged view later means grouping by `canonicalKey` and arbitrating fields by the trust
ladder (`official > aggregator > community > manual`) — the keys it needs already exist.

**The npm source's empty query is a PER-HARNESS default.** npm search ranks by relevance over the
whole registry, so an empty `text` answers unrelated popular packages, and the `keywords:` qualifier
is an exact tag filter (measured 2026-10-25: the first 250 rows of every query below carry the tag).
The hub therefore maps one author-declared npm tag per runtime — `pi` → `pi-package` (12 736 rows),
`dsh` → `dsh-plugin` (10 048), `opencode` → `opencode-plugin` (2 684), `claude` →
`claude-code-plugin` (656), `codex` → `codex-plugin` (118), `gemini-cli` →
`gemini-cli-plugin` (18) — so a page pinned to one harness never opens on another runtime's
catalog. The remaining hosts (`cursor`, `windsurf`, `zed`, `cline`, `amp`, `github-copilot`) are
deliberately ABSENT: their tags answer 0–25 packages dominated by one cross-tagging publisher, so a
tag default would render an empty market and call it a catalog. Those pages open on the relevance
phrase `coding agent plugin` and say so (`noteCode: 'npm-default'`) instead of implying membership.
Anything the operator types is passed through verbatim — no tag is ever appended to a typed query.

### 5.3 Install state — answered per copy, never as a boolean

```ts
type CopyState = {
  scope: 'global' | 'project';       // 'project' only on copies installed before the scope gate
  host: HostId;                        // harness host, NOT SupportedClient (ADR-0015 §D2)
  rootId: string;                      // display hint only; absolute `path` is the identity
  path: string;                        // reconcile key (claims.json is keyed by this)
  state: 'clean' | 'dirty' | 'missing' | 'foreign' | 'untracked';
  placement: 'materialized' | 'verified' | 'unverified';   // orthogonal axis, not a state
  contentHash?: string;
  installedAt?: string;
};
```

- `state` is the only per-copy vocabulary. `partial` is a **derived rollup**, never written to disk:
  `clean` (all copies clean) · `partial` (some targets installed) · `dirty` (any copy hand-edited) ·
  `missing` (manifest claims it, disk disagrees) · `foreign` (another environment owns the path —
  transfer only) · `untracked` (disk has it, manifest does not — reported, and removable like any
  other copy). `shadowed` is named in the type union but has no producer today: the resolver exposes a
  precedence index, and nothing yet derives a row from it.
- **Hash normalization is part of the contract.** Compose the content hash over LF-normalized bytes,
  BOM stripped, sorted relative paths, no file mode. Without a fixed normalization, Windows
  `autocrlf` makes every copy permanently `dirty` on day one.
- **Placement is tri-state, not a boolean.** `materialized` (written) → `verified` (a host CLI probe
  actually lists it) → `unverified` (no probe exists for that host). The console never prints "loaded"
  without a probe result; `materialized` is the honest default.
- "Is it installed?" is answered **without a per-row request**: the console joins each market row
  against the inventory it already holds (`installsFor`), using the row's `canonicalKey` (exact for an
  plugin, repo-prefix for a skill until the tarball names its directory). The market response
  carries no install state, and a per-row state request is forbidden (N+1 on a page of 50 rows).
- Install / uninstall are per copy. `Remove` on a row opens the copy list with checkboxes, listing EVERY
  copy and preselecting only those this page's harness serves — the same `copyServes` predicate the rail
  counts with, so a skills page selects by readership (a `.agents/skills` copy is owned by `universal`
  and read by every `readsUniversal` runtime, so it appears under each of them) and an MCP/plugin page
  by the copy's own host. The page's scope is a DEFAULT, not a permission: another runtime's copy stays
  visible and tickable (the card's host chips name it anyway), so "remove everywhere" is one plan fully
  checked. Only a `foreign` copy is disabled — another environment owns that path and the plan refuses
  it. A `dirty` copy requires an explicit "discard local edits" confirmation — for trash moves only,
  because a config-member edit never destroys the hand edit.
- **The removal op is chosen by the landing shape, and the plan says which one.** A file tree or a
  loose plugin file is moved to the trash; a `plugin[]` / `packages[]` member is dropped from its
  own file; an MCP server member is deleted from its `mcp` container; a package with no declaration
  file only loses its record. A copy whose `path` is a config file is NEVER trashed — that file holds
  every other artifact the runtime knows about. Which shape applies is decided server-side; the
  console renders the plan's note instead of guessing.

### 5.4 Ledger

`applies` ring on the shared event-ring skeleton (`backend/src/utils/event-ring.ts`, ADR-0013
precedent), mirrored to `<ocrHome>/harness/applies.json` (cap 500, fail-open):

```ts
{ id: 'ha-…', ts: number, action: 'install' | 'remove', kind, artifactId, name,
  hosts: 'opencode,pi', command: string, outcome: 'ok' | 'partial' | 'failed', message: string }
```

`command` carries the exact subprocess echo for gate 3 and is empty otherwise; the row never archives
payloads or secrets. No config knob.

## 6. API surface

All under the existing `/api/admin/*` auth + CSRF gate. Reads are cheap; every write is plan-first.

| Method & path | Purpose | Notes |
| :--- | :--- | :--- |
| `GET /sources` | source registry + health | kind, trust, auth, `browsable`, `unavailableReason`, `hosts` |
| `GET /hosts` | host catalog as the console sees it | `hasSkills` / `hasMcp` / `hasExt`, the accepted `scopes`, roots + owner for each of them |
| `GET /applies` | last 100 ledger rows | `harness.json` mirror; no paging |
| `GET /inventory` | manifest + disk reconciliation | per-copy `state` + `removal` descriptors on discovered rows |
| `GET /browse?source&q&limit&harness&page` | marketplace browse | one normalized `MarketItem[]` for ONE 1-based `page`, plus `hasMore` and — when the source reports one — `total`; optional `note` + its `noteCode`/`noteParams`; 409 `unavailable` for a dead source |
| `POST /install` | resolve + write | MCP / plugin answer `confirm_required` with the plan first |
| `POST /plan` | dry run, `action: 'remove'` | returns `planId` + ops; writes nothing; 10-minute TTL |
| `POST /apply` | execute a removal plan | 409 when stale / unknown / needs `discardLocalEdits` |
| `POST /translate` | one description | cache-backed, via the gateway's own surface |
| `POST /translate-batch` | ≤50 descriptions | per-item errors, never one failure for the batch |
| `POST /translations` | cache-only seed for a page | no upstream call |

Removal plan response:

```jsonc
{
  "planId": "…",
  "action": "remove",
  "artifactIds": ["skill:github:owner/repo#tdd"],
  "actions": [
    { "op": "move-to-trash", "path": "~/.agents/skills/tdd", "host": "universal", "exists": true, "dirty": false },
    { "op": "drop-entry", "path": "…/opencode.json", "file": "…/opencode.json",
      "container": "plugin", "entry": "my-plugin", "host": "opencode", "exists": true }
  ],
  "external": [{ "path": "npm:@acme/plugin#pi", "host": "pi" }],
  "blocked": [],
  "warnings": [{ "code": "dirty-copy", "message": "copy has local edits", "path": "…" }]
}
```

`apply` refuses a plan whose targets disappeared or changed shape since the preview (`409 plan_stale`),
and a `dirty` copy requires `discardLocalEdits` — but only for `move-to-trash`: a config-member edit
does not destroy the hand edit, so it raises no warning.

## 7. Install flow — transactional per artifact

```
console                backend                          store / targets
  │ POST install ──────►│
  │                     │ resolve (cache) ───────────────────► source
  │                     │ shape-validate (name / spec / launch)
  │ ◄── confirm_required│  (mcp: added+changed keys · plugin: exact echo)
  │ confirm: true ─────►│
  │                     │ claim target paths (refuse foreign)
  │                     │ skill: stage into store ───────────► store
  │                     │        copy per host ──────────────► targets
  │                     │ mcp: createBackup → merge → atomic write
  │                     │ ext: run the echoed command / edit plugin[]
  │                     │ manifest upsert + probe + ledger
  │ ◄── result          │
```

The guarantee is **manifest last**: an entry only exists for a copy that landed, and a copy that fails
is removed and its claim released before the call returns. There is no write-ahead intent file and no
cross-copy rollback (a multi-host skill apply that dies midway leaves the copies it already wrote —
they are real, and the manifest names them when the retry runs).

MCP differs in the middle step: the "diff" is a key-level diff of the target config, and the writer is
`createBackup` → mutate → `safeWriteJson`. A config carrying comments (JSONC) is **refused** rather
than rewritten without them. **TOML is not offered** — this repo has no TOML library, so a codex MCP
write would mean hand-writing a comment-preserving TOML editor. Codex MCP is unsupported.

Plugins differ in the last step: instead of writing files, the backend runs the landing command
(`pi install npm:<pkg>`) with a timeout, captures stdout/stderr, and records the exit code. That command
executes npm lifecycle scripts — the confirmation says so verbatim, and `-y` is never passed. OpenCode
plugins are an array edit in `opencode.json` — a config merge.

## 8. Source adapters — many per kind, one standard shape

Every kind has several sources. A source is an adapter behind one interface; pages never hardcode a
source list (ADR-0015 §D6).

```ts
interface HarnessSourceAdapter {
  id: string;                                   // 'clawhub' | 'pi-dev' | 'npm' | 'github' | 'manual' | …
  kinds: HarnessKind[];
  auth: 'none' | 'oidc';
  trust: 'official' | 'aggregator' | 'community' | 'manual';
  search(q: string, cursor?: string): Promise<Page<RawSummary>>;
  get(key: string): Promise<RawDetail>;
  resolve(key: string): Promise<InstallPayload | undefined>;   // undefined = browse-only
}
```

Three-stage conversion, one direction, no source-specific JSX:

```
raw JSON ──► source normalizer ──► ArtifactSummary / ArtifactDetail ──► List | Card

```

The rows below record measurements at the stated date. Sources removed by later amendments (npm
browse, the MCP official registry, Smithery, skills.sh, the OpenCode catalogs) stay as measurement
history only; ADR-0015 §D6 is the shipped set.

Measured availability, 2026-10-24 — every adapter degrades to `unavailable` + reason instead of
throwing:

| Source | Kinds | Measured access | Shipped role |
| :--- | :--- | :--- | :--- |
| GitHub `owner/repo` | skill | search 10 req/min anonymous (`GITHUB_TOKEN` optional); tarball per install | **live**: the content source for every skill install |
| npm registry | skill, plugin | `/-/v1/search` → **200** anonymous | **live** for plugins (`installKind: plugin`); npm-as-skill resolves `unsupported_kind` |
| MCP official registry | mcp | `/v0/servers` → **200** anonymous, opaque cursor, `limit` ≤ 100; per-server read `/v0/servers/<name>/versions/latest` → **200** (bare path 404) | **live**: browsable catalog + authoritative identity and launch spec; rows install through the MCP merge writer |
| skills.sh | skill | `/api/v1/*` → **401** (Vercel OIDC only); `GET /api/skills/<view>/<n>` → **200** anonymous, 0-based pages of **200** rows with `total` (All-time **9 911**, Trending 9 959, Hot 6 765) and `hasMore`, which is exactly what the site's own leaderboard scrolls through; `GET /api/search?q=&limit=` → **200** anonymous, capped at **200** rows, `offset`/`page`/`cursor` ignored, terms under 2 characters refused | **live**, read from the site and never from its API: no query (or one character) reads the chosen board, 2+ characters search the WHOLE catalog through the site's own endpoint, and rows install through the GitHub writer as `github:<owner/repo>#<skill-dir>`. The `VERCEL_OIDC_TOKEN` the API asks for is minted inside a Vercel deployment with an hourly lifetime, so it is not an operator secret |
| ClawHub | skill | `/api/v1/skills?limit=&cursor=&sort=` → **200** anonymous, opaque cursor, own `sort` enum; `/api/v1/search?q=` → **200** anonymous, NO paging parameter (one answer = one window); `/api/v1/download?slug=&ownerHandle=&version=` → **200** deterministic ZIP (errors are plain text; a slug clash answers `409 AMBIGUOUS_SKILL_SLUG` and names `ownerHandle`); anonymous reads **3000/min/IP** with `Retry-After` | **live**: browsable catalog + search, rows install from the registry's OWN versioned store through the skill writer — the pin is `{clawhub:{slug, version}}`, `stars` stays `null` (its star system is a different unit), and a JSON 200 (the undocumented `public-github` handoff for GitHub-backed skills) is refused by name |
| Smithery | mcp | `GET /servers` + `GET /servers/<name>` → **200** anonymous; the listing serves **500** rows however it is sliced (page 26 empty) while claiming ~20 765 | **live**, and the one aggregator that HOSTS its records: a row installs the hosted deployment (`<slug>.run.tools`) with an `Authorization` env reference (measured `initialize` → 401 without that header). Holds launch authority for its own hosting only; a connection that declares required config is refused by name |
| PulseMCP | mcp | `api.pulsemcp.com/v0beta/servers` → **410** (retired) | no row, no adapter |
| mcp.so | mcp | `/api/servers` → **404** | no row, no adapter |
| OpenCode ecosystem | plugin | prose docs, no API | declared disabled, bound to `opencode` |
| manual | mcp, plugin | operator input | **not a source**: `manualPayload` / `manualSpec` on the install request |

Aggregation and identity live in §5.2. Rules that follow from the table:

- A source that cannot answer search still renders a tab — disabled, with the measured reason. It is
  never silently dropped, and it never blanks the aggregated list.
- An INDEX-only source may rank and describe; it may **not** supply an MCP launch spec. A source that
  HOSTS what it lists (Smithery) is the authority for its own deployments — and still loses to the
  official record when that registry carries the same server.
- The curated OpenCode list is declared disabled with `trust: community`; it is never presented as
  audited.
- Manual install stays first-class: `manualPayload` (MCP) and `manualSpec` (plugin) are the only
  paths that work offline and the only ones a user with a private payload needs.
- Source credentials come from the environment (`GITHUB_TOKEN` today); no token is ever written to the
  manifest or returned by an API response.

## 9. Security and honesty gates

1. **Preview is not optional.** An MCP or plugin install answers `confirm_required` with the
   plan first; a removal answers with a plan id before any write. Nothing runs on a bare request.
2. **Third-party content is data.** `SKILL.md` is never executed; it is written as a file.
3. **MCP servers are processes.** The confirmation shows the launch command, and the install sheet
   states that installing a server can execute code on this machine.
4. **No audit UI.** `ArtifactView.audit` is `null` in this build and no verdict is rendered — the
   console says nothing rather than showing an implied green check.
5. **Path containment.** Every resolved target path is proven inside its declared root
   (`adapter.skillTarget` refuses an escape), a skill name is sanitized to
   `^[a-z0-9]+(-[a-z0-9]+)*$` before it becomes a directory, and a `trash-path` removal descriptor is
   containment-checked against the known roots.
6. **No self-fan-out.** The planner writes only the hosts the operator ticked; it never multiplies
   targets on its own. An plugin is stricter still: exactly one harness, refused otherwise.
7. **Trust is stored, and shown as the source label.** `trust` travels on the record; the table shows
   the source (or "local"), never a badge that implies an audit. There is no cross-source conflict
   surface because there is no cross-source merge yet.
8. **Untracked is reported, never silently deleted.** A directory that looks like an artifact but has
   no manifest entry shows as `untracked` and is removable through a plan and a confirmation, exactly
   like a tracked copy — because a row the operator can see but cannot remove is the state this design
   rejects. (The "adopt into the manifest" action is not built.)
9. **Plugins install code.** `pi install` runs npm lifecycle scripts; the dialog says so verbatim,
   `-y` is never passed, and the exact command is recorded in the ledger.
10. **MCP secrets are named, never stored.** The server record contributes env **key names**; values
    come from the operator's environment. Harness never reads, writes, or logs a credential (ADR-0006
    stays untouched).

## 10. What shipped — and what deliberately did not

| Shipped | Notes |
| :--- | :--- |
| host catalog + root resolver + owner/alias rule | 14 rows; landing cells empty where unverified |
| per-env manifest v3 (no legacy migration) + machine-wide claims | no advisory lock |
| store (skills only) + trash snapshots | append-only, no GC |
| inventory (`clean`/`dirty`/`missing`/`foreign`/`untracked`) + discovery channel for every kind | `shadowed` has no producer; the scan reads skill directories, a runtime's `plugin[]`/`packages[]`/loose files, and the `mcp` object of a host config |
| skill writer, MCP merge (opencode), plugin (opencode `plugin[]` / pi subprocess) | plan → confirm → apply |
| probe-driven `placement` | `materialized` → `verified` with evidence only |
| removal ops keyed on landing shape | `move-to-trash` / `drop-entry` / `drop-server` / `prune-record` |
| source adapters: ClawHub (skills), pi.dev (plugins), operator git marketplaces (plugin/skill axes), GitHub + npm as install resolvers | ClawHub installs from its own versioned store; git marketplaces install through each runtime's own command chain |
| console: three pages, harness rail, installed/market tabs, list ⇄ card, description translation | — |

Not shipped — see ADR-0015 "Deferred" for the authoritative list: MCP landings beyond opencode,
plugin landings beyond opencode/pi/claude/antigravity/factory/kimi, npm-as-skill, the console
MCP install gate, config-declared sources, write-ahead intent, store/trash GC, adopt, harness
export/import, `canonicalKey` alias overrides, `shadowed`/`profile` producers.

**Name collisions were decided before the first write**: `name` is the directory name, and two
artifacts with different `canonicalKey` and the same `name` are **refused** (`exists`) — the operator
types a different name. No `name@hash` suffix: a suffix policy invented later means migrating
already-materialized copies and the manifest.

**Plugins are the highest-risk write** (npm lifecycle scripts = arbitrary code) and they are the
one that never fans out: one harness per apply, echoed command, no `-y`.

## 11. The simpler alternative (recorded, not taken)

**Doctor + command emitter** instead of an installer: scan every known root, diff against the
manifest, report drift/duplicates/orphans/conflicts, offer `adopt`; "install" becomes generating (and
optionally running) the vendor command — `npx skills add <spec> --agent <hosts>`, `claude mcp add …` —
with OCR recording the outcome.

Why it is attractive: cross-host inventory and drift detection are the gateway's unique value; package
management is not. `npx skills add` already implements multi-target install, and rewriting it trades
80% of the risk for 20% of the value.

Why not as v1: it cannot guarantee pinning (`commitSha`), cannot enforce the gate, and inherits the
vendor CLI's ordering. **Decision: hybrid, as shipped** — the read-only doctor half is native, the
writes are native too where a landing is verified (a `plugin[]` merge, an MCP merge), and the one
package-manager landing delegates to the runtime's own CLI (`pi install npm:<spec>`) with the command
echoed verbatim.

## 12. Verification plan

- `bun run typecheck` — backend + frontend, must exit 0.
- `bun run build` — full build.
- `bun run test` — backend suite; new tests must use the isolated runner (never `bun test backend/tests`).
- Unit targets: path resolver (all hosts × scopes), hash/dirty detection, manifest v3 shape gate (set-aside, no migration) +
  orphan retirement, remove-plan ops (`move-to-trash` / `drop-entry` / `drop-server` / `prune-record`),
  JSON/JSONC refusal, name sanitizer, per-source normalizers (fixture JSON, no network),
  `trash-path` containment, claims single-owner enforcement.
- Frontend: list and card views render the same row object — one shared shape, two layouts.
- Manual matrix: for each supported (kind × host) pair — install → inventory `clean` → hand-edit a copy
  → `dirty` → remove (trash op or config-member op) on a scratch `OCR_HOME`; plus one skill installed
  to three hosts and removed copy-by-copy, and one plugin removed while its `opencode.json` keeps
  another plugin.
- Dead-code audit: `npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters`.

## 13. Open items

- `dsh` row of the matrix: `dsh.ts` is profile-based, and no landing has been verified for it.
  Unsupported until one is.
- OpenCode global skills: `~/.agents/skills` (universal) or `~/.config/opencode/skills`; never both.
- Additional MCP landings (Claude, Cursor) must be verified against vendor docs before entering
  `HOSTS`; an unverified landing is not wired.
- `canonicalKey` alias override (catalog `overrides-store` precedent) — needed before any cross-source
  merge, otherwise dedupe would silently merge unrelated artifacts.
- Directory-name collisions: two sources can publish the same `name` for different `canonicalKey`.
  Today the second install is refused (`exists`); a `name@shortHash` policy would have to migrate
  already-materialized copies, so it stays a refusal.
- Inventory performance: mtime+size fast path, hash on demand. A full hash on every `GET` is banned.
- Per-source timeout + partial results for a future fan-out (single-source browse today).
- GitHub anonymous limits: 60 req/h for the API, 10 req/min for search — `GITHUB_TOKEN` is honoured,
  and browse caches for 60 s (a LEADERBOARD source keeps its board pages 10 minutes instead, because a
  ranking moves over days while skills.sh throttles a burst with `429 Retry-After: 60`; the refresh
  button bypasses either window).
- Windows: case-insensitive dedupe (two artifacts differing only by case), `MAX_PATH` guard. Today's
  writes are plain copies (never symlinks), so no elevation is required.

## 14. Description translation (derived, never i18n)

Third-party `description` text is CONTENT. It cannot live in `frontend/src/i18n/**`: those tables are
authored copy shipped with the build, while descriptions arrive from remote registries and from the
user's own disk. Translation is therefore a cache, not a translation table.

| Concern | Decision |
| :--- | :--- |
| Storage | `<env>/harness/i18n/descriptions.json` — derived, deletable, never authoritative |
| Key | `sha256(description) + ':' + lang` — an upstream edit invalidates its own entry, no manual busting |
| Model | pinned `lite`, one retry on `auto` when the lite attempt fails |
| Scope of egress | the description string only; a skill's `SKILL.md` body never leaves the machine |
| Target language | the console language at entry (no picker) — every shipped UI locale: `zh en es fr de ja ko pt` |
| API | `POST /translate` (one), `POST /translate-batch` (chunk of ≤50, pool of 3), `POST /translations` (cache-only seed) |
| Client-side pin | every in-memory entry records the source text it was made from; a rescan (or a market re-fetch) whose description differs discards the client copy instead of showing the previous wording |

The `lite` → `auto` retry is a harness-level SECOND request, not a routing-level cross-tier
downgrade: ADR-0014 keeps a forced tier a contract, and the pipeline fails over inside that tier
only. Keeping the retry here satisfies both — cheap by default, still working when the operator's
lite tier is empty — without teaching the router to jump tiers.

Batch translation walks the visible list in chunks of 8 from the console, so one slow tier cannot
stall a single request for a minute and a dropped connection resumes from the cache. Duplicate
descriptions are translated once and fill every row that shares them.

Verified with a fake gateway on loopback (2026-10-24): lite-refusal retried on `auto`, healthy lite
issued a single attempt, cached repeat performed zero upstream calls, pool peaked at 3 in flight,
blank/duplicate inputs collapsed before any call, and a config without an enabled key answered one
`409 no_api_key` instead of one failure per item.

## 15. Marketplace tab and GitHub install (slice T4/T3-lite)

The page has two tabs. `Installed` is the local inventory described above; `Marketplace` browses a
source and installs from it. They are tabs, not two pages, because installing produces exactly the
row the other tab lists — a tab switch is the shortest confirmation loop.

| Concern | Decision |
| :--- | :--- |
| Live sources | ClawHub (skills; its catalog + its own search endpoint, rows installing from the registry's own versioned store) and pi.dev's catalog (plugins) — the two built-in directories. Operator git marketplaces federate into the plugin/skill answer. GitHub and npm are install resolvers only (ADR-0015 §D6) |
| Normalized shape | the adapter maps a vendor payload to `MarketItem` once; the page never learns a vendor's JSON |
| Search budget | anonymous GitHub search allows 10 req/min, and the backend cache is keyed by the EXACT query string — so a distinct prefix is a distinct upstream call. The field therefore spends nothing while typing: a query reaches the network only when COMMITTED (Enter, a source switch, clearing the field), and committing the already-shown query is not a new axis (a repeated Enter costs nothing). Committed queries are still cached 60 s |
| Refresh | one button beside the source chips re-reads the SHOWN page under the current source/query/order — it sends `refresh=1`, and the backend evicts only that source's cache family before dispatch, so the rows come back newly read instead of 60 s old. The axis never changes (a re-search) and the page never moves (a re-page); while a read is in flight the button is disabled, so a second click cannot spend a second call |
| Paging | the console asks for `page=N` and never slices a response itself: ClawHub pages by its own cursor, pi.dev by its own `&page`, and an operator source by its snapshot slice — a console page is a slice of the upstream pages it straddles. `hasMore` — never "the page looked full" — is what enables "next", and the spinner runs from the commit over the dimmed previous page rather than a blank one. Both tabs render the SHARED pager (`frontend/src/components/Pagination.tsx`, summary + size selector left, page buttons right) — a page never grows its own pager. A source whose count is only a WINDOW answers `totalScope: 'window'`: the pager keeps the number for its page buttons but hides the summary, because "1-24 / 200" must not read as the catalog's size. ClawHub's SEARCH is that case (its endpoint has no paging parameter); its catalog pages by cursor chain |
| Download | one tarball request per install (`/repos/:r/tarball/:sha`), unpacked by a minimal tar reader. `raw.githubusercontent` is unreachable from some networks and the blob API would spend the whole hourly budget |
| Order of writes | store first (content-addressed by commit), then the host copy, then the manifest — a failure leaves no half-installed skill |
| Conflicts | an existing target or a foreign claim is refused before any download |
| Refusals | no `SKILL.md` → `no_skill`; several → `multiple_skills` with candidates (never guessed); >200 files or >8 MiB → `too_large` |

Verified against live GitHub (2026-10-24) in a sandboxed `OCR_HOME` with project scope (open at the
time; gated off since — ADR-0015 §D2 "Scope"): install wrote
12 files + `SKILL.md`, the store and manifest appeared, a second install answered `409 exists`,
inventory reported the copy `clean`, and the existing plan/apply path uninstalled it with the target
directory gone. Browse returned 6 items for `topic:claude-skills`; `skills.sh` answered `409
unavailable` with its reason (it now browses — the site's boards, not its API).
