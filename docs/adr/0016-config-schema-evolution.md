# ADR-0016: Config Schema Evolution — Versioned Grouped Disk Format

Date: 2026-10-28
Status: Accepted
Governs: `backend/src/config/schema.ts`, `backend/src/config/migrations/*`, the
config read/write paths in `backend/src/config/index.ts`, boot upgrade in
`backend/src/index.ts`.

## Context

The config.yaml top level grew to ~33 flat sections with no semantic
grouping: `fallback` and `retry.failover` are the same execution-layer
concern living at different depths, `proxy` vs `forwardProxy` don't say
which direction they face, and there was no way to evolve the disk format
without ad-hoc key sniffing at load time. Every future schema change would
have re-opened the "how do we detect and convert old files" question.

## Decision

### 1. The disk format is versioned and grouped; the runtime stays flat

`config.yaml` carries `schemaVersion` as its first key and nests every
section into exactly one of six semantic groups — each section has a unique
home, no misc drawer:

| Group | Meaning | Sections |
|---|---|---|
| `client` | Client entry surface — how requests enter | `port`, `host`, `webAuth`, `apiKeys`, `rateLimit`, `forwardProxy` |
| `protocol` | Protocol surface — which wire the gateway speaks | `systemone`, `responses` |
| `routing` | Traffic-orchestration surface — which model serves | `strategy`, `tiers`, `classifier`, `session`, `directives`, `routeEntries`, `combos`, `modelProfiles`, `profileMemory` |
| `upstream` | Upstream-connection surface — how upstreams are reached | `proxy`, `credentials`, `streaming`, `compression` |
| `resilience` | Failure-recovery surface — what happens when a call fails | `circuitBreaker`, `retry` (`inplace` / `failover` / `escalation`) |
| `ops` | Operations surface — observability, data sources, internal facilities | `requestCapture`, `tracePersist`, `logging`, `catalog`, `quota`, `quotaProbes`, `opencode`, `defaultModels` |

The runtime `RouterConfig` object is UNCHANGED and stays flat: consumers
keep reading `config.tiers`, `config.retry`, `config.fallback`. Grouping
exists only between disk and runtime through ONE declarative mapping table
(`SECTION_MOVES` in `schema.ts`) used by both directions.

### 2. Strict runtime, migration only at boot and at save points

- **`loadConfig` never migrates.** It asserts `schemaVersion === current`;
  anything else takes the same lenient tier as a syntactically broken file
  (built-in defaults + one warn). The runtime has zero legacy tolerance.
- **`upgradeConfigFile()` runs once at gateway boot** (before the first
  `loadConfig`): a file older than the current version is migrated and
  REWRITTEN IN PLACE (`.bak` snapshot first, change list warned once). After
  boot, the disk file IS the current schema. A file NEWER than this build
  fails boot ("upgrade OCR") — fail-fast, never silent fallback (same
  philosophy as ADR-0007's env resolution).
- **Every writer emits the current version** — `saveConfig`,
  `defaultConfigYaml()`, and the raw-YAML editor save (which migrates an
  older draft; a newer draft is refused). A save upgrades the file; there is
  no downgrade path.

### 3. One migration script per version step, chained strictly

`backend/src/config/migrations/v0-to-v1.ts`, `v1-to-v2.ts`, … each export a
frozen `{ from, to, warn, migrate }` step; `MIGRATIONS` in `schema.ts`
assembles them IN ORDER. `migrateConfig` walks the chain one step at a time
(`while cur < SCHEMA_VERSION: find(from === cur)`), never skipping versions
— the final skeleton is the composition of all steps.

Binding rules:
- A released migration file is FROZEN forever; evolution appends new files,
  never edits old ones. Frozen fixtures in `backend/tests/fixtures/` +
  `backend/tests/config-migration.test.ts` anchor each step's transform.
- Migration steps are PURE shape transforms. Business clamping (junk →
  default, ms floors) stays in `loadConfig`'s value cleaners — trust-boundary
  validation never mixes into migration.
- Unmapped/retired keys vanish at migration (they are not in the mapping
  table) and can never re-persist; `migrateConfig` warns once about retired
  hand-written surfaces (ADR-0010) found in the pre-migration v0 parse, so
  the boot upgrade says so instead of dropping them silently.

### 4. The v0 → v1 step (this ADR's enactment)

v0 = every pre-ADR-0016 file (flat, no `schemaVersion`). The step:
1. regroups all flat sections into the six groups;
2. renames `routing.mode` → `routing.strategy` (collides with the new group
   key), `clientProfileMemory` → `routing.profileMemory` (the `client.`
   prefix is redundant inside `routing`), `fallback` →
   `resilience.retry.escalation` (the third stage of the retry pipeline
   finally sits next to its siblings);
3. renames `adminApiKey` → `adminKey` (disk: `client.adminKey`; env lever
   `ROUTER_API_KEY` stays a legacy fallback for the new `OCR_ADMIN_KEY`):
   the master key keeps its job — full `/v1/*` access (never metered) and
   the programmatic Bearer limb for `/api/admin/*` when webAuth is active —
   it just gets a name that matches what it does.

`env-archive` redaction keeps guarding `adminApiKey` in raw (possibly v0)
config bytes: the name is retired, the secret shape is not.

## Consequences

- Future schema changes are additive: write the next migration file, bump
  `SCHEMA_VERSION`, add frozen fixtures. No load-time heuristics ever return.
- The YAML comment annotator is GONE — superseded by the zero-comment disk
  format amendment below: the dictionaries render in the console instead,
  keyed by the same runtime paths, so comment table and mapping table cannot
  drift apart (`toRuntimePath()` logic now lives client-side in YamlPage).

## Amendment (same day): zero-comment disk format

The per-field YAML comments originally planned for `config.yaml` are
RESCINDED. Writing comments into the file proved fragile (re-annotation
accumulated duplicate header comments on every pass) and coupled the disk
format to the operator's language.

New contract: **config.yaml carries values only** — `schemaVersion` first,
then the six groups, zero comments anywhere. The zh-CN and en comment
dictionaries live in `backend/src/config/comments-zh.ts` /
`comments-en.ts` (RUNTIME-path keyed) are rendered dynamically by the
console's Config File page: a side panel shows the documentation for the
key under the cursor in the current UI language, following language
switches instantly. The editor additionally renders each documented key's
comment INLINE as read-only ghost text after the key line (CodeMirror
widget decorations — never document text, never savable), truncated at
120 chars with the full text in the side panel. The disk format never
changes with language; a save never rewrites comments; there is no
re-annotate endpoint.

- The console visual pages are unaffected: `saveConfig` still accepts the
  flat runtime shape; grouping is internal to the config module.
