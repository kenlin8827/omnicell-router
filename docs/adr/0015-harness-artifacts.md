# ADR-0015: Harness Artifacts — Skills, MCP Servers, Extensions

- **Status**: Implemented (recorded from current code, 2026-10-24)
- **Date**: 2026-10-24
- **Amended**: 2026-10-25 — the installed row's source cell names the BROWSE surface (the install
  source: `pi.dev`), falling back to the writer when the record carries no other surface (§D8.6).
- **Related**: ADR-0010 (definition ownership + materialization targets), ADR-0006 (credential store —
  never read by this domain), ADR-0013 (observation-ledger precedent), ADR-0007 (environment layout,
  trash-based delete)

## Context

The gateway already owns a **client** relationship with six runtimes (`SupportedClient`: `opencode`,
`opencode-proxy`, `claude`, `codex`, `pi`, `dsh`). That relationship is about **traffic**: an adapter
writes the runtime's model/auth config so requests flow through the gateway, and stops there.

What the runtimes can additionally be given — **skills** (instruction folders), **MCP servers** (tool
backends), **extensions** (runtime plugins/packages) — is otherwise installed by each vendor's own
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
| harness | that client considered as an **artifact host** (skills / MCP / extensions) | `<ocrHome>/harness/` |
| artifact | one installable unit of a given kind | manifest record + materialized copies |

`opencode-proxy` is a **hook mode of the same runtime**, not a second artifact host: the harness domain
exposes exactly one `opencode` target. Harness state never enters the routing truth chain, never touches
credentials (ADR-0006), and never reads provider definitions (ADR-0010).

### D2 — Host landings live in one adapter per host

Two files share the table, with a hard split:

- `hosts.ts` answers **which hosts exist, in which order, called what** (`HOSTS`: id + label only).
- `adapters/<host>.ts` answers **what this runtime reads and how it is written** — one file per host,
  every landing path spelled exactly once. `adapters/declarative.ts` holds the shared rules
  (`defineHost` + the `SkillsHost` / `McpHost` / `ExtensionHost` builders), so a wrong path is one
  small file's data bug and a wrong rule is one implementation bug.

Capabilities are **separate interfaces**, not nine methods on every host: thirteen hosts have a skills
location, one has a verified MCP landing, two have a verified extension landing. A host that cannot do
MCP never implements `McpHost`, so absence is a type fact instead of a runtime `unsupported` throw.

Version differences are a **ladder inside one adapter**, never a second adapter: `opencode` v1 vs v2
differ in landing spellings only, and extension identity is `extension:<harness>:<canonicalKey>`
(§D7) — two adapter ids would split one installed plugin into two artifacts exactly when a machine
carries both spellings during a migration.

Global roots derive from `os.homedir()` and `XDG_CONFIG_HOME` (fallback `~/.config`); project roots
are repo-relative and resolved against the gateway process's cwd — declared, but not reachable while
`ENABLED_SCOPES` is `['global']` (see **Scope** below). Only the cells below have a landing;
a kind × host cell that is empty is refused at resolve time rather than guessed.

| Host | Skills: global / project | MCP landing | Extension landing |
| :--- | :--- | :--- | :--- |
| universal | `~/.agents/skills` / `.agents/skills` | — | — |
| opencode | `$XDG/opencode/skills` / `.agents/skills` | `opencode.json` · `mcp` | v1 `opencode.json` · `plugin[]` · `plugin/`; v2 `opencode.jsonc` · `plugins[]` · `plugins/` |
| claude | `~/.claude/skills` / `.claude/skills` | — | — |
| codex | `~/.agents/skills` / `.agents/skills` | — | — |
| pi | `~/.agents/skills` / `.agents/skills` | — | `pi install npm:<spec>` (subprocess) |
| omp | `~/.omp/skills` (relocated by `PI_CONFIG_DIR`) / `.omp/skills` | — | — |
| cursor | `~/.cursor/skills` / `.agents/skills` | — | — |
| github-copilot | `~/.copilot/skills` / `.agents/skills` | — | — |
| gemini-cli | `~/.gemini/skills` / `.agents/skills` | — | — |
| cline | `~/.agents/skills` / `.agents/skills` | — | — |
| amp | `$XDG/agents/skills` / `.agents/skills` | — | — |
| windsurf | `~/.codeium/windsurf/skills` / `.windsurf/skills` | — | — |
| zed | `~/.agents/skills` / `.agents/skills` | — | — |

- **Most hosts read, few hosts own.** Ten hosts read the project `.agents/skills`; one directory is
  one copy, so `skillOwner()` (first adapter in registry order resolving to that path) decides the
  recorded host and every other host is an alias. Install, inventory and the console all use that rule.
- **Ownership and readership are two answers, and the console asks both.** `skillOwner()` answers "who
  owns this copy" (install target, claims, removal); `skillReaders()` answers "who can LOAD it"
  (`CopyView.readers`, owner first). The skills page's harness rail selects by readership — a skill
  materialized once in `.agents/skills` is usable from ten runtimes, and a rail built on ownership
  would show it under one entry and hide it under the other nine. Writes stay owner-only
  (`KIND_META.skill.installAxis = 'skills-owner'`): the rail is a lens, never a fan-out permission.
- **Presence is measured, and undetected hosts leave the rail.** Each adapter declares `presence`
  markers — an executable name probed on PATH and/or its config directory — and `hostDetected()`
  answers from those markers plus the existence of any of the host's global skills roots (a runtime
  that left its skills tree behind stays visible, or its copies would become unmanageable). The
  console rail shows detected hosts only, plus any host whose rows are already landed; `universal`
  is always detected, so a machine with no runtime installed still has a landing spot. The catalog
  itself stays static — presence is a per-machine measurement on the hosts endpoint, never a
  membership change in `HOSTS`.
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
  scans a project skills root / extension source / MCP landing, and the console offers no scope choice
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
  chip number stays honest — and it is absent where it would mean nothing: on MCP/extension pages (no
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
  are promoted by rename, then copied per target. MCP and extension writes have no store blob — they
  edit a config file or run a package manager.
- **Manifest v2** carries the artifact-level `harness` for extensions. A v1 record is migrated in
  memory on read: a legacy `extension:<canonicalKey>` splits into one record per host, the
  `external` marker is back-filled by exact token match, and a copy-less legacy record (no host names
  it) is retired to `manifest.orphans.json` — losing the only record it ever existed would be worse
  than an orphan line.
- **The record carries the SOURCE's one-line `description`** (optional; absent when the source claims
  none). The console prefers installed text — a skill's `SKILL.md` is read at view time — and falls
  back to this field for kinds whose copy has no file of ours to read: an npm package living in the
  runtime's store, an MCP entry inside a host config. Discovery rows (the runtime's own installs) read
  the package's OWN `package.json` `description` from the runtime store: a local file read, never a
  registry round-trip, so a full machine stops rendering as blank cards without turning a rescan into
  N network requests.
- **A local extension row describes itself from its own material**, so hand-placed plugins are not
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
    "id": "extension:opencode:npm:@acme/plugin",   // <kind>:<canonicalKey>, harness for extensions
    "canonicalKey": "npm:@acme/plugin",
    "kind": "extension",
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
| extension | `plugin[]` array edit **or** `pi install npm:<spec>` — exactly one harness | command echoed verbatim, `confirm: true` required, no `-y`, 120 s timeout |

- **An extension targets one harness, never several.** Installing to two runtimes is two installs and
  therefore two artifacts: the backend refuses `hosts.length !== 1` for `kind: extension`.
- **A merge never rewrites a file it cannot round-trip.** A config with comments (JSONC) is refused,
  not stringified-away; `createBackup` writes `.bak.ocr` before the atomic rename.
- **Subprocess installs execute third-party code.** The plan echoes the exact command, the runner never
  appends `-y`/`--yes`, output is captured, and the exit code is recorded.
- **Order of writes.** Skill: claims → store staging → per-copy `cpSync` (a failed copy is removed and
  released) → manifest last. MCP: claim → merge → backup/write → manifest last. Extension: run/merge →
  manifest last. A manifest entry therefore only ever exists for a copy that landed.
- **Removal op follows the landing shape, never the provenance:**

  | Landing shape | Op | What is destroyed |
  | :--- | :--- | :--- |
  | file tree, loose extension file | `move-to-trash` | the tree, into `trash/<ts>-<planId>/` |
  | one string in a JSON array (`plugin[]`, pi `packages[]`) | `drop-entry` | that string; `.bak.ocr` first |
  | one member of a JSON object (a server in `mcp`) | `drop-server` | that member; `.bak.ocr` first |
  | package copy with no declaration file | `prune-record` | the record only |

  A copy whose `path` is a **config file** is never trashed: `opencode.json` holds every other server
  and plugin, so moving it would delete configuration that is not ours. A `trash-path` descriptor from
  a discovered row is containment-checked (it must sit directly under a known skills root or a host's
  declared loose-extension directory) — a path-safety rule, not an ownership ceremony.

- **Removal is plan → confirm → apply**, with a 10-minute plan TTL. Apply re-checks that every
  non-`drop` target still exists, refuses a `dirty` copy without `discardLocalEdits`, and writes the
  manifest only after every filesystem op succeeded. Every applied artifact gets one `applies` ledger
  row (`remove`), including a `prune-record` that leaves no disk trace.
- **A claim is released only when the path was destroyed** (`move-to-trash`). A config member edit
  leaves the file in place, usually holding other artifacts.

### D6 — Sources are adapters, and each one states what it can do

`registry.ts` holds the adapters that can produce a payload; `SOURCES` in the route file is the view
the console renders. A source present in the view but absent from the registry answers
`unsupported_source` instead of pretending.

| Source | Kinds | Access (measured) | Role |
| :--- | :--- | :--- | :--- |
| GitHub `owner/repo` | skill | anonymous, 10 req/min search, `GITHUB_TOKEN` optional | the content source: tarball per install, 200 files / 8 MiB caps |
| npm registry | skill, extension, mcp | anonymous search 200; `keywords:` is an exact tag filter | extension package source AND MCP launch source: an mcp row resolves to a launch over the pinned spec (`npx -y <pkg@version>`, version + `dist.integrity` recorded — no author runtime arguments exist off-registry, so none are invented); npm-as-skill resolves `unsupported_kind`. An empty query opens on the PINNED runtime's own tag (per-harness map in `browse.ts`), the MCP axis on the author's own `mcp-server` tag (10 501 packages measured 2026-10-25; the wider `model-context-protocol` tag at 41 344 is mostly SDKs/clients); a runtime with no tag convention falls back to a relevance phrase and says so, never to another runtime's tag |
| pi.dev package catalog | extension | anonymous 200, server-rendered HTML — no JSON API; 50 cards per page, addressed by its own `&page` | official Pi catalog, bound to `pi`; browse-only: every row prints its own `pi install npm:<pkg>`, so the key is `npm:<pkg>` and install runs through the npm source |
| MCP official registry | mcp | anonymous `/v0/servers` — list browsable (`limit` ≤ 100, opaque cursor, `version=latest`); per-server read at `/v0/servers/<name>/versions/latest` (the bare path answers 404) | authoritative server identity + launch spec; browse rows carry `mcp-official:<name>` and install merges the server into a host's `mcp` container. The registry publishes no star count and no ordering parameter, so the source declares no `sorts` and the market invents neither |
| skills.sh | skill | API **401** without a Vercel workload token; the endpoint the SITE's own browser uses answers **200** anonymous: `GET /api/skills/<view>/<page>` — 0-based, **200 rows** an answer, stating `total` (All-time **9 911**, Trending 9 959, Hot 6 765) and `hasMore`; `GET /api/search?q=&limit=` — caps at **200** rows, IGNORES `offset`/`page`/`cursor`, refuses a term shorter than 2 characters | **live**, never through the closed API: an empty (or 1-character) query pages the chosen board through the site's own paging endpoint (so rank 601+ is reachable), a 2+ character query searches the WHOLE catalog through the site's own search endpoint. A board answer is a RANKING (`total` = 9 911 rows, of which 178 carry no GitHub repository and are dropped by the install grammar — `totalScope` therefore stays absent for boards), while a search answer is a WINDOW (`totalScope: 'window'`, summary hidden). Rows install as `github:<owner/repo>#<skill-dir>` (the site's own `npx skills add` identity). The `VERCEL_OIDC_TOKEN` the API asks for is minted inside a Vercel deployment with an hourly lifetime, so it is no operator secret |
| ClawHub | skill | `GET /api/v1/skills?limit=&cursor=&sort=` (cursor-paged, its own `sort` enum), `GET /api/v1/search?q=` — NO paging parameter, one answer is a window; `GET /api/v1/skills/<slug>?ownerHandle=` → one skill's own record (`skill.description` IS the published `SKILL.md`, plus `latestVersion`, `stats`, `owner`); `GET /api/v1/download?slug=&ownerHandle=&version=` → deterministic ZIP bytes; anonymous reads 3000/min/IP with `Retry-After` (measured 2026-10-25) | **live**, and the one skill registry that installs from its OWN store: rows carry no GitHub repo, so the pin is the registry version (`{clawhub:{slug, version}}`) and `stars` stays `null` — the registry's own star/download/install tally travels in `registryStats` (its own unit, labelled as ClawHub's) instead of being relabelled a GitHub count. `ownerHandle` is the disambiguator the registry's own 409 error names — undocumented on the endpoints but measured working (a wrong owner answers 404). A 200 that answers JSON is the registry's `public-github` handoff for GitHub-backed skills; its shape is undocumented, so the adapter refuses it by name |
| Smithery | mcp | `GET /servers` + `GET /servers/<name>` → **200** anonymous; the listing serves 500 rows however it is sliced while claiming ~20 765 | **live**: the one aggregator that HOSTS its records (`<slug>.run.tools`, measured MCP `initialize` → 401 without an `Authorization` header), so its launch spec is authoritative for its own deployments. Arbitration: the official record wins when it also carries the server. A connection that declares required config (`configSchema.required`) is refused by name — the writer can reference env KEY names, not a per-connection config object |
| OpenCode ecosystem | extension | curated docs table (mdx), shipped as a snapshot | browse-only, bound to `opencode`; a row with a verified package name installs through npm |
| awesome-opencode | extension | `dist/registry.json` — a flat array with a declared schema, read through the GitHub contents API | community catalog, bound to `opencode`; install resolves the package on demand (declared name → repository-verified candidate) and answers the npm identity |
| opencode.cafe | extension | Convex `extensions:listAllApproved` — anonymous read, POSTed directly (undocumented contract) | community catalog, bound to `opencode`; only `type: 'plugin'` rows are extensions; install resolves the package the same way; the query ships author e-mails, which the reader narrows away |
| manual | mcp, extension | operator input | escape hatch: `manualPayload` (MCP) / `manualSpec` (extension) |

- **One normalized payload.** The writer never sees a source: skill → `{files}`; mcp → `{launch}`;
  extension → `{spec}`. A source that cannot produce a payload is browse-only and says so.
- **Caps bind EXPANDED bytes, before any decompression.** A declared compressed length is not a
  memory bound (deflate reaches ~1000:1): the file count is read from the archive's own directory
  record and every inflate call is limited to the remaining budget, so an oversized payload is
  refused with `too_large` instead of materializing in the gateway process.
- **A source can be harness-bound.** `hosts?: HarnessHostId[]` narrows an adapter to the runtimes whose
  landing its payload can feed; the console renders its chip only on those pages and install refuses
  the others.
- **The view order is the noise order.** The `SOURCES` array is both the console's chip row and its
  landing priority: per axis, the market opens on the FIRST enabled+browsable source. The order
  follows how far a row's claim reaches: a catalog whose row IS the artifact — an official catalog
  (`mcp-official`, `pi-dev`), a curated snapshot (OpenCode ecosystem), the skills.sh leaderboard —
  outranks a search over containers that CARRY the artifact (GitHub's topic-filtered repo search:
  the topic is self-declared on the repo and the stars reward the repo, not the skill), which
  outranks npm — the widest, noisiest net, a relevance search across the entire registry with inert
  ranking weights, declared LAST: the wide net is what an operator opts into, never the landing
  state. An opencode page therefore opens on the curated catalog, a skills page on the skills.sh
  leaderboard; only a runtime with no narrower source (claude, codex, …) lands on npm. ClawHub — a
  skill-only registry whose rows ARE skills but carry no GitHub repository, and therefore no star
  signal — sits between skills.sh and github on the skills axis.
- **Sources are code-configured, not user-configured** (see Deferred).
- **A catalog source may answer ANOTHER source's identity, and must earn it.** Three OpenCode catalogs
  carry no package name in their own rows, so a row cannot invent an install handle:

  - the curated OpenCode catalog (`opencode-ecosystem.ts`) is a shipped snapshot. 29 of 31 rows were
    verified against the registry and the package's own `repository` field, so those rows carry
    `npm:<pkg>` as their key and install through the npm source directly; the 2 rows with no published
    package keep a `static-opencode:<name>` key that no adapter serves, and the console offers "search
    npm" instead of an install button that could only answer `unsupported_source`.
  - awesome-opencode (`sources/awesome-opencode.ts`) resolves a package at INSTALL time: a name the
    entry declares itself, else a probed candidate confirmed by the package's own `repository` — both
    owner and repo, never "a package with this name exists". 89 of 136 entries resolve; the rest answer
    `no_artifact` with the repo URL rather than installing a squatted name.
  - opencode.cafe (`sources/opencode-cafe.ts`) reads a Convex query (`extensions:listAllApproved`,
    anonymous, POSTed directly — an undocumented contract, so a re-provisioned deployment answers
    `upstream` and never an empty catalog). Only `type: 'plugin'` rows are extensions. The reader
    narrows every row onto a shape with no `author` field: the public query returns author e-mail
    addresses and they must not reach the market, the manifest or a log.

  The earning rules live once, in `catalog-npm.ts`. The resolved payload is the npm adapter's, so the
  artifact's `canonicalKey` is `npm:<pkg>` and one package has ONE identity no matter which catalog
  surfaced it. `sourceId` records where the row was DISCOVERED — that is provenance, not identity,
  which is why the extension writer derives `ref` from the key itself instead of slicing by the
  requesting source's name. A catalog whose rows carry ANOTHER source's key (the Pi catalog and the
  curated list both install as `npm:<pkg>`) would lose that provenance through `sourceId` alone, so the
  install request also carries `listedOn` and the record keeps both (D8.6).
- **A catalog may be READ FROM HTML when that is all it publishes.** `pi.dev/packages` (the official
  Pi catalog) is server-rendered and documents no API, so `harness/pi-dev.ts` keys off the
  machine-readable attributes the catalog's own filter/sort script consumes (`data-package-card`,
  `data-package-name`, `data-package-types`, `data-package-date`, `data-package-path`) plus the printed
  `pi install npm:<pkg>` command — the catalog's own statement of what a row installs. That contract is
  unversioned and undocumented, so the reader fails LOUD: a page with neither package cards nor the
  result-count marker, or cards that yield no package name, answers `upstream`, never an empty market.
  The market lists that catalog ROW FOR ROW: every row — extension, untyped bundle, skill, theme,
  prompt — installs with the same printed command (`pi install npm:<pkg>`) into the same runtime
  package store, so nothing is dropped, and the catalog's own count is therefore an exact `total`. A
  row's type chips are the catalog's vocabulary, not this market's kinds. The card's
  `data-package-downloads` orders the page upstream and is deliberately NOT copied into the market's
  `stars` field.
- **"No popularity signal" is `null`, never `0`.** Only the GitHub source publishes stars; npm, the Pi
  catalog, the curated list and both community catalogs publish none, so their rows carry
  `stars: null` and the console renders an em dash. Printing `0` would assert "nobody starred this",
  which none of those sources ever said. A row that NAMES a repository can still acquire a real count,
  but only ON DEMAND (`harness/stars.ts`, `POST /api/admin/harness/market/stars`): browse never spends
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
  is sliced, so `name` there is a true global order. npm has neither a `sort` nor a working one — its
  documented `quality`/`popularity`/`maintenance` weights were measured inert (50-row result sets
  identical under three extreme weightings across five queries) — so npm's `name`/`updated` orders are
  computed by the BACKEND over one maximum-size window of the registry's own ranking (`size=250`), and
  the answer carries a `window-sorted` note naming that window: the page renders the order it was
  given, and `total` reports the window's size because paging past it cannot answer. Nothing is ever
  re-sorted in the console, and a source with one order (or none) gets a plain label, not a dead
  dropdown: a page-local re-sort would claim a global order that nobody computed.
- **Browse cache is 60 s**, because anonymous GitHub search allows 10 requests/minute and every
  keystroke would otherwise spend one. The cache is keyed by the EXACT query string, so a distinct
  prefix is a distinct upstream call — which is why the console commits a query (Enter, source
  switch, clear) instead of searching on input: typed text never reaches the network. A single dead
  source answers with its reason and never blanks the page. The console can also force a re-read: its
  refresh button sends `refresh=1`, and `browseSource` evicts THAT source's cache family
  (`evictBrowseCache`) before dispatch, so a still-warm window cannot answer a request that means to
  be new — and refreshing one catalog never discards another's warm window. A LEADERBOARD source keeps
  its BOARD pages for TEN MINUTES instead (`BOARD_TTL_MS`): a ranking moves over days, while skills.sh
  throttles a burst with `429 Retry-After: 60` after roughly 30 requests and its all-time board is ~50
  pages — so a deep scroll would otherwise spend two throttle windows to reach the end, and the next
  visit would spend them again. The refresh button still bypasses that window (the eviction is
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
| extension | `npm:<name>` / `manual:<spec>` | `extension:<harness>:<canonicalKey>` |

- **For extensions the harness enters the `artifactId`, not the `canonicalKey`.** One package installed
  into two runtimes is two installs with two rollback stories; folding them would make "remove"
  ambiguous. The `canonicalKey` stays runtime-free so a future cross-runtime ABI can still group them.
- `name` is the on-disk directory name (skills) or the spec written verbatim (extensions). Two
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
   config; extension config copy: the spec is in the host's declared container; `external` copy: the
   apply-time exit code. A failed probe records `unverified`; an undecidable one leaves the value
   alone. The console never prints "loaded" without a probe.
9. **`external` is an ownership marker, not a condition.** A package-manager copy owns no path of ours:
   `path` is the identity token `<canonicalKey>#<harness>`, it is never stat-ed or hashed, and it
   reports `clean` with `placement: verified` because the subprocess exit code is the proof. Its
   removal edits the declaration the runtime itself reads (`pi` `settings.json` `packages[]`), falling
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

## Deferred (not implemented — do not assume)

| Area | State |
| :--- | :--- |
  landing). Adapter project landings and the writers' `scope` parameter stay DECLARED as the seam — shipping it is that list plus the selector, not a re-spelling of fourteen adapters |
| MCP landings beyond opencode | absent from the adapters; a target is refused with a reason, never guessed |
| Extension landings beyond opencode (`config`) and pi (`subprocess`) | absent; other hosts refuse |
| npm as a **skill** source | declared in the view, resolves `unsupported_kind` |
| PulseMCP / mcp.so | no live adapter and no row in the view (measured 410 retired / 404). skills.sh moved out of this row: its PAGES are readable, see §D6 |
| Curated OpenCode catalog | browse-only snapshot: no install adapter, and no runtime fetch — `raw.githubusercontent.com` and `cdn.jsdelivr.net` both reset from this environment, so the table ships in the repo and goes stale between refreshes. 29 of 31 rows carry a verified npm name and install through the npm source; 2 publish no package and cannot be installed from the console |
| awesome-opencode | install adapter present, but a name must be EARNED: 89 of 136 plugin entries resolve to a package (a declared name, or a candidate whose own `repository` field matches owner AND repo). The other 47 answer `no_artifact` with the repo URL, because installing by a plausible name would be a supply-chain bet |
| opencode.cafe | live and readable (54 approved rows, 40 of them `type: 'plugin'`), but on an UNDOCUMENTED contract: the Convex deployment URL and query name come from the site's own client bundle. Its `author.email` field is dropped by the reader. Entries whose install snippet names no package (a local path, `…other plugins`) fall back to the repository probe and may answer `no_artifact` |
| Sources declared in `config.yaml` | sources are the `SOURCES` table + `registry.ts`; no `harness.sources` config section |
| Write-ahead intent, cross-copy install rollback, manifest advisory lock | not built; the guarantee is "manifest last" + per-copy rollback |
| `shadowed` rollup, `profile` root origin | named in the type unions, no producer |
| Store/trash GC, adopt-an-untracked-directory action, harness export/import, `canonicalKey` alias overrides, name-collision suffix policy | not built (collision = refusal) |
| `dsh` MCP/extension surface, `codex` MCP (no TOML writer) | unsupported |
| A verified inverse package-manager command (`pi uninstall`) | not implemented; the declaration edit is the shipped undo |

## Consequences

- Positive: one inventory for three kinds, and drift is detected instead of discovered; the source
  layer is adapters behind one payload shape, so onboarding a marketplace costs one file plus one view
  row, not a page rewrite; identity, trust and the removal ops are stated once and reused everywhere.
- Positive: the removal op keyed on landing shape is what stops "uninstall one plugin" from meaning
  "delete the client's whole configuration" — the failure mode the earlier provenance-keyed design had.
- Negative: capability per (kind × host) is very uneven — MCP only on opencode, extensions only on
  opencode and pi. That is honest, but it means most host rows are read-only for two of the three kinds.
- Negative: a runtime-owned copy removed from the console stops loading but its bytes stay in the
  runtime's store; that is the truth of editing a declaration and the console must keep saying it.
- Negative: no GC means store and trash grow; no export/import means harness intent does not travel
  with an environment (ADR-0007 carries environment state, not this).
- Negative: the manifest is written atomically but not locked. Two writers (desktop + CLI) are
  expected to be the same environment serially; a concurrent second writer can lose a copy record.

## Implementation anchors

- `backend/src/harness/hosts.ts` — the host identity table (`HOSTS`: id + label, catalog order).
- `backend/src/harness/adapters/` — one file per host (its landing paths, exactly once), the shared
  `defineHost` rules, the capability interfaces, and the registry (`adapterFor`, `skillLocationRoots`,
  `skillOwner`, `skillRootsFor`).
- `backend/src/harness/{manifest,types}.ts` — manifest v2 + migration + orphans, claims, vocabulary.
- `backend/src/harness/writers/{skill,mcp,extension}.ts` — the three write modes and their gates.
- `backend/src/harness/{inventory,discover}.ts` — reconciliation, the discovery channel, removal
  descriptors.
- `backend/src/harness/{maintenance,config-file}.ts` — the removal ops, trash snapshots, the shared
  config read/write discipline.
- `backend/src/harness/{install,registry,spi,browse,sources/*}.ts` — orchestration, source adapters,
  normalized payloads, the browse cache.
- `backend/src/harness/net.ts` — the single failure vocabulary every reader reports in, plus
  `fetchWithRetry` / `MARKET_RETRY`: the one place a market read retries, so no reader carries its own
  attempt count, backoff or budget.
- `backend/src/harness/opencode-ecosystem.ts` — the shipped curated OpenCode catalog (a data module,
  not an adapter: it produces no payload) with the verified `name → npm package` mapping.
- `backend/src/harness/browse.ts` — every browse adapter behind one `MarketItem` shape, including the
  awesome-opencode registry reader (contents API, 60 s cache), the disk-only curated reader and the
  cursor-paged MCP registry reader (page N walks the recorded cursors; the chain is cached with the
  rows, so stepping back or forward is one read at most), and the Smithery listing/page reader.
- `backend/src/harness/smithery.ts` — the Smithery listing + per-server reader: narrows rows (no owner
  id, no token) and reports the reachable 500-row window apart from the count it claims.
  rows, so stepping back or forward is one read at most).
- `backend/src/harness/detail.ts` — the long-form half of one market row (npm document, repository
  facts, README, ClawHub's own per-skill record), with the identity validation that keeps the read
  off a caller-supplied URL.
- `backend/src/harness/catalog-npm.ts` — the ONE place that decides what an earned package name is
  (`declaredPackageName`, `sanitizePackageName`, `npmCandidates`, `verifyNpmIdentity`), shared by every
  catalog adapter.
- `backend/src/harness/awesome-opencode.ts` — the community registry reader (GitHub contents API).
- `backend/src/harness/opencode-cafe.ts` — the opencode.cafe Convex reader; narrows rows onto a shape
  with no `author` field.
- `backend/src/harness/pi-dev.ts` — the official pi.dev catalog reader: server-rendered HTML, keyed
  off the catalog's own card attributes and the printed `pi install npm:<pkg>` command.
- `backend/src/harness/sources/awesome-opencode.ts` / `sources/opencode-cafe.ts` — the install adapters
  that turn one catalog entry into a package spec, delegating the payload and pin to the npm adapter.
- `backend/src/harness/net.ts` — the ONE phrasing for a failed fetch (which upstream, what to do),
  shared by every reader so no runtime error text reaches an operator.
- `backend/src/harness/{probe,ledger,translation}.ts` — post-apply placement evidence, the `applies`
  ledger on the shared event-ring skeleton, the derived description cache.
- `backend/src/routes/harness.ts` — the admin surface (`sources`, `hosts`, `applies`, `inventory`,
  `plan`, `apply`, `browse`, `detail`, `install`, `translate*`), all under the existing
  `/api/admin/*` auth gate.
- `frontend/src/pages/HarnessPage.tsx` — one page per kind, a harness rail where a landing exists, the
  installed/market tabs, per-target install gating, the removal picker, and the market row's native
  detail dialog (README rendered through the shared sanitized markdown map). The tab is part of the
  address (`?tab=market`; `local` stays implicit), so a reload keeps the view the operator was
  reading, while a harness CHANGE drops it — the rail's badges count INSTALLED copies, so a rail pick
  always answers with the local tab.

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
