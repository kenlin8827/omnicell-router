# ADR-0032 — Plugins Are Optional: No Release Ships A Package

- **Status:** Implemented
- **Date:** 2026-11-17
- **Supersedes:** [ADR-0029](./0029-package-lifecycle.md) §1 (the app seeding its own tier from shipped build artifacts) and its "a fresh install has the shipped packages on first boot" consequence
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (plugin contract, app-owned tier), [ADR-0027](./0027-client-adapter-plugins.md) (client-adapter packages), [ADR-0028](./0028-multi-part-plugins.md) (multi-part packages), [ADR-0030](./0030-client-hooks-ship-with-their-gateway.md) (hooks travel with their gateway)

## Context

ADR-0029 §1 turned `.plugin-dist/*.zip` into a shipped artifact so that a package could be the delivery mechanism for a product feature: the desktop bundle carried `.plugin-dist/` as its `plugins/` resource, the npm tarball listed `.plugin-dist` in `files`, the desktop shell pointed `OCR_BUNDLED_PLUGIN_SRC` at its resource dir, and every boot copied those zips into `<ocrHome>/plugins/bundled/` as **app-owned** packages.

That made every plugin a mandatory part of every release, in both distribution channels, for every operator:

- The installer and the npm package carry integration code — and its vendor wire decisions — that a given operator may never use.
- The packages are app-owned by definition, so the upload route REFUSES to shadow or upgrade them (ADR-0017 §6). Fixing a plugin therefore requires an application release, and an operator who wants a different version has no supported path.
- Choosing not to have an integration is not a choice the product offers: uninstall writes a tombstone, the bytes stay, and the next release re-embeds the same files.

The operator requirement is the opposite one: **plugins are optional and must not be distributed at all.** The gateway is the product; a plugin is something the operator adds.

## Decision

### 1. No channel carries a package

- `desktop/src-tauri/tauri.conf.json` bundles `frontend/dist/` only. There is no `plugins/` resource, so the installer, the MSI, and the portable exe contain the shell, the console assets and the gateway sidecar — nothing else.
- The root `package.json` `files` list no longer includes `.plugin-dist`, so the npm package ships `bin/`, `backend/dist/`, `frontend/dist/` and the docs. Installing the CLI never installs a plugin.
- The desktop shell no longer sets `OCR_BUNDLED_PLUGIN_SRC`, so a packaged install has no plugin source to point at.

`.plugin-dist/` remains a BUILD OUTPUT (`bun run plugins:build`): it is the artifact set an operator installs from, not an artifact of a release.

### 2. Staging the app-owned tier is explicit, never automatic

`bundledPluginSourceDir()` returns a directory ONLY when `OCR_BUNDLED_PLUGIN_SRC` names one. The repo-local fallback (`<root>/.plugin-dist`, resolved from the module's own location) is REMOVED: a source run must not silently promote a checkout's build output into app-owned state, because app-owned packages cannot be uploaded over.

A normal boot therefore stages nothing and finds an empty `bundled/`. `OCR_PLUGIN_SRC_DIR` still disables staging outright (a dev tree beats any packaged copy).

### 3. The app-owned tier keeps its semantics, minus the shipping story

`<ocrHome>/plugins/bundled/` still exists (ADR-0017 §6): a package placed there is app-owned, wins discovery precedence over an operator install, cannot be shadowed by an upload, and is tombstoned (not deleted) on uninstall. It is filled only by an explicitly named staging source or by an operator who deliberately places a file. All of ADR-0029's staging mechanics stand unchanged — byte-compare so mtimes (and `ensureUnpacked`) are not invalidated, one copy per id, invalid manifests are not staged, tombstones untouched.

### 4. Lifecycle and wording follow the new fact

Install/upgrade/refusal/tombstone behavior is unchanged (ADR-0029 §2–4). The ownership refusals say what is now true — `'<id>' is an app-owned package (plugins/bundled) — disable it from the plugins page instead of installing an override` and `plugin id 'ocr-*' is reserved for app-owned packages` — instead of claiming that something "ships with the gateway".

### 5. The install surface is the console

The Plugins page remains the one place a package is added (`POST /plugins/install`, upload a zip from `.plugin-dist/` or from a package's own release). The picker accepts several packages at once: the console uploads them **one at a time**, so each `POST` still carries exactly one zip and keeps its per-package rollback, and a package that fails is reported without cancelling the rest of the batch. There is no automatic download, no update channel, and no first-boot fetch: an operator who wants a gateway, a model service, or a client hook installs it, and an operator who does not gets a gateway with no plugin rows.

## Consequences

- A fresh desktop install has ZERO plugins. The integrations that used to arrive on first boot — `opencode-gateway` (proxy mode), `cursor-gateway`, `qoder-gateway`, `jetbrains-gateway` (forward-proxy client hooks) and `qoder-models` / `workbuddy-models` (model services) — are absent until installed. The affected Client Hub rows and provider types are simply not offered.
- Releases stop fixing plugins, and plugins stop forcing releases. A package's version is the operator's to choose, and a plugin upgrade never needs an app upgrade.
- Nothing is app-owned by accident: `bundled/` is empty on a normal install, so the upload route cannot be blocked by a package nobody asked for.
- The `ocr-*` id reservation is now purely a namespace guard (core vocabulary vs. operator packages), not a statement that such a package exists.
- Boot writes into `<ocrHome>/plugins/bundled/` only when a staging source was named; a read-only home is unaffected.
- A regression in `tauri.conf.json` that reintroduces the `plugins/` resource, or a `files` entry that reintroduces `.plugin-dist`, would silently re-distribute packages. The build must keep both absent; the desktop shell must not set `OCR_BUNDLED_PLUGIN_SRC`.
