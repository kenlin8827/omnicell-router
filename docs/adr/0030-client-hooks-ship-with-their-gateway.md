# ADR-0030 — Client Hooks Ship WITH Their Gateway

- **Status:** Implemented
- **Date:** 2026-11-15
- **Relates to:** [ADR-0017](./0017-client-gateway-plugins.md) (gateway plugins), [ADR-0027](./0027-client-adapter-plugins.md) (client-adapter packages), [ADR-0028](./0028-multi-part-plugins.md) (multi-part packages), [ADR-0029](./0029-package-lifecycle.md) (package lifecycle)

## Context

The Client Hub rendered four forward-proxy rows — Cursor, Qoder, JetBrains IDEs, OpenCode (proxy mode) — from two different places:

- `opencode-gateway` was ONE multi-part package: its ingress hook and its gateway shipped together.
- Cursor, Qoder and JetBrains were **core adapters** (`cursor-proxy.ts`, `qoder-proxy.ts`, `jetbrains-proxy.ts` + `jetbrains-junie.ts`, ~3.4k lines) while their gateways were packages (`cursor-gateway`, `qoder-gateway`, `jetbrains-gateway`).

That split was not a design decision, it was a migration that stopped halfway. It produced a class of bugs and hardcoding that only exists because of the split:

1. **A row that cannot work.** `cursor-proxy`'s hook writes launchers that send Cursor to the forward proxy, but nothing answers those hosts without `cursor-gateway`. The operator could hook a client that then relayed everything transparently — so the console carried a `GATEWAY_PLUGIN_BY_CLIENT` table to disable the setup button, and a `LAUNCH_COMMANDS` table to know the `ocr cursor` verb.
2. **Client knowledge in core that core cannot use.** `ocr cursor` / `ocr cursor-agent` / `ocr qoder` / `ocr qoder-cli` were hardcoded `CliAction` members dispatching to imported client modules, and the help text listed every client by hand.
3. **A lifecycle the package could not own.** Uninstalling `cursor-gateway` left the `cursor-proxy` row behind, hooked and useless; the two halves had different upgrade paths.
4. **`SupportedClient` was a lie in both directions.** It claimed to be "the ids of the hooks that ship in this build" while listing ids whose gateways were packages.

ADR-0028 already provided the mechanism (one package, several axes). The missing pieces were all on the HOST side: a launcher hook needs facts the adapter SDK did not expose.

## Decision

### 1. The forward-proxy family ships as ONE package per product

`cursor-gateway`, `qoder-gateway` and `jetbrains-gateway` are now multi-part packages: `parts: [client-adapter, client-gateway]`, one `createPlugin(host)` call returning `{ gateway, clientAdapter }` (ADR-0028). The adapters left core (`cursor-proxy.ts`, `qoder-proxy.ts`, `jetbrains-proxy.ts`, `jetbrains-junie.ts` deleted); `CORE_ADAPTERS` no longer contains a single forward-proxy hook.

**Client ids are unchanged** (`cursor-proxy`, `qoder-proxy`, `jetbrains-proxy`): they are the public hook ids operators type (`ocr setup cursor-proxy`), the sidecar filenames and the launcher names on machines that are already hooked. The package id and the hook id differ on purpose — the package is "Cursor support", the hook is "the Cursor launcher" — and nothing in the console needs them to be equal any more (see §3).

### 2. The host SDK grew the facts a launcher/proxy hook actually needs

`ClientAdapterHost` gained five seams. Each one is a fact only the host knows, and each one replaced a core module the adapter used to import:

| seam | replaced | why the package cannot derive it |
| --- | --- | --- |
| `forwardProxyStatus()` | `forward-proxy/status.ts` | liveness of the listening proxy is runtime state, not configuration (`forwardProxy()` reports the endpoint, which stays readable when nothing listens) |
| `caTrust(caPath?, {force})` | `forward-proxy/ca-trust.ts` | the probe shells out to platform trust tools and is TTL-cached process-wide; `force` is what a post-setup advisory needs |
| `caCommonName()` | `forward-proxy/ca.ts` `CA_CN` | the truststore alias check must match the CA this install mints; a package constant would drift |
| `probeVersion(cmd)` | `base.ts` `probeClientVersion` | a 10-minute process-wide cache: spawning the CLI from every status poll is the bug this prevents |
| `gatewayBaseUrl(apiKey?)` | `base.ts` `resolveGatewayBaseUrl` | candidates are probed with an AUTHENTICATED `GET /v1/models`; a client written with a stale port 401s on every turn |

JetBrains additionally needs a key to write into Junie's model list, so the host exposes the key STORE (`apiKeys()`, `createApiKey()`) rather than letting the package re-implement where keys live. Minting POLICY stays in the hook ("prefer a key named `JetBrains`, else any usable, else mint one") — the host only owns the store.

Steady-state rule this preserves: **a hook's own knowledge (install locations, script text, IDE surgery, sidecar policy) lives in the package; anything describing the RUNNING install comes from the host.** No package imports a backend runtime module. (`plugins/jetbrains-gateway/exec.ts` is a local `runCommand` twin for exactly this reason — ADR-0017 §6: a packaged plugin is a single bundled file.)

### 3. The hook DECLARES its command surface; core renders it

`ClientAdapter` gained optional declarative members, and the registry stamps the derived fields into `ClientHookStatus`:

```ts
interface ClientAdapter {
  /** Passthrough verbs (`ocr cursor`, `ocr cursor-agent`). */
  launchVerbs?(): ClientLaunchVerb[];   // { verb, script, detached, summary?, missingHint? }
  /** Package id owning this client's MODEL SURFACE (a gateway catalog). */
  catalogPlugin?: string;
  /** Brand asset key (`assets/brands/<icon>.svg`); absent = the client id. */
  icon?: string;
  /** Bare product name where the surface implies the variant. */
  shortName?: string;
}

interface ClientHookStatus {
  pluginId?: string;        // which package provides this row (absent = built-in)
  catalogPlugin?: string;   // which package owns its model surface
  launch?: string[];        // verbs, in declaration order
  icon?: string;
  shortName?: string;
}
```

`ClientProductStatus` gained `icon?: string` for the same reason: a JetBrains product's id (`intellij-idea`) is not its mark's file name (`idea`), and that fact belongs to the package that defines the product, not to a console ternary.

Consequences, all of them deletions:

- `CliAction` lost its four launch verbs; `main()` resolves the first argv token through `findLaunchVerb()` (registry: core + every loaded package) before OCR's own flag parsing. A new package adds `ocr <verb>` with no core change.
- `printHelp()`'s client section is GENERATED (`ocr setup <id>` / `ocr teardown <id>` / `ocr <verb>` per adapter). The hand-maintained block is gone.
- `ClientsPage` lost `GATEWAY_PLUGIN_BY_CLIENT`, `CLIENT_BY_GATEWAY_PLUGIN` and `LAUNCH_COMMANDS`. The catalog editor reads `c.catalogPlugin`, the plugin gating reads `c.catalogPlugin`, the copyable start command reads `c.launch`.
- The console's last client→logo table went too: `BrandIcon` reads `c.icon ?? c.name` (product rows read `p.icon ?? p.id`), `c.shortName ?? c.displayName` replaced the two per-id ternaries, and the `clients.nameOpencode` / `clients.nameOpencodeProxy` i18n keys were deleted (all eight locales).
- `jetbrains-gateway` needs no "no catalog" exception any more: it simply declares no `catalogPlugin`.

### 4. Registration order keeps the "failed package cannot intercept" rule

Unchanged from ADR-0029 and now load-bearing for every forward-proxy package: the adapter half registers FIRST (it is the half that throws), the gateway is staged and only committed for ids with a loaded row (`retainStagedGateways`). A package whose adapter fails is a red console row — never a hook with no gateway behind it.

## Consequences

- **Uninstall means uninstall.** Removing `cursor-gateway` removes the launcher row with it; there is no orphan hook and no console table to enforce the pairing.
- **`ocr setup cursor-proxy` still works**, and the help text now says so because the package says so.
- **Build requirement:** the shipped `.plugin-dist` artifacts must be rebuilt (`bun run plugins:build`) — a stale zip seeds a package that declares only `client-gateway`, and the Client Hub row then simply does not exist for packaged installs (dev trees read `plugins/` directly via `OCR_PLUGIN_SRC_DIR`).
- **Config-writer hooks stay in core.** `opencode`, `claude`, `codex`, `pi`, `dsh`, `omp`, `grok`, `kimi`, `openclaw`, `workbuddy` rewrite a client's own config with model slots, key policy and profile links. Extracting them needs a config-mutation seam ADR-0027 deliberately withheld (`catalogPlugin`/`launchVerbs` do not cover it); they are the next family, not a leftover of this one.
- **i18n still keys a few strings by client id** (`clients.cursorHint`, `clients.*SetupOk`). Those are localized COPY, not the client roster: a package without a translated hint falls back to the shared proxy text. Moving them into the manifest would put UI copy in the protocol; that is a separate decision.
