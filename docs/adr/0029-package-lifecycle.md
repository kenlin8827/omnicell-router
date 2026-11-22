# ADR-0029 — Package Lifecycle: Shipping, Upgrading, Refusing

- **Status:** Implemented (as amended)
- **Date:** 2026-11-15
- **Amended by:** [ADR-0032](./0032-plugins-are-optional.md) — §1 no longer ships or auto-seeds packages; the staging mechanics below stand, the shipping story does not
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (plugin contract), [ADR-0027](./0027-client-adapter-plugins.md) (client-adapter packages), [ADR-0028](./0028-multi-part-plugins.md) (multi-part packages)

## Context

Three gaps showed up the moment plugin packages stopped being one-copy-per-machine curiosities and became how product features ship:

1. **Nothing ever populated the app-owned tier.** `<ocrHome>/plugins/bundled/` was designed (precedence over operator installs, tombstone-on-uninstall) but the build pipeline wrote only `.plugin-dist/`. Every hook that left core for a package — `opencode-gateway` is the first (ADR-0027 / ADR-0028) — was therefore absent from a fresh install until the operator uploaded a zip by hand. "Ships as a plugin" silently meant "ships as nothing".
2. **Install had no version policy.** Uploading any zip claiming an id replaced whatever was there. A stale download could roll a fixed install back with no signal, and the only trace was the version cell in the console.
3. **A renamed client id came back to life.** `opencode-proxy` stopped being a built-in hook when its package merged (`opencode-gateway`). The old package on an operator's machine then registered under the retired id, producing a SECOND Client Hub row for the same client — two sidecars, two writers of the same env, and whichever ran last won. Nothing surfaced the conflict, because nothing considered it a conflict.

A fourth, smaller one: `importPlugin` staged a gateway before registering its adapter, so a package that failed registration still had its gateway committed — a console row saying "error" while the gateway kept intercepting that client's traffic.

**Amendment:** ADR-0032 later withdrew the shipping half of this record (§1's automatic seeding from build artifacts and the app-owned-by-default consequence). Plugins are optional and no release distributes a package; the lifecycle mechanics below are unaffected.

## Decision

### 1. The app-owned tier is staged explicitly, never shipped

ADR-0032 removed the shipping half of this decision: no release artifact carries a package, the desktop shell no longer names a source, and the repo-local fallback is gone. `seedBundledPlugins()` therefore copies only from a source `OCR_BUNDLED_PLUGIN_SRC` explicitly names, and does nothing when nothing is named. The staging mechanics are unchanged:

- **Bytes are the version.** An identical file is left untouched — rewriting it would change its mtime, which is the key `ensureUnpacked` uses to decide whether to re-extract, so a careless seed would re-extract every package on every boot.
- **One copy per id inside the tier.** A renamed artifact deletes the previous file claiming the same id: discovery sorts by FILE NAME, so a leftover would win or lose by accident.
- **A package that does not validate is not seeded.** A half-written build artifact would become an app-owned package that shadows a working operator install.
- **A dev tree disables seeding.** `OCR_PLUGIN_SRC_DIR` means the operator is editing sources; promoting a stale `.plugin-dist` over the tree under edit is the one outcome that must never happen.
- **Tombstones are untouched.** `disabled.json` is the operator's ledger; a re-seeded package stays disabled until they say otherwise.

### 2. Upgrade is a higher version; downgrade is a refusal

`installPluginPackage` compares the uploaded manifest's version with the packaged one already on disk (ADR-0017 §6 packaging, semver via `utils/semver.ts`):

- higher → upgrade: package replaced, `<pluginsRoot>/config/<id>.json` untouched, unpacked tree re-extracted;
- equal → rebuild: allowed (this is how a broken build gets replaced);
- lower → **refused**, with the installed version named and "uninstall it first" as the remedy.

The refusal is the point: the console's upload button cannot tell a mistake from a deliberate rollback, so the deliberate one has to be explicit. The one internal caller that may downgrade is the install ROUTE's rollback path, which restores the previous bytes after a package fails to load — it passes `allowDowngrade` because the operator never asked for that replacement in the first place.

### 3. Retired client ids are refused, not aliased

`RETIRED_CLIENT_IDS` maps a former built-in hook id to its replacement (`opencode-proxy` → `opencode-gateway`). `registerPluginClientAdapter` refuses such an id, which makes the stale package fail to load and show up as **an error on its own console row** — with the replacement's name in the message.

There is no aliasing layer, and that is deliberate. Aliasing would make an incompatible package look installed-and-working, which is worse than a visible failure: the operator would have two rows for one client and no statement anywhere about which one they should keep. Incompatibility is a state the console can SHOW; hiding it is the only real mistake.

### 4. Registration fails closed

- The adapter part is registered BEFORE the gateway is staged. It is the half that can refuse a package (built-in / retired / duplicate client id), so refusing it must happen before any traffic ownership exists.
- At the commit point the loader keeps staged gateways only for ids that produced a LOADED row. A gateway that intercepts with no row to disable is unreachable state — the operator's only remedy would be editing files by hand.
- Plugin-contributed client hooks ride the same transaction: registration fills a staging map and the adapter set is swapped at this commit point, so a rebuild that throws keeps the PREVIOUS hooks live. The failure that must never happen is the half-state — an empty Client Hub while the proxy legs still intercept.
- A failed row keeps the manifest's name, version and declared axes when the manifest was readable. "Which kind of plugin is this, and which version" is exactly what an operator needs to identify a broken package.

## Consequences

- A fresh install has an EMPTY app-owned tier: the gateway boots with no plugins, and nothing arrives with a release (ADR-0032). Only an explicitly staged source or a deliberately placed file makes a package app-owned.
- App-owned packages are the ones the upload route refuses to shadow (ADR-0017 §6); since nothing is app-owned unless the operator staged it, a normal operator install is the normal path.
- Boot writes into `<ocrHome>/plugins/bundled/` only when a staging source was named. It is idempotent and byte-compared, and with no source it is a pure no-op.
- Packages are no longer silently forward-compatible with a renamed client id. An old package fails loudly; the operator removes it and installs the replacement. The console is the migration UI — there is no automatic one, on purpose.
- `config/<id>.json` still outlives a version change, so a field renamed by the new version stops applying (the new default takes over) while the old key stays in the file. A migration hook per version remains unimplemented; until then a rename is a breaking change to declare in the release notes, not something the host guesses at.
