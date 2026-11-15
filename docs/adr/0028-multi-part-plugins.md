# ADR-0028 — Multi-Part Packages: One Manifest, Several Extension Axes

- **Status:** Implemented
- **Date:** 2026-11-15
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (plugin contract), [ADR-0026](./0026-mitm-canonical-seam.md) (gateway-owned model traffic), [ADR-0027](./0027-client-adapter-plugins.md) (client-adapter packages)

## Context

A plugin's manifest declared exactly one extension axis:

```ts
interface PluginManifest {
  type: 'model-service' | 'client-gateway' | 'client-adapter';
  wires?: string[];
  hosts?: string[];
}
```

The host read `manifest.type`, imported the entry once, and validated the one shape that type implies. That was correct while every product happened to live on one axis.

OpenCode proxy mode broke the assumption. It is one product with two halves on two DIFFERENT axes:

- a `client-adapter` — the ingress that writes `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` into OpenCode's managed service, without which its traffic never reaches the forward proxy (OpenCode runs on Bun and ignores the OS proxy setting); and
- a `client-gateway` — the claims and request handling for the model hosts it reaches.

Neither half is useful alone. Under the one-axis rule the only options were:

1. **Two packages.** What ADR-0027 §5 originally shipped. It worked, but the operator had to install `opencode-proxy` (which does nothing without a gateway) and `opencode-gateway` (which can never see a request without the ingress), and the Client Hub row of the first pointed at a product the second owned.
2. **One package, one fake type.** Impossible: the two halves need different host seams (`forwardProxy`/`caCertPath` vs `chat`/`relayUpstream`) and different lifecycle calls (register an adapter vs stage a gateway).
3. **Fold one axis into the other.** Rejected in ADR-0027 §5 for a reason that still holds: a `client-adapter` has no claim, and a `client-gateway` has no setup/teardown, so either direction would give a part capabilities its contract says it does not have.

The axis list was never meant to be a taxonomy of PACKAGE KINDS. It is a list of independent capabilities, and nothing about "one capability per axis" requires "one axis per package".

## Decision

### 1. `parts` — a package declares every axis it occupies

```jsonc
{
  "id": "opencode-gateway",
  "apiVersion": 1,
  "parts": [
    { "type": "client-adapter" },
    { "type": "client-gateway", "hosts": ["api.openai.com", "api.anthropic.com"] }
  ]
}
```

`type` / `wires` / `hosts` remain valid as the SINGLE-part spelling. The two spellings are mutually exclusive: a manifest that says `type` and `parts` has stated its axes twice, and the second copy is exactly the drift a one-truth manifest exists to prevent. Top-level `wires`/`hosts` are likewise refused once `parts` is present — a claim list belongs on the part that claims it.

Per part:

| part | requires | forbids |
|---|---|---|
| `model-service` | non-empty `wires` | — |
| `client-gateway` | non-empty `hosts` | — |
| `client-adapter` | nothing | `wires`, `hosts` (its contribution is a hook, not a wire or a claim) |

At most one part per axis: the host registers one gateway and one adapter per package id, so a second entry would silently lose.

`normalizePluginParts()` is the ONE reader of both spellings. The loader, the console row, the packager and the typecheck gate all call it — none of them re-derives "type or parts?".

### 2. One `createPlugin` call, one result object

A multi-part package's entry returns every half it declared:

```ts
export function createPlugin(host: ClientAdapterHost & ClientGatewayHost): PluginEntryResult {
  return { clientAdapter: createIngressAdapter(host), gateway: createGatewayPlugin(host) };
}
```

The host calls `createPlugin` ONCE and passes a host object carrying the UNION of the parts' seams. Calling it once per part was rejected: the two halves would be two closures over one config artifact, so a value read by the ingress and a value read by the gateway could disagree after a settings save.

Single-part packages keep returning their object directly (adapter / gateway / provider); the host classifies the result by shape, exactly as it did before. A package may also return `PluginEntryResult` explicitly.

**Every declared part must be present.** A missing half fails the whole load with the part named in the error. Registering the half that loaded would leave a console row that looks installed while the reason it was installed silently answers nothing.

### 3. Registration and unregistration stay atomic

The load path stages the gateway, registers the adapter and fills the model-service registry from the same result, and `PluginView.types` reports every axis so the console can render one label per part. Disable/uninstall already run through the same rebuild (or the same hot-unplug calls), so a multi-part package cannot leave half of itself behind.

### 4. What this does NOT change

- **The axis contracts.** A `client-adapter` still receives only facts, a `client-gateway` still owns its hosts, and neither gains the other's capability. A part cannot tell, from its own seam, that a sibling part exists.
- **Inter-part communication.** There is none, and none is needed: the halves share a closure because they are constructed by the same function, not because the host brokers messages. A package that wanted a cross-axis protocol would be describing a new axis, which is a separate ADR.
- **Claim ordering.** A multi-part package's gateway takes part in `findGateway` exactly like a single-part one (exact claims first, wildcard last, built-in row last).

## Consequences

- **One install, both halves.** `plugins/opencode-gateway/` replaces `plugins/opencode-proxy` + the old gateway package: the Client Hub row and the host claims appear and disappear together. ADR-0027 §5 is revised to match.
- **A new packaging capability, not a new capability model.** Packages with one axis are untouched — all existing manifests still validate, load and behave identically (the single-part path in `importPlugin` is the original code).
- **The console gains a multi-label column.** `PluginView.types` is additive; `type` remains `types[0]` so every existing consumer keeps working.
- **Packing is unchanged.** The entry is still bundled into one `index.js`; a package's parts are source modules that the bundler inlines. `collectPluginAssets` already excludes sources at any depth.
- **A blunt edge worth naming:** a multi-part package cannot be split at install time ("install the gateway but not the ingress"). That is deliberate — the whole point was that these halves are useless apart — but a future product whose parts ARE independently useful should ship as two packages rather than inventing a partial-install flag.

## Alternatives considered

- **`types: ['client-adapter', 'client-gateway']`** (array in place of `type`). Rejected: `wires`/`hosts` have no home in a flat array, so they would either become top-level again (one list, two possible owners) or need parallel arrays. `parts` keeps each axis' vocabulary attached to its axis.
- **Per-part `createPlugin` calls.** Rejected above: two closures over one config artifact.
- **A `client-adapter` that may also declare `hosts`.** Rejected: it would make the adapter's lifecycle the owner of a claim it cannot answer, and duplicate the wildcard/ordering logic that lives in the gateway registry.
- **Keeping two packages and auto-installing one from the other.** Rejected: an install that silently installs a second package is a dependency graph the plugin host does not have, and uninstall would need reference counting.
