# ADR-0015: Harness Artifacts — Skills, MCP Servers, Plugins

- **Status**: Implemented (recorded from current code, 2026-10-24)
- **Date**: 2026-10-24
- **Amended**: 2026-10-25 — the installed row's source cell names the BROWSE surface (the install
  source: `pi.dev`), falling back to the writer when the record carries no other surface (§D8.6).
- **Amended**: 2026-10-30 — operator git-marketplace sources (`mp-<slug>`): any GitHub repository
  becomes a browse/install source with no code change (§D9).
- **Amended**: 2026-11-01 — the source store is split by axis: `plugin-market.json` (bucketed per
  harness, `shared` = unpinned) and `skill-market.json` (one shared bucket); the flat
  `marketplaces.json` migrates once and is renamed `marketplaces.legacy.json` (§D9). The duplicate
  answer is store-wide and names the holding entry's harness/layer; adding a repository another
  harness already carries from this tab registers a harness-scoped second source
  (`mp-<repo>-<harness>`). A slug is one `mp-` sourceId, so per-harness isolation never widens
  identity.
- **Related**: ADR-0010 (definition ownership + materialization targets), ADR-0006 (credential store —
  never read by this domain), ADR-0013 (observation-ledger precedent), ADR-0007 (environment layout,
  trash-based delete)

## Context

The gateway already owns a **client** relationship with eight runtimes (`SupportedClient`: `opencode`,
`opencode-proxy`, `claude`, `codex`, `pi`, `dsh`, `omp`, `grok`). That relationship is about **traffic**: an adapter
writes the runtime's model/auth config so requests flow through the gateway, and stops there.

What the runtimes can additionally be given — **skills** (instruction folders), **MCP servers** (tool
backends), **plugins** (runtime plugins/packages) — is otherwise installed by each vendor's own
CLI, into vendor-specific directories, with no record inside the gateway. Three consequences:

1. Operators cannot see what is installed where; the same skill is often copied into four directories
   that then drift silently.
2. The three kinds have **different write semantics** — file-tree drop, config merge, package install.
   Treating them as one "install" button is a data-loss class.
3. Source catalogs disagree about accessibility: some are anonymous JSON, some require OIDC or a key.

This record freezes the shipped model: the host catalog, the ownership layers, the write gates, the
removal ops, and the discovery channel. Everything described here exists in
`backend/src/harness/` and `backend/src/routes/harness.ts`; the **Deferred** section lists what
deliberately does not.

## Decision

### D1 — Vocabulary: `client` is traffic, `harness` is capability

| Term | Means | Lives in |
| :--- | :--- | :--- |
| client | a runtime hooked to the gateway (model + auth config) | `<runtime config>`, e.g. `opencode.json` |
| harness | that client considered as an **artifact host** (skills / MCP / plugins) | `<ocrHome>/harness/` |
| artifact | one installable unit of a given kind | manifest record + materialized copies |

`opencode-proxy` is a **hook mode of the same runtime**, not a second artifact host: the harness domain
exposes exactly one `opencode` target. Harness state never enters the routing truth chain, never touches
credentials (ADR-0006), and never reads provider definitions (ADR-0010).

### D2 — Host landings live in one adapter per host

Two files share the table, with a hard split:

- `hosts.ts` answers **which hosts exist, in which order, called what** (`HOSTS`: id + label only).
- `adapters/<host>.ts` answers **what this runtime reads and how it is written** — one file per host,
  every landing path spelled exactly once. `adapters/declarative.ts` holds the shared rules
  (`defineHost` + the `SkillsHost` / `McpHost` / `PluginHost` builders), so a wrong path is one
  small file's data bug and a wrong rule is one implementation bug.

Capabilities are **separate interfaces**, not nine methods on every host: fourteen hosts have a skills
location, one has a verified MCP landing, six have a verified plugin landing. A host that cannot do
MCP never implements `McpHost`, so absence is a type fact instead of a runtime `unsupported` throw.

Version differences are a **ladder inside one adapter**, never a second adapter: `opencode` v1 vs v2
differ in landing spellings only, and plugin identity is `plugin:<harness>:<canonicalKey>` (spelled `extension:…` in manifest v1/v2)
(§D7) — two adapter ids would split one installed plugin into two artifacts exactly when a machine
carries both spellings during a migration.

Global roots derive from `os.homedir()` and `XDG_CONFIG_HOME` (fallback `~/.config`); project roots
are repo-relative and resolved against the gateway process's cwd — declared, but not reachable while
`ENABLED_SCOPES` is `['global']` (see **Scope** below). Only the cells below have a landing;
a kind × host cell that is empty is refused at resolve time rather than guessed.

| Host | Skills: global / project | MCP landing | Plugin landing |
| :--- | :--- | :--- | :--- |
| universal | `~/.agents/skills` / `.agents/skills` | — | — |
| opencode | `$XDG/opencode/skills` / `.agents/skills` | `opencode.json` · `mcp` | v1 `opencode.json` · `plugin[]` · `plugin/`; v2 `opencode.jsonc` · `plugins[]` · `plugins/` |
| claude | `~/.claude/skills` / `.claude/skills` | — | `claude plugin install <id> --scope user` (subprocess); record `~/.claude/plugins/installed_plugins.json` · `plugins` map (§D8.11) |
| codex | `~/.agents/skills` / `.agents/skills` | — | — |
| pi | `~/.agents/skills` / `.agents/skills` | — | `pi install npm:<spec>` (subprocess) |
| dsh | — | — | — |
| omp | `~/.omp/skills` (relocated by `PI_CONFIG_DIR`) / `.omp/skills` | — | — |
| cursor | `~/.cursor/skills` / `.agents/skills` | — | — |
| github-copilot | `~/.copilot/skills` / `.agents/skills` | — | — |
| gemini-cli | `~/.gemini/skills` / `.agents/skills` | — | — |
| cline | `~/.agents/skills` / `.agents/skills` | — | — |
| amp | `$XDG/agents/skills` / `.agents/skills` | — | — |
| windsurf | `~/.codeium/windsurf/skills` / `.windsurf/skills` | — | — |
| zed | `~/.agents/skills` / `.agents/skills` | — | — |
| grok | `~/.grok/skills` / `.grok/skills` | — | — |
| antigravity | — | — | `.antigravity-plugin/plugin.json` (`agy plugin install <url>`) |
| factory | — | — | `.factory-plugin/` (`marketplace.json` + `plugin.json`; `droid plugin marketplace add <url>`) |
| kimi | — | — | `.kimi-plugin/plugin.json` (`/plugins install <repo-url>`) |

- **Most hosts read, few hosts own.** Ten hosts read the project `.agents/skills`; one directory is
  one copy, so `skillOwner()` (first adapter in registry order resolving to that path) decides the
  recorded host and every other host is an alias. Install, inventory and the console all use that rule.
- **Ownership and readership are two answers, and the console asks both.** `skillOwner()` answers "who
  owns this copy" (install target, claims, removal); `skillReaders()` answers "who can LOAD it"
  (`CopyView.readers`, owner first). The skills page's harness rail renders TWO containers with ONE
  shared order — a pure function of the host catalog, so no interaction can reshuffle either block:
  `universal` pinned first, then the ONE-CLICK hosts (the backend `ClientAdapter.harness` set) anchor
  to the Clients page's adapter order, everything else follows a curated popularity table (catalog
  order breaking ties). The primary container shows `universal` plus the one-click hosts whose
  presence markers fire (`hostDetected`); the second container holds every other runtime — even a
  detected one the one-click integration does not cover — and only MOUNTS on one "load more" click,
  APPENDED after the primary block, never interleaved. Writes stay owner-only
  (`KIND_META.skill.installAxis = 'skills-owner'`): the rail is a lens, never a fan-out permission.
- **Presence is measured, and undetected hosts leave the rail.** Each adapter declares `presence`
  markers — an executable name probed on PATH and/or its config directory — and `hostDetected()`
  answers from those markers plus the existence of any of the host's global skills roots (a runtime
  that left its skills tree behind stays visible, or its copies would become unmanageable). Whether
  the console rail shows a host is the rail bullet above: one-click membership plus presence.
  `universal` is always detected, so a machine with no runtime installed still has a landing spot.
  The catalog itself stays static — presence is a per-machine measurement on the hosts endpoint,
  never a membership change in `HOSTS`.
- **Roots are measured through this process.** `adapter.skillRoots(ctx, scope)` answers candidate roots
  with `origin: 'default' | 'env-override'` and a precedence index; `OPENCODE_CONFIG_DIR` relocates
  opencode's root and `PI_CONFIG_DIR` relocates omp's (DSH declares `DSH_HOME` but has no skills
  landing). A runtime launched from a shell
  with a different override is invisible here, so a copy on a lower-precedence root is **never**
  reported as "not read".
- **`host ≠ SupportedClient`.** Cursor/VS Code/Zed/Windsurf are artifact hosts that will never be
  traffic clients; the traffic enum is not widened for them.
- **Scope — global only; project scope is deferred, not deleted.** The accept list is one constant,
  `ENABLED_SCOPES` (`harness/scopes.ts`), and it holds `['global']`. Everything product-facing reads
  it: the install route refuses anything else (`unsupported_scope`), `scanInventory` never reads or
  scans a project skills root / plugin source / MCP landing, and the console offers no scope choice
  (it always sends `global`). The seam is what the adapters already declare — `SkillsSpec.project`,
  `configProject`, `looseDir.project` stay spelled exactly once per host — plus the writers' `scope`
  parameter, so shipping project support is that list plus the console selector. The removal guard
  keeps BOTH scopes: a copy that landed inside a repo before the gate existed is still removable.
  A skill name is normalized to `^[a-z0-9]+(-[a-z0-9]+)*$` and the resolved target must stay inside
  its root (`adapter.skillTarget` refuses anything that escapes).
- **`readsUniversal`** records whether a runtime reads the cross-agent `.agents` directory natively;
  it decides the alias/owner relation and which hosts can take a skill copy without a vendor-specific
  write.
- **The shared set has exactly one exclusion, and it is ON by default.** A pinned skills page shows
  every row its runtime can LOAD, so the rows owned by `universal` (the shared `.agents` tree, read by
  ten runtimes) repeat under every rail entry and crowd out the rows that ARE private to the pinned
  runtime. A `hideShared` switch narrows them out by copy ownership (`row.hosts` contains the shared
  host). It is a facet, not a mode — it narrows the same list the source chips count from, so every
  chip number stays honest — and it is absent where it would mean nothing: on MCP/plugin pages (no
  shared landing exists there), on the shared entry itself (it would empty the list it is meant to
  narrow), and on a page where nothing private would remain. That last gate guards the DEFAULT too:
  the switch ships ticked, so a runtime whose skills all live in the shared tree still opens on its
  full list. The switch carries the count it is hiding, so a hidden set is always accounted for.

### D3 — Skills path rules

- **R1 — no double write.** OpenCode reads `~/.agents/skills` natively; writing both it and a
  vendor directory would create two sources of truth. The planner never fans out on its own: the
  operator names the hosts.
- **R2 — one declaration per path.** A landing path appears exactly once, inside the adapter of the
  host that owns it. A second table — whether another module or another adapter — is a drift twin and
  is deleted on sight. Skills stay location-level in that adapter set: several hosts read
  `.agents/skills`, so the shared directory is declared by `universal` and *referenced* by every
  `readsUniversal` host, never re-spelled.
- **R3 — XDG is honoured where it is declared.** Global roots use `XDG_CONFIG_HOME` for the `$XDG/*`
  rows; the rest are literal home paths, as the vendors document them. The one ladder that is not
  spelled in an adapter is opencode's config file list: `opencodeConfigCandidates` in the credential
  layer is the single table for it (ADR-0006/0010), and the adapter references it rather than copying
  it.

### D4 — Ownership: manifest is the truth, directories are materialized

| Layer | Path | Holds | Shared? |
| :--- | :--- | :--- | :--- |
| intent | `<envRoot>/harness/manifest.json` | what this environment has installed, per copy | per environment |
| claims | `<ocrHome>/harness/claims.json` | `path → {env, artifactId}` — one path, one owner | machine-wide |
| store | `<ocrHome>/harness/store/<storeKey>/` | one skill payload per content key | machine-wide |
| trash | `<ocrHome>/harness/trash/<ts>-<planId>/` | removal snapshots | machine-wide |
| translation | `<envRoot>/harness/i18n/{descriptions,readme}/<sha256>.<lang>.json` | derived translation store — ONE FILE PER ENTRY; the pre-split `i18n/descriptions.json` blob is read once and promoted | per environment |

- The manifest is **per environment**, never one file shared by envs and by desktop + CLI. It is
  written atomically (tmp file + rename).
- **A read that cannot produce the real records never answers "empty".** Every writer rewrites the
  manifest whole, so an empty fallback over an unreadable file would be persisted as the new truth.
  A read error (a transient Windows lock) fails the operation; bytes that are not valid JSON, or a
  file whose shape is not a known manifest version, are moved aside to `<file>.corrupt-<ts>` and the
  operation continues on a fresh file — the bytes survive, nothing is silently eaten.
- **One materialized path has exactly one owning environment.** `claimPath` refuses a path claimed by
  another env; the same env may re-claim. A copy whose path is claimed elsewhere reports `foreign` and
  may only be adopted through a transfer — never a second claim, never a silent delete.
- The **store is written by the skill writer only**: payload files stage into `<storeKey>.tmp-*` and
  are promoted by rename, then copied per target. MCP and plugin writes have no store blob — they
  edit a config file or run a package manager.
- **Manifest v3** carries the artifact-level `harness` for plugins and spells the kind `plugin`
  (renamed from `extension`, §D2). There is deliberately NO legacy migration: a pre-v3 file is set
  aside like unparsable bytes and a fresh v3 manifest starts empty — installed artifacts are simply
  re-installed from their sources. (v1/v2 spelled the kind `extension:`; the migration machinery —
  per-host splitting, `manifest.orphans.json` — was retired with the rename, 2026-10-30.)
- **The record carries the SOURCE's one-line `description`** (optional; absent when the source claims
  none). The console prefers installed text — a skill's `SKILL.md` is read at view time — and falls
  back to this field for kinds whose copy has no file of ours to read: an npm package living in the
  runtime's store, an MCP entry inside a host config. Discovery rows (the runtime's own installs) read
  the package's OWN `package.json` `description` from the runtime store: a local file read, never a
  registry round-trip, so a full machine stops rendering as blank cards without turning a rescan into
  N network requests.
- **A local plugin row describes itself from its own material**, so hand-placed plugins are not
  blank cards either. A path naming a DIRECTORY answers from that directory's `package.json`
  `description`; a path naming a FILE answers from its first block comment's first paragraph (capped
  at 300 characters, folded to one line). No header comment and no manifest means `null` — this is a
  read of what the author wrote, never a guess, a filename-derived phrase, or a registry lookup.
- **No GC.** Store and trash are append-only; deleting "unreferenced" blobs would delete someone's
  rollback. A manual prune is the escape hatch.

```jsonc
{
  "version": 2,
  "artifacts": [{
    "id": "plugin:opencode:npm:@acme/plugin",   // <kind>:<canonicalKey>, harness for plugins
    "canonicalKey": "npm:@acme/plugin",
    "kind": "plugin",
    "harness": "opencode",
    "name": "@acme/plugin",
    "description": "One-line description the source claimed",  // optional, absent when none
    "sourceId": "npm",
    "pin": { "npm": { "integrity": "sha512-…" } },
    "contentHash": "sha256:…",
    "listedOn": ["npm"],
    "trust": "community",
    "copies": [{
      "scope": "global",
      "host": "opencode",
      "rootId": "default",
      "path": "~/.config/opencode/opencode.json",   // or a token when `external`
      "contentHash": "sha256:…",
      "placement": "verified",
      "installedAt": "2026-10-24T00:00:00.000Z"
    }]
  }]
}
```

- **Pin is a union, not a ref.** `{git:{commitSha}}` for repo-sourced skills, `{npm:{integrity}}` for
  packages, `{clawhub:{slug, version}}` for ClawHub skills (the registry stores its own versioned
  archives, so the version of the deterministic download is the pin), `{adopted:true}` when there is
  no upstream claim to verify. `ref` alone is never a pin.
- **`placement` is a separate axis from `state`**, and only a probe upgrades it (D8.8).

### D5 — Three write modes, three gates

| Kind | Write mode | Gate |
| :--- | :--- | :--- |
| skill | file-tree drop (`<name>/`, N files) | resolve targets, refuse `exists` / `foreign`, stage-then-copy |
| mcp | **config merge** into `opencode.json` `mcp` | added/changed keys shown, `confirm: true` required, `.bak.ocr` + atomic write |
| plugin | `plugin[]` array edit **or** `pi install npm:<spec>` — exactly one harness | command echoed verbatim, `confirm: true` required, no `-y`, 120 s timeout |

- **An plugin targets one harness, never several.** Installing to two runtimes is two installs and
  therefore two artifacts: the backend refuses `hosts.length !== 1` for `kind: plugin`.
- **A merge never rewrites a file it cannot round-trip.** A config with comments (JSONC) is refused,
  not stringified-away; `createBackup` writes `.bak.ocr` before the atomic rename.
- **Subprocess installs execute third-party code.** The plan echoes the exact command, the runner never
  appends `-y`/`--yes`, output is captured, and the exit code is recorded.
- **Order of writes.** Skill: claims → store staging → per-copy `cpSync` (a failed copy is removed and
  released) → manifest last. MCP: claim → merge → backup/write → manifest last. Plugin: run/merge →
  manifest last. A manifest entry therefore only ever exists for a copy that landed.
- **Removal op follows the landing shape, never the provenance:**

  | Landing shape | Op | What is destroyed |
  | :--- | :--- | :--- |
  | file tree, loose plugin file | `move-to-trash` | the tree, into `trash/<ts>-<planId>/` |
  | one string in a JSON array (`plugin[]`, pi `packages[]`) | `drop-entry` | that string; `.bak.ocr` first |
  | one member of a JSON object (a server in `mcp`) | `drop-server` | that member; `.bak.ocr` first |
  | package copy with no declaration file | `prune-record` | the record only |

  A copy whose `path` is a **config file** is never trashed: `opencode.json` holds every other server
  and plugin, so moving it would delete configuration that is not ours. A `trash-path` descriptor from
  a discovered row is containment-checked (it must sit directly under a known skills root or a host's
  declared loose-plugin directory) — a path-safety rule, not an ownership ceremony.

- **Removal is plan → confirm → apply**, with a 10-minute plan TTL. Apply re-checks that every
  non-`drop` target still exists, refuses a `dirty` copy without `discardLocalEdits`, and writes the
  manifest only after every filesystem op succeeded. Every applied artifact gets one `applies` ledger
  row (`remove`), including a `prune-record` that leaves no disk trace.
- **A claim is released only when the path was destroyed** (`move-to-trash`). A config member edit
  leaves the file in place, usually holding other artifacts.

### D6 — Sources are adapters, and each one states what it can do

`registry.ts` holds the adapters that can produce a payload; `SOURCES` in `common/source-views.ts` is
the view the console renders (composed from each built-in directory's own declaration). A source
present in the view but absent from the registry answers `unsupported_source` instead of pretending.

| Source | Kinds | Access (measured) | Role |
| :--- | :--- | :--- | :--- |
| GitHub `owner/repo` | skill | anonymous, 10 req/min search, `GITHUB_TOKEN` optional | the content source: tarball per install, 200 files / 8 MiB caps |
| npm registry | plugin, mcp | anonymous 200 | INSTALL RESOLVER ONLY (browse directory removed, owner decision 2026-10-31): a `npm:<pkg>` handle resolves to a launch over the pinned spec (`npx -y <pkg@version>`, version + `dist.integrity` recorded — no author runtime arguments exist off-registry, so none are invented); pi.dev rows install through it. npm-as-skill resolves `unsupported_kind` |
| pi.dev package catalog | plugin | anonymous 200, server-rendered HTML — no JSON API; 50 cards per page, addressed by its own `&page` | official Pi catalog, bound to `pi`; browse-only: every row prints its own `pi install npm:<pkg>`, so the key is `npm:<pkg>` and install runs through the npm source |
| ClawHub | skill | `GET /api/v1/skills?limit=&cursor=&sort=` (cursor-paged, its own `sort` enum), `GET /api/v1/search?q=` — NO paging parameter, one answer is a window; `GET /api/v1/skills/<slug>?ownerHandle=` → one skill's own record (`skill.description` IS the published `SKILL.md`, plus `latestVersion`, `stats`, `owner`); `GET /api/v1/download?slug=&ownerHandle=&version=` → deterministic ZIP bytes; anonymous reads 3000/min/IP with `Retry-After` (measured 2026-10-25) | **live**, and the one skill registry that installs from its OWN store: rows carry no GitHub repo, so the pin is the registry version (`{clawhub:{slug, version}}`) and `stars` stays `null` — the registry's own star/download/install tally travels in `registryStats` (its own unit, labelled as ClawHub's) instead of being relabelled a GitHub count. `ownerHandle` is the disambiguator the registry's own 409 error names — undocumented on the endpoints but measured working (a wrong owner answers 404). A 200 that answers JSON is the registry's `public-github` handoff for GitHub-backed skills; its shape is undocumented, so the adapter refuses it by name |
| manual | mcp, plugin | operator input | escape hatch: `manualPayload` (MCP) / `manualSpec` (plugin) |

There is NO browsable MCP directory today (`MCP_DEFAULT_VIEWS` is empty): the official registry,
Smithery and the OpenCode catalog adapters that earlier revisions listed were removed with the
standalone browse directories. An MCP row still arrives through a host's own view or an operator
source; the axis keeps its own (empty) registry so a future directory is never declared in the
plugin table.

- **One normalized payload.** The writer never sees a source: skill → `{files}`; mcp → `{launch}`;
  plugin → `{spec}`. A source that cannot produce a payload is browse-only and says so.
- **Caps bind EXPANDED bytes, before any decompression.** A declared compressed length is not a
  memory bound (deflate reaches ~1000:1): the file count is read from the archive's own directory
  record and every inflate call is limited to the remaining budget, so an oversized payload is
  refused with `too_large` instead of materializing in the gateway process.
- **A source can be harness-bound.** `hosts?: HarnessHostId[]` narrows an adapter to the runtimes whose
  landing its payload can feed; the console renders its chip only on those pages and install refuses
  the others.
- **The view order is the noise order.** The `SOURCES` array is both the console's chip row and its
  landing priority: per axis, the market opens on the FIRST enabled+browsable source. **Two built-in
  directories remain (owner decision, 2026-10-31):** ClawHub for skills and the official pi.dev
  catalog for plugins, plus operator git marketplaces joining per slug. npm and GitHub search were
  removed as discovery surfaces with their adapters in the same commit — they remain INSTALL
  RESOLVERS on the host axis (a `github:<owner/repo>#<dir>` or `npm:<pkg>` handle must still
  resolve — they are just not discovery chips).
- **Sources are code-configured, not user-configured** (see Deferred).
- **A catalog source may answer ANOTHER source's identity, and must earn it.** A row cannot invent
  an install handle: the earning rules live once, in `common/npm-catalog.ts` (a declared package
  name, sanitized candidates, then registry verification against the package's own `repository`
  field — never "a package with this name exists"). The resolved payload is the npm adapter's, so
  the artifact's `canonicalKey` is `npm:<pkg>` and one package has ONE identity no matter which
  catalog surfaced it. `sourceId` records where the row was DISCOVERED — that is provenance, not
  identity, which is why the plugin writer derives `ref` from the key itself instead of slicing by
  the requesting source's name. A catalog whose rows carry ANOTHER source's key (the Pi catalog
  installs as `npm:<pkg>`) would lose that provenance through `sourceId` alone, so the install
  request also carries `listedOn` and the record keeps both (D8.6).
- **A catalog may be READ FROM HTML when that is all it publishes.** `pi.dev/packages` (the official
  Pi catalog) is server-rendered and documents no API, so `plugin/adapters/pi-dev.ts` keys off the
  machine-readable attributes the catalog's own filter/sort script consumes (`data-package-card`,
  `data-package-name`, `data-package-types`, `data-package-date`, `data-package-path`) plus the printed
  `pi install npm:<pkg>` command — the catalog's own statement of what a row installs. That contract is
  unversioned and undocumented, so the reader fails LOUD: a page with neither package cards nor the
  result-count marker, or cards that yield no package name, answers `upstream`, never an empty market.
  The market lists that catalog ROW FOR ROW: every row — plugin, untyped bundle, skill, theme,
  prompt — installs with the same printed command (`pi install npm:<pkg>`) into the same runtime
  package store, so nothing is dropped, and the catalog's own count is therefore an exact `total`. A
  row's type chips are the catalog's vocabulary, not this market's kinds. The card's
  `data-package-downloads` orders the page upstream and is deliberately NOT copied into the market's
  `stars` field.
- **"No popularity signal" is `null`, never `0`.** No shipped browse source publishes a GitHub star
  count: ClawHub answers its own download/star tally in `registryStats` (its own unit) and pi.dev's
  download count is a different measure again, so those rows carry `stars: null` and the console
  renders an em dash. Printing `0` would assert "nobody starred this", which none of those sources
  ever said. A row that NAMES a repository can still acquire a real count,
  but only ON DEMAND (`harness/common/stars.ts`, `POST /api/admin/harness/market/stars`): browse never spends
  star quota on the operator's behalf. The resolver batches — GitHub's search endpoint accepts several
  `repo:` qualifiers in one query, so a 24-row page costs ~3 requests instead of 24, chunked by the
  query's character budget rather than a fixed count — caches each answer for minutes so paging back is
  free, and answers the repositories GitHub does not index in `missing` instead of folding them into a
  zero. Anonymous search is 10 requests/minute; `GITHUB_TOKEN` raises it, and it is the same header the
  browse reader uses.
  **Paging is the catalog's own**: 50 cards per page behind its `&page` parameter, and the grid's count
  marker (`1-50 / 286 (of 5338)`) answers both the total and "is there a next page" — parsed, never
  probed by an extra request. Because the market keeps every row, catalog row `i` IS market row `i`, so
  a console window maps arithmetically onto the one or two catalog pages it straddles (24 rows < 50
  cards): any depth costs at most two fetches, with no walk from the first page, no cap and no
  duplicate/skipped rows, and each catalog page is cached for the shared 60 s window. The adapter
  reports the source's `total` and `hasMore`, so the console renders this market with the SHARED pager
  (summary `1–24 of 5338` + the page strip) instead of a per-source special case.
- **Ordering is the SOURCE's, never the console's.** Each source declares the orders it can actually
  serve (`sorts` on `GET /sources`) and the console renders exactly that list; the chosen key travels
  to `/browse` as `sort` and is validated against the declaration before any adapter sees it, so an
  order the upstream cannot serve is dropped rather than forwarded. Where a source publishes a
  contract, the console offers its WHOLE official set — never a tasteful subset: GitHub gets all four
  documented values (`stars` / `forks` / `updated` / `help-wanted-issues`, plus best-match by OMITTING
  the parameter), and the pi.dev catalog gets the three orders its own sort control offers
  (`downloads` / `recent` / `name`, i.e. `?sort=` values that measurably reorder the page). A catalog the BACKEND reads whole
  (the curated snapshot, awesome-opencode, opencode.cafe) is ordered over every matched row before it
  is sliced, so `name` there is a true global order. Nothing is ever
  re-sorted in the console, and a source with one order (or none) gets a plain label, not a dead
  dropdown: a page-local re-sort would claim a global order that nobody computed.
  (npm's server-side window sort left with its browse directory, 2026-10-31.)
- **Browse cache is 60 s**, because both live directories are anonymous reads and every keystroke
  would otherwise spend one. The cache is keyed by the EXACT query string, so a distinct
  prefix is a distinct upstream call — which is why the console commits a query (Enter, source
  switch, clear) instead of searching on input: typed text never reaches the network. A single dead
  source answers with its reason and never blanks the page. The console can also force a re-read: its
  refresh button sends `refresh=1`, and `browseSource` evicts THAT source's cache family
  (`evictBrowseCache`) before dispatch, so a still-warm window cannot answer a request that means to
  be new — and refreshing one catalog never discards another's warm window. The refresh button still bypasses that window (the eviction is
  unchanged), and search answers keep the shared 60 s. A failed read also names
  a `reason`
  (`network`, `timeout`, `http`, `rateLimited`, `unavailable`, `markupChanged`, `badPayload`,
  `unsupportedSource`) that the console translates through `harness.browseError.*`, keeping an
  English `message` only as the fallback for a reason it does not know — the same "backend states the
  fact, console owns the words" rule the market notes follow. The runtime's own text never reaches an
  operator (it names no subject and prescribes a fetch option the console cannot set), and the coarse
  failure class stays in `code`, which is what callers branch on.
- **A market read retries EVERY failed answer, not just the transient-looking ones.** Every market
  fetch goes through ONE helper (`harness/net.ts` → `fetchWithRetry`), because the same policy
  spelled out per reader would drift the day one of them learns a new status. The policy
  (`MARKET_RETRY`) is 5 attempts, 400 ms then doubling between them (±20 % jitter), 6 s per attempt
  and a 30 s TOTAL budget — the operator-accepted ceiling (2026-10-25; the earlier policy was 3
  attempts inside 10 s). The budget is the contract and `attempts` is the ceiling: an attempt's
  deadline is whatever remains of the budget, so a fast-failing endpoint gets all five asks inside
  ~7 s, while a hard-hanging one gets about four full tries and the operator hears `timeout` when
  the 30 s are gone — never later, because the budget caps the sleeps too. Retried:
  a thrown network error and EVERY status, `4xx` included — a transient `404` from npm's CDN while
  a publish propagates and a burst `403`/`429` window shorter than the backoff are both real, and
  the 10 s budget bounds what a dead-end retry can cost (revised 2026-10-25: the earlier policy
  never retried `403`/`429` or any other `4xx`). The one early return left is a `Retry-After` the
  remaining budget cannot fit — the server named a wait the policy cannot honor, so another ask is
  provably futile; a `Retry-After` that fits floors the next sleep instead. Still never retried: a
  payload that did not decode (`badPayload` / `markupChanged` are ANSWERS, not blips). The helper
  hands back the LAST response instead of swallowing it, so each reader keeps mapping statuses to
  its own `reason`; when every attempt threw, the last error is rethrown and the existing sentence
  is unchanged. Reads only — an install keeps its single attempt, because a write path must not be
  replayed behind the operator's back.
- **A row's DETAIL — market OR installed — is read server-side, never framed.**
  `GET /api/admin/harness/detail` answers
  the long-form half of one row — README, licence, latest version, publish date — from the npm
  registry document and, when that carries no body (or the row has no package at all), from the
  repository (`api.github.com/repos/<repo>` plus `/readme`). A `clawhub:<owner>/<slug>` row takes
  neither of those paths: that registry stores its own skills and names no repository, so its
  long-form half is the registry's per-skill record (`GET /api/v1/skills/<slug>?ownerHandle=`), whose
  `skill.description` IS the published `SKILL.md` (frontmatter stripped before rendering) and whose
  `latestVersion`/`stats` supply the version, licence, dates and counters. Those counters — ClawHub's
  own stars, downloads, installs — travel in `registryStats`, never in `stars`: the star column means
  a GitHub count, and its tooltip says whose number it shows. An INSTALLED row opens the same dialog:
  its subject is derived from `canonicalKey` (`npm:<pkg>` → the registry document, `github:<owner>/
  <repo>#<dir>` → the repository, `clawhub:<owner>/<slug>` → the registry record), so "what did I
  install and what does it document" is one click on either tab. A row with no public identity
  (`manual:<name>`) still opens, with its local metadata and no body — the dialog states what it knows
  instead of refusing. The console renders it in a
  NATIVE dialog because embedding the source page was measured impossible (2026-10-25: `github.com` answers
  `X-Frame-Options: deny`, `www.npmjs.com` answers `SAMEORIGIN` behind a Cloudflare challenge, `pi.dev`
  answers `SAMEORIGIN`; the community sites that are framable have rows pointing at GitHub anyway).
  The endpoint builds its upstream from the row's DECLARED identity — the package name inside
  `npm:<name>`, a validated `owner/repo`, and the `clawhub:<owner>/<slug>` pair — and never from the
  row's `url`: an admin GET that
  followed a caller-supplied URL would be an SSRF proxy. Every half is validated at that boundary
  (`safePackageName` refuses traversal, extra segments and a bare `@scope`; `safeRepoSlug` and the
  ClawHub pair refuse a URL and `.`/`..`). A row with nothing readable still answers (`readFrom: 'none'`, README `null`),
  because the dialog is built on the row the browse answer already carried; a refuse/throttle names a
  translatable `reason` (`rateLimited` for GitHub's anonymous budget, `http` with the status) and keeps
  the English `message` as the fallback. READMEs are capped at 120 000 characters and cached 10
  minutes — longer than the browse cache, because a body does not change per keystroke and the
  anonymous GitHub budget is 60 requests/hour; a FAILED read is never cached, so the next click is a
  fresh attempt budget rather than a ten-minute dead end. The dialog is a 900 px card by default and full-screen is
  the operator's own toggle, never the default. It can also TRANSLATE that body: `format: 'markdown'`
  on the translate route selects a LONG-FORM contract — its own system prompt (the description prompt
  would answer a 3 000-word page with two sentences), prose runs chunked at 4 500 characters, fenced
  code copied verbatim rather than trusted to a model, and a 20 000-character budget after which the
  tail comes back in the source language with `truncated: true`. A run is never half-translated —
  replacing a partially translated run would drop its tail from the document — and the result is
  cached as its OWN entry file (`i18n/readme/<sha256>.<lang>.json`) keyed by the full source, so
  re-opening the dialog spends nothing and dropping one page's translation never touches another's.
  Which model spends that quota is operator config: `defaultModels.translation` (any gateway-visible
  modelRef) names the primary and the `lite` alias is the tail; `auto` never appears unsolicited —
  an internal, non-critical call must not have unbounded spend, so a failing chain errors honestly
  instead of escalating (an operator who explicitly writes `auto` accepts that cost). The console's
  default-model picker carries a chain probe (`POST /api/admin/harness/translations/probe`): it
  fires this real chain over a one-line payload — the PICKER'S PENDING value, so the operator
  tests BEFORE saving (an empty selection tests the plain `lite` tail) — reports which model
  served, and never writes the cache; an explicit click is the explicit one-call spend.
  The store is SWEPT: entries expire at 90 days, then the oldest are trimmed until the whole store
  fits a 32 MiB budget — at most once an hour after a write, on demand via
  `POST /api/admin/harness/translations/prune`, and a crashed write's temp file is removed after an
  hour. The pre-split blob goes too once IT passes the same age budget (its mtime is the last write of
  the old build; leaving it would let it outlive every entry it produced). Re-opening a previously translated page reads its entry through the cache-only batch
  endpoint (`format: 'markdown'`), so the dialog opens translated without a click and without a model
  call; the badge in the header toggles back to the published text. The body is rendered through its
  OWN pipeline (`frontend/src/lib/readme-markdown.tsx`): raw HTML is parsed (`rehype-raw`) and
  immediately SANITIZED (`rehype-sanitize`) against the library's GitHub-derived allowlist plus the
  presentational extras READMEs actually use (`details`/`summary`/`kbd`/`picture`, `align`), with
  `href` limited to http/https/mailto and `src` to http/https. This is a DIFFERENT trust model from
  model output, which refuses raw HTML outright: a README is published repository prose the operator
  chose to open, and half of them are written in `<div align="center">`. Remote images load on THIS
  surface only (`referrerPolicy="no-referrer"`, `loading="lazy"`); no other surface gained HTML
  support, and `script`/`style`/`iframe`/event handlers/`javascript:` URLs never survive the
  sanitizer.

### D6b — Internal loopback calls pin reserved session ids

Translation and probe calls reach the gateway through its own loopback `/v1` surface, so without a
marker EACH CALL mints a fresh `cold_start` session and the console's session list drowns in one-turn
internal rows. Internal callers therefore pin a FIXED per-purpose session id through
`router_options.session_id`: `ocr-internal:translation` (descriptions + README chunks) and
`ocr-internal:translation-probe` (the chain probe). The `ocr-internal:` prefix is a RESERVED
namespace — a claim of "this row is gateway-internal noise", not an enforced restriction; an external
client sending the same prefix would be hidden too, which is accepted (the admin surface trusts its
caller). The marker IS the id: persisted traces key on `sessionId`, so the classification survives a
gateway restart on BOTH live and trace-reconstructed rows with no stored flag — `GET
/api/admin/sessions` derives `internal: true` from the prefix and hides those rows by default
(`hideInternal=0` shows them). The console surfaces that switch as the `Hide internal` checkbox
beside the sessions description line and stamps an un-hidden internal row with an `internal` badge,
so the classification stays visible once the default has taken effect. The translation chain is
explicit (`configured → lite`), so a shared session can never ratchet upward.

### D7 — Identity: one artifact, one key

| Kind | `canonicalKey` | `artifactId` |
| :--- | :--- | :--- |
| skill | `<sourceId>:<ref>[#detail]`, e.g. `github:owner/repo#dir` | `skill:<canonicalKey>` |
| mcp | `<sourceId>:<ref>`, e.g. `manual:brave` | `mcp:<canonicalKey>` |
| plugin | `npm:<name>` / `manual:<spec>` | `plugin:<harness>:<canonicalKey>` |

- **For plugins the harness enters the `artifactId`, not the `canonicalKey`.** One package installed
  into two runtimes is two installs with two rollback stories; folding them would make "remove"
  ambiguous. The `canonicalKey` stays runtime-free so a future cross-runtime ABI can still group them.
- `name` is the on-disk directory name (skills) or the spec written verbatim (plugins). Two
  artifacts wanting one directory is a **refusal** (`exists`), never a suffix policy invented later.
- **Provenance is stored, not merged.** `pin`, `sourceId`, `listedOn`, `trust` travel with the record;
  there is no trust-ladder field arbitration in this build (Deferred). `listedOn` accumulates surfaces
  (D8.6), while `sourceId`, `pin` and `trust` keep the ONE writer's claim.

### D8 — Non-negotiables (each one is enforced in code)

1. **No auto-install, no auto-update.** Every write follows plan → confirm → apply; a rescue from the
   console never runs on its own.
2. **No silent merge.** An MCP plan reports the exact added/changed keys; a JSONC file is refused.
3. **The gateway installs instructions and executables — and says so.** A `SKILL.md` is the agent's
   instructions once installed; `pi install` runs npm lifecycle scripts and executes third-party code.
   The confirmation names that verbatim and records the exact command.
4. **MCP secrets are named, not stored.** A launch record carries env/header **key names**; the value
   is the operator's. Harness never reads, stores, or logs a credential (ADR-0006 untouched).
5. **Untrusted input discipline.** Registry payloads are normalized into narrow shapes before they
   reach the console; validation runs before any writer sees a payload (name grammar, spec grammar,
   `..` segments, launch shape, file-count and byte caps).
6. **Provenance is recorded, and the console shows its source.** `pin` (git commit / npm integrity /
   clawhub version / `adopted`), `sourceId`, `trust` and `listedOn` travel with the record; the row
   renders the source
   label (or "local"), and no audit verdict is implied. A missing audit is silence, not a green check.
   `sourceId` names the WRITER that produced the payload; `listedOn` (writer source first, deduped,
   capped at 8, validated against the source registry at the route) records the surfaces the row was
   BROWSED on, because a catalog row can carry the writing source's key — a Pi-catalog package installs
   as `npm:<pkg>`. The local tab's source chips narrow and count by the union of both, and it offers a
   chip only where that source has at least one installed row on the page (an unfaceted predicate: a
   count narrowed to 0 by the search keeps its chip). The row's own source cell answers "where did I
   install this from" with the BROWSE surface — a Pi-catalog package reads `pi.dev`, because that is
   the catalog the operator picked the row on — and falls back to the writer only when the record
   carries no other surface. The writer is not lost: it stays in `sourceId`, in `canonicalKey`
   (`npm:<pkg>`, the cell's tooltip) and in the chip union, so a row is never renamed — only this
   column's question is answered literally. The count remains a discovery facet, never a claim about
   the artifact's identity.
7. **Install state is per copy, never a boolean.** `state` is the only per-copy vocabulary
   (`clean | dirty | missing | foreign | untracked`); `partial` is a derived rollup, never persisted.
   `untracked` answers "no manifest entry", never "not removable" (D5).
8. **Placement ≠ loading.** `materialized` is the default claim. The post-apply probe upgrades it to
   `verified` only with evidence — skill: `SKILL.md` present; mcp: the server key is in the parsed
   config; plugin config copy: the spec is in the host's declared container; `external` copy: the
   apply-time exit code. A failed probe records `unverified`; an undecidable one leaves the value
   alone. The console never prints "loaded" without a probe.
9. **`external` is an ownership marker, not a condition.** A package-manager copy owns no path of ours:
   `path` is the identity token `<canonicalKey>#<harness>`, it is never stat-ed or hashed, and it
   reports `clean` with `placement: verified` because the subprocess exit code is the proof. Its
   removal edits the declaration the runtime itself reads (`pi` `settings.json` `packages[]`, claude
   `installed_plugins.json` `plugins`), falling
   back to `prune-record` — with wording that says the package bytes stay — when no declaration file
   is declared. No unverified inverse command is invented.
10. **Discovery is observation, and observation is not a removal ban.** What a runtime installed for
    itself is read from that runtime's own record — the array the writer merges into (asked of the
    host's adapter: `readSources`), the OBJECT the MCP writer merges into (the host's `mcp` container
    inside the file `configPath` resolves, so a server the operator added by hand is observation too),
    or pi's declaration file + lock file + loose `extensions/` directory — and merged into the single
    `discovered[]` channel, tagged by `kind` and `harness`.
    Four rules: a row is `untracked` and never promoted to a manifest artifact; it is not stat-ed or
    hashed as a copy of ours; it carries a **`removal` descriptor** (`trash-path` for a loose file,
    `drop-entry` for one string in `plugin[]`/`packages[]`, `drop-server` for one member of a `mcp`
    object) so it is removed by the same shape-based op
    as a tracked copy — the descriptor is a plan parameter, and a `trash-path` is still
    containment-checked; and it is excluded when the manifest already tracks the same
    `(harness, canonicalKey)` — for an MCP server, the same `(host, serverKey)` — so one install is
    never reported twice. Parsing is tolerant: a runtime
    rewriting its own config while we read it answers "no rows", never throws.
    **Cross-version read ladder.** A runtime that moved its landing between majors is read at every
    spelling it may have used (`opencode`: v2 `opencode.jsonc` + `plugins[]` + `plugins/`, v1
    `opencode.json` + `plugin[]` + `plugin/`), and each row's `removal` descriptor names the container
    the entry was ACTUALLY found in — so an uninstall edits the array the runtime reads, not the one we
    would have written. A JSONC config is parsed as JSONC (comments are not corruption); the WRITE
    landing still refuses a JSONC rewrite and prefers an existing plain-JSON candidate (§D8.2).
11. **Claude's plugin landing is the runtime's own CLI and MAP record.** Plugins install through
    `claude plugin install <id> --scope user|project` (gate 3: the exact command echoed, confirmed,
    hard timeout — never a hand-edit of claude's own state). The record is
    `~/.claude/plugins/installed_plugins.json`, an object MAP keyed by the plugin id
    (`"<name>@<marketplace>"`), each value carrying `installPath` / `version` / `installedAt`;
    enable state lives in the settings.json files' `enabledPlugins`, which the runtime syncs from
    this record itself. Two consequences enforced in code: a plugin id collides with a versioned
    npm spec, so every entry is read with the **`claude:` spec prefix** (canonicalKey
    `claude:<name>@<marketplace>`, never parsed as npm); and the record is a MAP, so discovery
    reads the shape (`containerShape: 'map'` on the source) and the removal inverse is a
    `drop-server` member drop of the runtime's own key (the marketplace/material cache under
    `~/.claude/plugins/marketplaces/` stays — the wording says the bytes stay, as with pi).
    A row's version and description answer from the entry value and the installed plugin's own
    `.claude-plugin/plugin.json`. The store is GLOBAL (like pi's); the `--scope` flag carries the
    install scope, the record does not fork.

    **A native marketplace install carries TWO identities.** `canonicalKey` stays the market row's
    key (`mp-…`), which is what the console joins to mark the row installed; the record also stores
    `nativeKey` — the runtime's own `<plugin>@<marketplace>` store key — and discovery excludes both
    spellings. Without it, one `claude plugin install` answers twice: once as the tracked artifact
    and once as the map member read back from `installed_plugins.json`. Records written before this
    field existed are deduped by `(harness, plugin name)` for git-marketplace installs, so the
    guarantee holds without a manifest rewrite.

## Deferred (not implemented — do not assume)

| Area | State |
| :--- | :--- |
| Project-scoped discovery and install (skills, MCP, plugins) | closed at the product boundary: `ENABLED_SCOPES` is `['global']`, so install routes answer `unsupported_scope`, inventory scans no project root, and the console offers no scope selector. Adapter project landings and the writers' `scope` parameter stay DECLARED as the seam — shipping it is that list plus the selector, not a re-spelling of fourteen adapters |
| MCP landings beyond opencode | absent from the adapters; a target is refused with a reason, never guessed |
| Plugin landings beyond opencode (`config`), pi (`subprocess`), claude (`subprocess` + map record, §D8.11), antigravity / factory / kimi (their own plugin manifests + command chains) | absent; other hosts refuse |
| npm as a **skill** source | no longer a view source on any axis; `npm:<pkg>` is an install resolver only, and the skill axis answers `unsupported_kind` |
| PulseMCP / mcp.so | no live adapter and no row in the view (measured 410 retired / 404) |
| Sources declared in `config.yaml` | sources are the `common/source-views.ts` `SOURCES` + `registry.ts`; no `harness.sources` config section |
| Write-ahead intent, cross-copy install rollback, manifest advisory lock | not built; the guarantee is "manifest last" + per-copy rollback |
| `shadowed` rollup, `profile` root origin | named in the type unions, no producer |
| Store/trash GC, adopt-an-untracked-directory action, harness export/import, `canonicalKey` alias overrides, name-collision suffix policy | not built (collision = refusal) |
| `dsh` MCP/plugin surface, `codex` MCP (no TOML writer) | unsupported |
| A verified inverse package-manager command (`pi uninstall`) | not implemented; the declaration edit is the shipped undo |
| Count parity across skills / MCP / plugins | not a goal: a landing is added only when its path, entry shape, secret-reference syntax and inverse removal are verified; a host without one is hidden by the console's `has*` gates instead of being offered as a refusal-only checkbox |

## Consequences

- Positive: one inventory for three kinds, and drift is detected instead of discovered; the source
  layer is adapters behind one payload shape, so onboarding a marketplace costs one file plus one view
  row, not a page rewrite; identity, trust and the removal ops are stated once and reused everywhere.
- Positive: the removal op keyed on landing shape is what stops "uninstall one plugin" from meaning
  "delete the client's whole configuration" — the failure mode the earlier provenance-keyed design had.
- Negative: capability per (kind × host) is very uneven — MCP only on opencode, plugins only on
  opencode and pi. That is honest, but it means most host rows are read-only for two of the three kinds.
- Negative: a runtime-owned copy removed from the console stops loading but its bytes stay in the
  runtime's store; that is the truth of editing a declaration and the console must keep saying it.
- Negative: no GC means store and trash grow; no export/import means harness intent does not travel
  with an environment (ADR-0007 carries environment state, not this).
- Negative: the manifest is written atomically but not locked. Two writers (desktop + CLI) are
  expected to be the same environment serially; a concurrent second writer can lose a copy record.

## Implementation anchors

- `backend/src/harness/host/hosts.ts` — the host identity table (`HOSTS`: id + label, catalog order).
- `backend/src/harness/host/adapters/` — one file per host (its landing paths, skills roots and
  `extensionDir`, exactly once), the shared `defineHost` rules, the capability interfaces, and the
  registry (`adapterFor`, `skillLocationRoots`, `skillOwner`, `skillRootsFor`).
- `backend/src/harness/host/{manifest,types}.ts` / `backend/src/harness/{types,config-file}.ts` — the
  manifest (no legacy migration), claims, vocabulary, and the shared config read/write discipline.
- `backend/src/harness/host/writers/{skill,mcp,plugin}.ts` — the three write modes and their gates.
- `backend/src/harness/host/{install,registry,inventory,discover,drift,maintenance,ledger,probe,request,scopes}.ts`
  — orchestration, reconciliation, the discovery channel, removal descriptors, trash snapshots, the
  `applies` ledger on the shared event-ring skeleton, and post-apply placement evidence.
- `backend/src/harness/host/resolvers/{github,npm,clawhub,git-marketplace}.ts` — the install
  resolvers; the git-marketplace one serves every operator `mp-<slug>` source.
- `backend/src/harness/common/market.ts` — the operator git-marketplace store + probe: snapshot
  history, the format-neutral probe (`ProbeOptions`), browse rows, the federated section merge and
  `toCatalogRow`.
- `backend/src/harness/common/{github,stars,npm-catalog,source-views,marketplace-rescan-scheduler}.ts`
  — repo/tree/tarball reads with pin and caps, on-demand star lookups, the npm identity decision,
  the source-view registration order, and the opt-in rescan timer.
- `backend/src/harness/plugin/adapters/` — one file per harness: `base.ts` (the shared market engine:
  source CRUD, index/federated merge, `install(row)`), `index.ts` (the adapter factory and
  `probeOptionsFor` — the only construction point), `pi-dev.ts` / `pi-github.ts` / `claude.ts` /
  `codex.ts` / `cursor.ts` / `gemini.ts` / `grok.ts` / `copilot.ts` / `antigravity.ts` / `factory.ts` /
  `kimi.ts` / `universal.ts` (each harness's form; pi keeps its official surface and its operator git
  surface in separate files), plus `plugin/catalog.ts` (the harvested JSONL index) and
  `plugin/builtin.ts` (the per-harness built-in view lookup).
- `backend/src/harness/net.ts` — the single failure vocabulary every reader reports in, plus
  `fetchWithRetry` / `MARKET_RETRY`: the one place a market read retries, so no reader carries its own
  attempt count, backoff or budget.
- `backend/src/harness/{detail,tree,translation,spi,hash}.ts` — the long-form half of one market row,
  git tree filtering, the derived description cache, the source-adapter contract, and hashing.
- `backend/src/routes/harness.ts` — the admin surface (`sources`, `hosts`, `applies`, `inventory`,
  `plan`, `apply`, `browse`, `detail`, `install`, `translate*`), all under the existing
  `/api/admin/*` auth gate.
- `frontend/src/pages/HarnessPage.tsx` — one page per kind, a harness rail where a landing exists, the
  installed/market tabs, per-target install gating, the removal picker, and the market row's native
  detail dialog (README rendered through the shared sanitized markdown map). The tab is part of the
  address (`?tab=market`; `local` stays implicit), so a reload keeps the view the operator was
  reading — and a rail pick carries that query across, because changing runtime is a scope change,
  never a view change: the operator decides which tab they are on.

## Open questions

- Which additional MCP landings are worth verifying next (Claude and Cursor are the two with published
  config files; each needs vendor-doc confirmation before it enters `HOSTS`).
- Whether a verified `pi uninstall` should be added as an additional op on top of the declaration edit,
  or whether the declaration edit is the wanted contract (it is the only one that cannot delete bytes
  we do not own).
- When the store needs GC, and what a safe referenced-set actually is once imports and rollbacks exist.
- Whether the trust field (`trust`) should stay single-source or grow the cross-source aggregation this
  record deliberately left out. `listedOn` no longer needs the question: it records every surface a row
  was browsed on (D8.6), and only the writer's `trust` claim is still single-valued.

## D9 — Operator git-marketplace sources (amendment, 2026-10-30)

Any GitHub repository the operator names becomes a browse/install source with **no code change**:
`<ocrHome>/harness/plugin-market.json` is the config — one `mp-<slug>` adapter instance per entry
(`host/resolvers/git-marketplace.ts`), and the registry resolves `mp-*` ids dynamically. The file is
bucketed per harness (`{ "shared": [...], "<harness>": [...] }`, amendment 2026-11-01): the bucket
IS the scope, so the record itself carries no `harness` field. `skill-market.json`, same directory,
holds the skill axis in a single `shared` bucket — a skill is global, so a harness key there would
be a lie. `slug` stays one identity across BOTH files. The type exists because the Claude-style
`marketplace.json` catalog format has become the industry's converging
distribution shape (grok, Copilot CLI, Goose, omp all read it or a clone), while the CONTENT under
it has already converged on one primitive: `SKILL.md`.

**Recognition (the probe).** One probe at add-time and on each rescan: repo meta + HEAD commit +
git tree. A recognized manifest (`.claude-plugin/marketplace.json` and its grok / Copilot / Goose
clones, one parser) narrows the scan to the author's declared relative-path source directories;
external manifest sources (`git-subdir`, `url`, `npm`, …) are REPORTED, not resolved — phase one
does not follow them. No manifest (or an unparseable one — a broken file is not a manifest) falls
back to a whole-tree `SKILL.md` scan. Rows are capped (30) and deduped by basename, shortest path
first: generated mirrors (an `.openclaw/skills/` copy of `skills/`) never surface as second rows.

**Format ownership (amendment, 2026-10-31).** The marketplace FORMAT is not the base engine's
business. Claude is the only vendor with a STANDARD catalog: the converged `marketplace.json`
(`plugins[].source` are REPO-RELATIVE paths), parsed once in `plugin/claude.ts`
(`parseClaudeMarketplace` / `CLAUDE_CATALOG`). Two more vendor formats are parsed only because the
install command REQUIRES a specific file: Gemini CLI's root `gemini-extension.json` and Pi's layer
`package.json` (`PluginManifestReader` — `file`, optional `atRoot`, `base: 'layer' | 'repo'`). Every
other harness is **directory-keyed**: vendor manifests inside `.codex-plugin/`, `.cursor-plugin/`,
`.kimi-plugin/`, `.antigravity-plugin/`, … are not standardized and are never parsed through a
shared schema. Presence of the harness's form directory (declared by its host adapter) IS the
support signal: one plugin row named after the repository, sourced at the repository root. The base
`PluginMarketAdapter` supplies no hook and answers from a bare `SKILL.md` scan; `marketplace.json`
is not pi's format, so there is no abstract "shape" registry to keep in sync.

**Clone directories belong to their harness.** The same format appears under per-runtime
directories, and each is claimed by its owning adapter, which reuses Claude's parser: `claude.ts`
→ `.claude-plugin/marketplace.json`, `grok.ts` → `.grok-plugin/marketplace.json`, `copilot.ts` →
`.github/plugin/marketplace.json`, `factory.ts` → `.factory-plugin/marketplace.json`,
`universal.ts` (the AGENTS/Goose convention) → `.agents/plugins/marketplace.json`. A harness with no
catalog file is directory-keyed instead (codex, cursor, kimi, antigravity, and the catalog-less
fallback of copilot/factory/grok); its vendor JSON is not parsed generically. A Claude source never
reads grok's directory, and vice versa; the parser is shared, the DIRECTORY is not.

**Extension layer (amendment, 2026-10-31).** Repositories that serve several runtimes ship one form
per runtime (`pi-extension/`, `.claude-plugin/`, `.codex-plugin/`, …). A source MAY pin
`extensionDir` — a repo-relative directory, validated against a narrow grammar (no absolute paths,
drive letters, backslashes or `..`). When pinned, the probe refuses to look outside it: a missing
directory is `missing_dir`, never a silent whole-repo scan; for a Claude-format source the manifest
search is `<layer>/marketplace.json` only. When no catalog is found, the harness's OWN hook
describes the source: a layer-based manifest (pi's `package.json`) makes the layer itself the one
plugin row; a directory-keyed harness (codex, cursor, kimi, antigravity) makes the DIRECTORY's
existence the plugin, one row named after the repository; a root manifest (gemini-cli
`gemini-extension.json`) needs no layer at all. Each host adapter declares the
ecosystem default (`extensionDir` in `harness/host/adapters/<host>.ts`), and the probe APPLIES it
when the source pins none: the scan is the harness's own form directory (`.claude-plugin/`,
`.codex-plugin/`, `.github/plugin/`, `.cursor-plugin/`, `.factory-plugin/`, `.kimi-plugin/`,
`.antigravity-plugin/`, `pi-extension/`, …), not the whole repository. An explicit
`extensionDir` still wins; a default directory the repository does not publish degrades to the
bare `SKILL.md` tree instead of failing, and the effective layer is recorded in the snapshot. The
console also advertises the default via `GET .../sources` and pre-fills the dialog, so the operator
can see and override it.

**Containment and provenance.** An `mp-<slug>` adapter resolves ONLY its configured repository and
ONLY `#<skill-dir>`-pinned refs — the market rows carry the pins, a bare ref would guess. The
resolve delegates to the github adapter (tarball, caps, commit pin) and REWRITES the canonicalKey
to `mp-<slug>:<repo>#<dir>`, so a manifest record always names the surface the operator actually
browsed, never a `github:` key that would weld every marketplace onto the built-in source.

**What is deliberately NOT installed.** Per-harness adapter forms — hooks (executable JS),
OpenCode runtime plugins, slash commands, rules files, private git-loaded plugins — are counted
in the snapshot (`authorAdapters`, `unsupported`) and never enter a payload. Skills and MCP are
the kinds this domain installs; rules and command forms need their own decision before they ever
become rows. Git-loaded plugins (pi's `git:` install of an unpublished repo JS) are a recorded
non-goal: npm-published plugins are already covered by the npm source, and executing
repository-resident code from an operator-added list is a trust-boundary change that deserves its
own ADR.

**Rescan (opt-in).** Per source: `rescan.enabled` (default false) + `intervalMs` (clamped 1 min –
30 days; default 1 day). One process timer ticks due sources, appends a bounded snapshot history
(20, deduped on sha+rows), and diffs rows/pin against the previous snapshot. A rescan REPORTS
additions/removals — it never rewrites installed copies; upgrades still go through the install
route and its gates. The snapshot also carries repo-level stars and `pushedAt` (same API response,
free): source-level metadata, never stamped onto rows — a row claims no popularity signal its
source did not state (§D6).

**Bidirectional sync with the runtime's own environment (amendment, 2026-10-31).** Registering or
removing an entry also mirrors it into the owning harness's native marketplace list
(`syncMarketplaceToHost` / `removeMarketplaceFromHost`): the OCR store is the identity, and the
runtime's config is a materialized projection. `POST /api/admin/harness/plugins/:harness/sources/sync`
runs the full round trip for ONE harness — discover the marketplaces already configured there,
import those this store does not hold yet (probe-first, same slug rules), then push every enabled
entry back. Failures are reported per host in `synced[]` with the command and the error, never
swallowed; `discovered` / `imported` name what came in. There are no GLOBAL sync/discovery verbs.

**Browse.** Custom sources ride the standard `/sources` + `/browse` contract: rows render as
MarketItems keyed `mp-<slug>:<repo>#<dir>`, the only declared sort is `name` (a local filter+page
over the snapshot — a stale snapshot answers; the rescan loop owns freshness), and installs go
through the ordinary install route, writer source first, `listedOn` unchanged.

**Maintenance verbs live per harness (amendment, 2026-12).** The global CRUD routes
(`POST/PATCH/DELETE /api/admin/harness/marketplaces*`, `rescan`, `snapshots`) are REMOVED — a
standalone global management page taught an ownership the store does not have. Registration and
removal moved onto the per-harness plugin-market surface (§D10/§D11):
`POST /api/admin/harness/plugins/:harness/sources {url, extensionDir?}` (probe-first, the slug is
DERIVED from the repo — `mp-<repo>`; a second layer of the SAME repo suffixes the directory token,
`mp-<repo>-<layer>`, while re-registering the same (repo, layer) pair answers 409),
`POST .../sources/check {url, extensionDir?}` (the operator's dry-run before add; reports
skill/MCP/plugin counts, writes nothing), `DELETE .../sources/:slug` (404 on unknown harness or slug).
`GET /api/admin/harness/sources` stays as a read-only view (built-ins + `mp-` chips) with no
mutation verbs. Unknown or non-github targets answer 400; unknown harness 404.

The duplicate answer is **store-wide, never per tab** (amendment, 2026-11-01): a slug IS the
`mp-<slug>` sourceId the registry resolves without a harness (`host/registry.ts`) and the skill
axis addresses entries by, so a twin entry under another harness would answer one identity twice.
Per-harness isolation governs what each tab LISTS, owns and syncs; it never widens identity. Two
answers follow from that:

- **The repository is already carried by ANOTHER harness** — the operator adding it from this tab
  means "I want my own source here", so the plugin route registers a SECOND, harness-scoped entry
  instead of dead-ending: the slug takes the harness as its disambiguating token
  (`mp-<repo>-<harness>`, `resolveScopedSlug`), the probe runs unpinned so the row content is the
  repository's own forms, and `entry.harness` keeps the entry out of the sibling's tab, index and
  host. The two sources are enabled, rescanned, synced and removed independently
  (`registered 'o/r' for opencode as 'mp-r-opencode'`); the sibling entry is never mutated.
- **Any other collision** (this harness already holds the repository, the entry is shared, or a
  different repository owns the basename) answers 409 and NAMES the holding entry's pin and layer
  (`'o/r' is already configured as 'r' for claude (layer .claude-plugin)`), because the acting tab
  lists only its own scope and would otherwise look empty while refusing the add.

Answers are machine-readable, never English prose only: registration and check outcomes carry a
closed `reason` plus `params` (`registered`, `registered_scoped`, `already_configured`,
`slug_taken`, `no_form`, `no_skill`, `not_a_repo`, `invalid_source`, `invalid_layer`,
`probe_failed`), and `message` stays the English fallback for logs, the CLI and raw API consumers.
The console renders its own localized copy from `reason` + `params` (repo UI-text rule). A new
outcome must name a reason in the same commit as its i18n key; echoing `message` at the operator
is a bug.

## D10 — The plugin market: per-harness adapters over a two-tier catalog (amendment, 2026-10-30)

**One file per harness, one adapter chain per harness.** Each harness's market lives in its OWN
file under `harness/plugin/adapters/` (`pi-dev.ts`, `pi-github.ts`, `claude.ts`, `codex.ts`,
`cursor.ts`, `gemini.ts`, `grok.ts`, `copilot.ts`, `antigravity.ts`, `factory.ts`, `kimi.ts`,
`universal.ts`): pi keeps its two surfaces apart — `pi-dev.ts` holds the live official catalog and
`PiDevPluginMarketAdapter`, `pi-github.ts` holds `PiGithubPluginMarketAdapter` and the git probe.
Claude's catalog parser lives in `claude.ts`; Pi's package and Gemini's root manifest readers live in
their own files; every other harness is directory-keyed and never parses vendor JSON. Each harness
file claims only its identity and directory (declared by its host adapter). Shared engine:
`PiPluginMarketAdapter extends BasePluginMarketAdapter`. No harness-specific behavior outside its
files. The base engine is deliberately FORMAT-NEUTRAL: it owns source CRUD, the index/federated
merge and the `install(row)` translation, while a concrete adapter overrides `probeOptions()` only
to add its own hook (claude → `CLAUDE_PROBE_OPTIONS`; codex → `CODEX_PROBE_OPTIONS`; gemini-cli →
`GEMINI_PROBE_OPTIONS`; pi's git variant → its `package.json` manifest reader).
`BasePluginMarketAdapter` owns `sources()` + `search()` + `checkSource()` +
`registerSource()`/`unregisterSource()` + `install(row)`.

There is deliberately NO `supported()` predicate: the adapter's existence IS the
support declaration — an instance is only created for a served harness, the landing check happens
at install time, and row-level compatibility travels on `CatalogRow.hosts[]`.

**Two tiers, bounded vs unbounded.**

- **Index tier** — bounded sources (operator git marketplaces via their snapshots, curated static
  registries) harvested into `<ocrHome>/harness/catalog/<harness>/index.jsonl` (JSONL, replaced
  wholesale per harvest, cap 2000 rows per harness, over-cap drops whole newest sources first).
  Browse/search/sort/paginate are local: no upstream request, offline-capable, snapshot-backed.
  Harvest is a READ over snapshots — registering a source probes once (the only hard network
  dependency), afterwards GitHub outages cannot blank the page; a failed rescan keeps serving the
  old snapshot with its age on the label.
- **Federated tier** — unbounded live directories (pi.dev, the curated OpenCode plugin lists).
  Rows are NEVER materialized. Each answer carries its own `total`/`totalExact`.

**Adapter owns the order; the facade merges by the same key.** The facade NEVER re-sorts federated
pages — a page-local re-sort of independently paged sources cannot produce a global order, and the
pagination it implies is false. Since no federated plugin source can serve `name`/`stars`/`updated`
pages (their native orders are downloads / catalog position), the merged, sorted `rows` of a
catalog page are index-tier only; every federated source's query answer travels as its own labeled
`CatalogSection` in the source's native order with its own total. The console does not interleave
rows it cannot co-order. `stars` sorting includes only sources whose star count is a real GitHub
number; sources without one are excluded from that order and the exclusion is stated.

**Honest counts.** There is no separate `count()` method — every `search` response carries
`total?` + `totalExact`, taken from what the upstream itself states. A source that cannot count
answers a lower bound (`5000+`); the facade never synthesizes a grand total across sources.

**Rows.** Plugin kind ONLY — skills and MCPs keep their own axes (a source that carries all three
reports all three in its probe; the catalog sells one kind and links to the others). Dedup keys:
`npm:<pkg>` for npm-backed rows, `mp-<slug>:<repo>#<source>` for git rows. `surfaces[]` records
every source a row was seen on; `hosts[]` is the source's declared compatibility, and the console
dims (never hides) rows not declared for the open harness.

**Five boundaries.** (1) registration accepts github.com URLs only; (2) the mp resolver's
containment fence (`#dir` pins, no bare refs) — never guessed; (3) size caps (30 rows/source,
8 MiB / 200 files tarballs, 2000 rows/harness index); (4) harvest: only index-tier sources land on
disk, federated answers stay ephemeral; (5) query: per-source 8 s timeout and the whole page
degrades per section, never wholesale — a timed-out source shows as a note.

**Install.** `install(row)` delegates to the ordinary install orchestrator (resolve → payload →
writer → manifest) with the adapter's own harness as the single host — a plugin takes exactly ONE
host, its identity includes it (§D5); `surfaces` minus the writing source travel as `listedOn`
(§D9). Nothing here bypasses the gates.

**Dual-axis adapters (amendment, 2026-12).** The market splits along the same axis split as the
rest of the domain: the HOST axis (`harness/host/`) owns every install; the MARKET axis
(`harness/plugin/`) owns discovery only — `install(row)` is a translation step that funnels into
the host route with gate-3 discipline intact. `plugin/adapters/index.ts` (`createPluginAdapter`) is
the only construction point;
`claude` gets the declarative landing (container shape, `specPrefix`, subprocess args), `pi` the
sibling-id catalog, everything else the generic adapter.

**The sources view is honest about contributors.** `GET .../sources` answers the index-tier
sources of THIS harness's catalog — and the index harvest lists only sources that contributed
rows to that harness. A skills-only git repo appears on the skill axis's view, not on a plugin
axis that gained nothing: a chip that names a source with zero rows would claim a tier the
harvest never wrote.

**Mutation re-harvests everyone — except a layer-pinned source.** The source store is global (one
identity namespace across `plugin-market.json` and `skill-market.json`), so
`registerSource`/`unregisterSource` — and the rescan scheduler after a probe — re-harvest the index
of EVERY served harness. A source registered WITH an extension layer
`pi-extension` source must not teach a claude tab to install it. Unscoped sources stay shared. A
stale sibling tab would teach a per-harness model the store does not have; the harvest is a local
read over snapshots — cheap by construction.

**Wiring.** `backend/src/harness/plugin/` (per-harness adapter files over the shared engine), the
shared market core in `backend/src/harness/common/market.ts` (row contract, browse cache/dispatch,
operator source store + probe, stars, npm identity), the host axis in `backend/src/harness/host/`;
routes under `/api/admin/harness/plugins/:harness/{catalog,sources,sources/check,sources/:slug,install}`
(§D11); the console renders it as the `plugin` tab of `HarnessPage` (`/harness/plugins` routes back to
that page, not to a standalone market). Each built-in directory declares its
source view + browse function in its own adapter (`skill/clawhub.ts`, `plugin/pi-dev.ts`);
`harness/common/source-views.ts` only states their order.

## D11 — The console market surface: per-harness tabs, a sources dialog, one shared store (amendment, 2026-12)

**No standalone marketplace page.** The dedicated Marketplaces page and its nav entry are
REMOVED. Source maintenance lives where the sources are consumed: the harness page's market tab.
`/harness/plugins` and `/harness/plugins/:harness` route back to `HarnessPage kind="plugin"` —
the plugin market is a TAB of the harness page, not a separate destination. The nav label is
"Plugin Management".

**One dialog, one axis at a time — kind-isolated, scope-isolated and route-isolated.** The sources
dialog (`HarnessSourcesDrawer`) opens from the market tab of a harness page — the skill tab and the
plugin tab alike. Each axis owns BOTH its registry and its maintenance route: plugins (and the
per-harness MCP views) live under `/plugins/:harness/sources*`, while the skill axis has a GLOBAL
surface with no `:harness` — `GET/POST/PATCH/DELETE /api/admin/harness/skills/sources*`. Contents
follow the same split: a route lists only its own registry's built-ins (`SKILL_VIEWS`,
`MCP_DEFAULT_VIEWS`, `PLUGIN_DEFAULT_VIEWS`) plus the operator entries whose snapshot carries that
kind. SKILLS are GLOBAL: ClawHub serves every harness alike, and a skill source is registered with
NO harness scope, so the same list appears on every harness page and its snapshot lives in the
global snapshot path. MCP and PLUGIN are PER-HARNESS: a server or plugin lands in a specific
runtime, so their BUILT-INS (their `hosts` claim) and ROWS are narrowed to the page's harness. An
operator entry is shared unless it pins an extension layer (§D10): each tab lists a shared entry
only when its snapshot recorded that harness's form.
A source that cannot serve the open axis is noise, not information. Built-in federated sources
render read-only; operator `mp-` sources carry check-before-add, in-place edit (enable + rescan
schedule), manual rescan with a reported diff, and remove.

**Support is detected, not declared.** The dialog carries three fields — source type
(GitHub | npm), the repository (or package/scope), and the harnesses the entry supports, which the
console REPORTS after a probe and never asks the operator to choose. The old extension-directory
input is gone from the UI: `extensionDir` stays a backend/probe parameter (a pinned layer keeps its
historical per-harness scope and strict `missing_dir`), but the dialog always probes one repository
against EVERY served harness's form and records the detected set on the snapshot (`hosts`).
Re-registering the same repo under another layer still derives a second slug
(`mp-<repo>-<layer>`).

**Operator input is forgiving, the stored identity is not.** The repository field accepts a full
URL, a `github.com/owner/repo` reference, a `git@github.com:owner/repo.git` clone line, npm's
`github:owner/repo`, or the bare `owner/repo` pair — ONE parser (`githubRepoFromInput` in
`harness/common/market.ts`) normalizes every spelling for the skill axis and the plugin adapters
alike, so the two axes cannot drift apart. A path BELOW the repository stays refused: that is what
`extensionDir` names, and silently dropping it would register a different layer than the one the
operator pasted.

**The dialog states the sharing.** The store behind the dialog is GLOBAL — one identity namespace,
`mp-` ids shared by every served harness. `plugin-market.json` buckets entries per harness (a
`shared` bucket serves every tab), `skill-market.json` is one shared bucket. The dialog's subtitle
says so; the UI never labels the listed sources as THIS harness's own, and every mutation
re-harvests all served harnesses' indexes (§D10).

**Resolver vs chip.** npm and github remain INSTALL RESOLVERS on the host axis (an `npm:` row
must resolve somewhere), but the npm BROWSING chip is not on the plugin axis — the plugin axis
browses pi-dev (federated) plus operator git sources; the skill axis keeps its chips. A source's
`kinds` declaration in the source's own adapter view (composed by `harness/common/source-views.ts`) is the single word on which axis a
browsing chip appears on.

**Wiring.** `frontend/src/components/HarnessSourcesDrawer.tsx`; opened from `HarnessPage`'s
market tab with the tab's kind; API client mirrors the per-harness route shape 1:1. The
deprecated global client functions and the `MarketplacesPage` were deleted with their i18n keys
in the same commit.

## D12 — The market is built-in + code extension markets; an added entry is a PLUGIN (amendment, 2026-10-31)

**The market surface has two tiers, both code.** One BUILT-IN market per harness (pi.dev for pi,
Claude's official catalog, …) and any number of EXTENSION markets (ClawHub, pi.dev, a converged
`marketplace.json` repository). Extension markets are declared in `harness/common/source-views.ts`
and their adapters in `harness/plugin/adapters/` — an operator cannot invent one at runtime. What each
axis' maintenance dialog adds follows the axis: the PLUGIN dialog adds a plugin (one repository or
npm package, installed into the harnesses that publish a form for it); the SKILL dialog adds a
GitHub repository that publishes `SKILL.md`, registered with NO harness scope and visible to every
harness. The stored `mp-` entry is that artifact's identity and provenance, not a new browsable
"source" namespace.
The per-harness tier is the MCP + PLUGIN tier: a server or plugin is bound to the runtime that
loads it. The skill axis' built-in directory (ClawHub) is the one GLOBAL view, declared beside —
never inside — the per-harness table.
Catalog identity is part of the registration, not an afterthought: the built-in skill directory
registers as its OWN catalog (`ClawHub`), the plugin default as `pi.dev`, and `default` is the
SYSTEM bucket operator sources fall into when they name none. The market's catalog picker always
shows that system bucket; named built-ins keep registry order and land FIRST, so the bucket never
outranks the official directory of the axis.

**Git-backed installs run the runtime's OWN command chain.** `PluginMarketplaceSpec`
(`host/adapters/types.ts`) is a per-host argv template list; the writer expands it and runs the
commands IN ORDER, stopping at the first non-zero exit. Nothing is fetched as a tarball, nothing is
written into a `plugin[]` array, and no payload is resolved. Gate 3 echoes every step verbatim
(`runs[]` on the plan target); `req.marketplace` short-circuits `installArtifact`'s resolver branch.
The chains shipped with this amendment:

| Harness | Chain |
| --- | --- |
| claude | `plugin marketplace add {repo}` → `plugin install {plugin}@{marketplace} --scope {scope}` |
| codex | `plugin marketplace add {repo} --ref main` → `plugin marketplace upgrade {marketplace}` → `plugin add {plugin}@{marketplace}` |
| github-copilot | `plugin marketplace add {repo}` → `plugin install {plugin}@{marketplace}` |
| factory | `plugin marketplace add {urlGit}` → `plugin install {plugin}@{marketplace} --scope {scope}` |
| antigravity | `plugin install {url}` |
| opencode | `plugin add github:{repo}` |
| cursor | `/add-plugin {plugin}` — interactive |
| kimi | `/plugins install {url}` — interactive |
| pi | npm only (`install npm:{spec}`); no marketplace chain |

An INTERACTIVE chain is displayed at gate 3 and never spawned: the vendor installs from inside a
session, so apply refuses with the reason instead of pretending a write happened. npm rows keep the
resolver path and now require an EXPLICIT `subprocessArgs` grammar — a host that declares none
refuses the spec rather than inheriting pi's.

**Source types.** `github` (default) probes the repository as before; `npm` registers a package
(`@scope/pkg`) or a whole scope (`@scope/*`, first registry search page, 25 packages) as a plugin
entry whose rows are `npm:<pkg>` keys. An npm entry serves the plugin axis only. A package PAGE URL
(`https://www.npmjs.com/package/<name>`, scoped / `%2F` forms, its `/v/<version>` tab) is normalized
to that same name — the identity is unchanged. A tarball or version-document URL is NOT a package
page and stays invalid: it names a pin the source cannot record.

**Names an install command needs come from the source's own manifest.** The probe records
`snapshot.marketplace` (the converged catalog's top-level `name`, read through the claude parser)
and the plugin row's `name`; directory-keyed harnesses read the catalog ONLY for those names, never
for rows. Rows carry `marketplace` so `marketplaceSpec`'s `{plugin}@{marketplace}` is the vendor's
identity, not a guess from the repository slug.
