# ADR-0036 — Plugin Engine Versioning: One Integer, One Refused Package

- Status: Accepted (implemented), Amendment 1 — the engine version is the
  contract version
- Date: 2026-11-24
- Amended: 2026-11-27 — the `engines` semver window is REMOVED; see
  "Amendment 1" below. The Context, the console/install/load consequences and
  every user-visible behaviour of this record still hold. Sections 1–3 of the
  original decision are superseded.

## Context

`apiVersion` answered exactly one question: *which plugin contract was this
package written against?* Before this record it was a strict-equality gate —
`apiVersion !== SUPPORTED_PLUGIN_API` and the package was refused at install and
at load. That is a **cliff**, not a declaration, and it has two costs that both
land on the operator:

- **The refusal is undiagnosable.** A refused package used to throw one sentence
  during load and leave nothing else: after an upgrade the operator saw an
  integration vanish, with no console row naming which package was refused or
  what to do.
- **The failure mode was silent in the other direction too.** Nothing in the
  manifest said *which* engine a package was built for, so nothing could warn an
  operator about a package that could not run here until it failed to import.

The first version of this record answered both by giving the engine its own
semver version (`PLUGIN_ENGINE_VERSION = '1.0.0'`) and letting each package
declare a semver **window** in a separate `engines: { plugin: '^1' }` map, which
core parsed and compared. Amendment 1 removes the window; the refusal machinery
it introduced is kept.

## Decision

### 1. The engine version IS the plugin contract version

`PLUGIN_ENGINE_VERSION` (`backend/src/plugins/manifest.ts`) is one **integer**,
and it is the same number as `SUPPORTED_PLUGIN_API` — by construction
(`SUPPORTED_PLUGIN_API = PLUGIN_ENGINE_VERSION`), never by coincidence.

A separate engine release number could only carry information in one of two
ways, and neither survives inspection:

- **A release that does not change the plugin surface.** Then it is not a
  different engine as far as a package is concerned, and a package naming it is
  saying nothing.
- **A release that does change what a package can notice.** Then it is a
  contract change by definition, and `apiVersion` is the field that already
  says so. `createPlugin(host)` has no second dimension for a package to depend
  on.

A semver minor/patch pair therefore had no way to be used except by an author
hand-narrowing their own window (`>=1.4.0`), which is the author asserting a
compatibility the gateway cannot verify. The integer states the fact once.

**Bump discipline.** Raising `PLUGIN_ENGINE_VERSION` is the ONLY step a surface
change needs: packages declaring the previous value are then refused with a
sentence naming which side is behind. Nothing else in core reads the constant —
there is no window to re-evaluate, no floor table, no ceiling.

### 2. A package declares the engine in `apiVersion`; there is no second field

```json
{
  "id": "qoder-models",
  "version": "0.5.0",
  "apiVersion": 1
}
```

`apiVersion` is a positive integer and must sit inside
`[MIN_SUPPORTED_PLUGIN_API, SUPPORTED_PLUGIN_API]`.

The `engines: { plugin: <semver window> }` map introduced by the first version
of this record is **retired**. It could only ever restate the integer above in a
second vocabulary — two truths for one fact, which this repo forbids by name
(AGENTS.md "Single-source constants — no drift twins"). A package that still
carries the key is **not** rejected for it: the key is simply not read, the same
way any unknown manifest key is not read, because refusing it would fail
packages for a field that used to be required.

`MIN_SUPPORTED_PLUGIN_API` bounds the contract from below — equal to
`SUPPORTED_PLUGIN_API` today (one contract, no legacy), and raising it retires
the contracts in `[MIN, SUPPORTED)` exactly the way a too-new one is refused.

### 3. One gate, two directions, one sentence each

`pluginEngineCompatibility()` is the **only** place the rule is read (loader,
installer, and console all reach it through `pluginEngineRefusal`):

1. `apiVersion` **above** `SUPPORTED_PLUGIN_API` — the package was written
   against a surface this build does not have. `contract-too-new`. The remedy is
   updating the GATEWAY; reinstalling the same file moves nothing.
2. `apiVersion` **below** `MIN_SUPPORTED_PLUGIN_API` — the contract it targets
   has been retired. `contract-too-old`. The remedy is installing the package's
   newer release.

Otherwise it loads. There is no third gate, no window, no floor and no ceiling.
Both sentences come from **core** (`pluginEngineRefusal`), never from a package:
they are instructions about what the operator must do, and they must name the
right side to act on.

Syntax needs no fail-open carve-out any more, and that is part of the win: a
string where an integer belongs is rejected by `validatePluginManifest` at the
same moment on both sides — the packager (`bundlePluginDir` in
`plugins/pack.ts` validates the manifest it is about to ship, because
`collectPluginAssets` copies `plugin.json` verbatim and nothing else would catch
an invalid declaration before an operator received the package) and the loader
(rejecting an unreadable manifest as a failed row, as it always did).

### 4. Load: a refused package is a DISABLED ROW, not a crash

The gate runs **before the import** (and before `ensureUnpacked`) **and ahead of
the disabled-ledger check**, so refused code never reaches the module cache,
leaves no extracted directory behind, and a package that is both incompatible
and switched off still reports the reason a switch cannot fix. The row
(`incompatibleView`) is:

- `disabled: true`, `loaded: false`, `incompatible: true`, `error` = the core
  sentence;
- no `wires`, no presets, no traffic;
- **not** written into the disabled ledger — writing it there would outlive the
  mismatch and keep an already-compatible package switched off;
- re-judged on every load from the manifest on disk, so an upgrade of either
  side clears it with no operator action.

The package still OCCUPIES its id: a lower-priority copy of the same id must not
load silently beside it. `loadInstalledPlugins()` still returns only what
LOADED (unchanged contract); the refused row is appended to `lastViews`, which
is what `listInstalledPlugins()` and the console see.

### 5. Install: the bytes stay on disk

`installPluginPackage` refuses an incompatible package **before touching disk**
(nothing is written, nothing is half-installed), answering 400 with the core
sentence. When a refusal still shows up — a file already present, a gateway that
was downgraded under it — the install route treats it like any other row: the
package stays, listed disabled, and the response carries the plugin list so the
console can show it at once.

This is a deliberate difference from a **load failure**: a failed package is
discarded (and the previous version restored), because a package that fails on
every boot helps nobody. A refusal is just an ordinary install waiting for the
other side to catch up, and discarding it only forces the operator to re-upload
the same file after the upgrade.

### 6. The console names which side to upgrade

`PluginView.incompatible` is the API contract for this state (mirrored as
`PluginViewInfo.incompatible`). The plugins page renders it as an `Incompatible`
badge with a localized hint pointing at the action, and hides the disable/enable
switch — that switch only edits the ledger, while the refusal comes from the
loader. Uninstall and settings stay reachable: a refused package is still the
operator's file, and its schema is served without importing it.

## Amendment 1 — the window is gone (2026-11-27)

Section 1–3 above originally specified a semver `PLUGIN_ENGINE_VERSION` plus an
`engines.plugin` window parsed by `parseWindow` (`^`/`~`/`>`/`<`/`||`/hyphen
ranges), with an implicit `^apiVersion` default for packages that declared
nothing.

Why it was removed:

- **It duplicated `apiVersion`.** One engine version implements one contract, so
  the window could only be an integer in disguise. A reader could not tell which
  field was authoritative, and no rule kept them agreeing.
- **The advanced grammar bought nothing.** `>` vs `>=`, upper bounds, `~` vs
  `^`, `||` unions and hyphen ranges were all exercised by tests and by no
  production manifest: every shipped package declared `^1`, which is the
  contract integer. Complexity that only tests can see is not a feature.
- **Its escape hatch was a lie in both directions.** A window that failed to
  parse had to be tolerated at load ("no opinion", so a hand-edited file could
  not brick an install), which meant a typo could ship a package claiming a
  compatibility it never stated — and closing that hole required a new packaging
  gate that existed only to police a grammar nobody needed.

What survived, unchanged: the two-direction refusal with two distinct sentences,
the disabled-row shape (`incompatible`, `wires: []`, not in the ledger),
gate-before-disabled ordering, gate-before-`ensureUnpacked`, install-time
refusal before disk, and the console badge. They were the point; the window was
the vehicle.

**Compatibility note.** No shipped package needed a change to keep loading: all
seven declare `apiVersion: 1`, and the retired `engines` key is ignored rather
than rejected. There is no migration step and no schema version bump.

## Consequences

- A surface change is now exactly one edit — raise the integer — and the effect
  is visible to every installed package at the next load.
- The next engine bump is a real, public break: every package declaring the old
  contract stops loading, in a way the operator can see and act on.
- A refused package is never silent. The old behaviour (throw once, then a list
  without the package) is gone.
- There is only ONE declaration of what a package targets, and only ONE reader
  of it, which is the property the window could not offer.