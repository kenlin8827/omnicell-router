# ADR-0027 — Client-Adapters as Plugins: A Third Plugin Type for Client Hooks

- **Status:** Implemented
- **Date:** 2026-11-15
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (plugin contract), [ADR-0026](./0026-mitm-canonical-seam.md) (gateway-owned model traffic), [ADR-0015](./0015-harness-artifacts.md) (harness roster order)

## Context

Client Hub hooks — OpenCode provider injection, Claude config rewrite, the Cursor/Qoder/JetBrains launcher hooks, OpenCode proxy mode — were a closed compile-time map:

```ts
const adapters: Record<SupportedClient, ClientAdapter> = { opencode: …, claude: …, … };
```

Three consequences followed, and only the first was intentional:

1. **Exhaustiveness.** `Record<SupportedClient, …>` made "every client id has exactly one hook" a type-checked fact. That is genuinely useful for the hooks the build ships.
2. **Adding a client cost a core release.** A third party could add an outbound provider (model-service) or an inbound host (client-gateway) without touching core, but the Client Hub layer — arguably the most vendor-specific surface of all — had no extension point at all.
3. **Every shipped hook is mandatory.** `opencode-proxy` in particular is a niche mode with sharp edges (it requires an enabled `forwardProxy`, it writes a MITM CA into opencode's trust store, and `service set env` does not reach `--standalone` / `serve` / shell-launched CLIs). Operators who never use it still carried its code, its console row, and its failure modes.

## Decision

### 1. A third plugin type: `client-adapter`

A `client-adapter` package provides ONE Client Hub hook. Its manifest carries no `hosts` and no `wires` — those are the other two axes' vocabulary:

| type | owns | claims |
|---|---|---|
| `model-service` | outbound provider executors | `wires` |
| `client-gateway` | an inbound vendor host on the forward proxy | `hosts` |
| `client-adapter` | one client's hook state | — (the adapter's own `name`) |

`createPlugin(host)` returns the adapter object itself: `{ name, displayName, hookKind, getConfigPath(), getStatus(), setup(), teardown(), …optional }`. The host validates exactly those members before registering; anything else is the core registry's business.

### 2. The host SDK is facts, not policy

```ts
interface ClientAdapterHost {
  log(...args: unknown[]): void;
  ocrHome(): string;        // sidecar/backup files live under it
  pluginDir(): string;      // the ONE asset root of the package
  config(): Record<string, unknown>;   // merged, validated operator config
  forwardProxy(): { url; port; caPath; requireCredential } | null;  // LIVE snapshot
  caCertPath(): string;     // resolved even when the proxy is off
}
```

Deliberately absent: config mutation, key lookup, and the `ClientHookStatus` / `ClientActionResult` vocabulary. A plugin returns plain objects and the core registry types them at the boundary, so a package cannot widen the contract by drifting — the same rule the other two types already follow.

`forwardProxy()` reads the **runtime** snapshot (falling back to a config load only when no server snapshot is bound, e.g. the standalone CLI), never a stale config once the server is running: a hot reload can move the port, and a hook that advertises a port the running proxy does not listen on produces a client that 401s on every turn.

### 3. Core first, plugins second, collisions refused

Two maps, one lookup order:

- `cli/clients/core-adapters.ts` — the hooks this build ships, exported as `CORE_ADAPTERS`, typed `Record<CoreClientId, …>` so the map and the reserved id list cannot drift. The id list itself (`CORE_ADAPTER_IDS`, `CoreClientId`, `RETIRED_CLIENT_IDS`) lives in `cli/clients/reserved.ts`, a LEAF module: the plugin registry can then read the reserved ids without importing the adapter classes, which import the config loader, user-config and the credential store — a module-graph edge that would otherwise reach every caller of the plugin host.
- `cli/clients/plugin-adapters.ts` — plugin-contributed hooks, rebuilt with the plugin host in ONE transaction: registrations stage, and the set is swapped at the commit point, so a failed rebuild keeps the previous hooks live instead of leaving the Client Hub empty.

`getClientAdapter(name)` asks core first. Registration **throws** on a core id (`a plugin cannot replace a built-in hook`) and on a second package claiming an id already taken (`already provided by plugin 'X'`) — both surface as that package's own load error in the console, never as a row whose behaviour depends on install order.

`getAllClientAdapters()` appends plugin rows AFTER the built-in ones, so installing a package cannot reshuffle the roster.

### 4. `opencode-proxy` leaves core

> **Superseded by [ADR-0028](./0028-multi-part-plugins.md):** the package is now `plugins/opencode-gateway/` and the client id moved with it (`opencode-gateway`, same `service-env` kind, sidecar `opencode-gateway.env-meta.json`), because this half and its gateway ship as one multi-part package.

The OpenCode proxy-mode hook left core as `plugins/opencode-proxy/` (366 lines of core code → a package that depends only on the SDK). It is the first real user of this seam, and it is the reason the type exists at all: a hook that is not for everyone should be installable, not mandatory.

What did NOT change at that step: the `service-env` hook kind, and the fact that the CLI verb, the console label and the i18n keys kept working. `opencode-proxy` then became a **retired** id: when the half merged with its gateway into `plugins/opencode-gateway/` (ADR-0028), the client id and the sidecar moved with it (`opencode-gateway`, `<ocrHome>/opencode-gateway.env-meta.json`), and registration now REFUSES the old id (ADR-0029 §3) instead of opening a second row for the same client.

## Consequences

- **`ClientAdapter` ids are no longer exhaustive at compile time.** The built-in map is typed `Record<CoreClientId, …>` over the reserved id list in `cli/clients/reserved.ts`, while `SupportedClient` types the ids the console and CLI can ADDRESS (core hooks plus the documented package hooks). A plugin-provided id outside that union is typed as `SupportedClient` at the boundary anyway (the adapter object is structurally cast), which is why the union is a *label/CLI* vocabulary and not a runtime allow-list. Making it a runtime allow-list would have re-closed the extension point.
- **The console roster is now install-dependent.** A `client-adapter` row appears only while its package is loaded and enabled. The Plugins page renders the third type with its own label (`pluginPage.typeClientAdapter`, all eight locales).
- **Packages were not shipped with the desktop bundle at this step.** *(Superseded by ADR-0029 §1: the app now seeds `<ocrHome>/plugins/bundled` from `.plugin-dist` on every host rebuild.)* `tauri.conf.json` resources carried `frontend/dist` + the backend binary, and nothing seeded the app-owned tier, so moving a hook out of core meant an operator must install the package (or run a dev tree). That was acceptable for `opencode-proxy` — a niche mode the operator opts into — and it was the reason no *default* hook was moved. Shipping bundled plugin packages is the prerequisite for moving one, and it is a packaging task, not a plugin-contract change.
- **The CLI resolves plugins lazily.** `setupClient` / `teardownClient` / `getAllClientStatuses` await `ensurePluginClientAdapters()`, which runs the plugin host once per process when it has not run yet (`isPluginHostInitialized()`), so `ocr setup opencode-gateway` works in the standalone CLI, which never boots the server. A CORE command never preloads the host: only an argv token that is not an OCR command (a launch-verb candidate) or `help` does, so a pure-JSON command like `ocr shims-status` cannot be polluted by plugin boot output.
- **A broken package cannot take the Client Hub down.** The lazy load swallows failure and the core map is untouched by it; a package that throws during `createPlugin` becomes a failed row in the Plugins page and contributes nothing.

## Not decided here

`opencode-gateway` — a Cursor-style client-gateway plugin that claims opencode's vendor hosts — was first considered as a REPLACEMENT for this hook, and rejected on that reading. Cursor needs a gateway because it speaks a private Connect/protobuf wire with its own catalog RPCs; opencode speaks the standard wires and takes its model picker from `models.dev` plus its own `providers` node, not from a vendor `/v1/models`. "See the preset models in opencode" is therefore an outbound problem, solved by provider injection (`clients/opencode.ts`), and claiming `api.anthropic.com` buys nothing for it.

The rejection was correct about the replacement and wrong about the scope: **config mode and proxy mode are two different products.** Config mode injects an OCR provider and never touches a proxy. Proxy mode leaves the client's providers, models and keys exactly as they are and owns the traffic that leaves through the forwardProxy instead — a job the canonical row does generically and this package does with OpenCode's policy (target model for refs the catalog lacks, forced model, bound metering key). So the gateway exists (`plugins/opencode-gateway/`), and this hook stays: it is proxy mode's ingress, per §5 below.


### 5. Proxy mode is one package with two parts

OpenCode proxy mode needs both halves: a `client-adapter` (the ingress that makes the client's traffic enter the forwardProxy — service env + MITM CA) and a `client-gateway` (the owner of the model requests on the claimed hosts). An earlier revision of this ADR shipped them as two packages, `opencode-proxy` and `opencode-gateway`, arguing that the axes are independent. The axes ARE independent; these two halves are not. Without the ingress the gateway sees no traffic, and without the gateway the ingress only buys the built-in row's generic treatment — so two packages meant installing a half that does nothing to make the other half work.

They now ship as one package, `plugins/opencode-gateway/`, declaring `parts: [client-adapter, client-gateway]` (ADR-0028). Nothing about the axes changed: a `client-adapter` still has no claim and a `client-gateway` still has no lifecycle. What changed is the PACKAGING unit — a manifest may occupy more than one axis, and the host calls `createPlugin` once so both halves share one closure and one config artifact.

One package also keeps install/uninstall atomic: the Client Hub row and the claims appear and disappear together, which is the only honest state for a product whose halves are useless apart.
