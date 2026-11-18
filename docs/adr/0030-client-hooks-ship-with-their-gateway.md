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
4. **`SupportedClient` was a lie in both directions.** It claimed to be "the ids of the hooks present in this build" while listing ids whose gateways were packages.

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

### 5. Agent provisioning is the hook's job, transport included

A forward-proxy hook that leads to an agent the machine cannot install is a row that cannot work (§ADR-0027 §1 in spirit). `jetbrains-gateway` therefore provisions Junie itself: resolve the version from the IDE's own ACP registry, fetch, verify, extract into `acp-agents/<agent>/<version>/`, and seed `.downloads` so `AcpBinaryManager` promotes instead of re-fetching.

The transport is part of that decision, not an implementation detail underneath it. The artifact is 215 MB behind a GitHub release redirect, and the failure that motivated this section is measured, not hypothetical: one stream on a throttled link ran at 24 KB/s with no resume (2.5 hours, and the previous 30-minute cap made a first install impossible), while six ranges across mirrors reached ~860 KB/s — four minutes, byte-identical to the release API's `sha256` digest. So `downloadFile` probes with a ranged GET, cuts the archive into 4 MiB pieces, resumes from `<dest>.part` offsets recorded in a `<dest>.part.json` provenance sidecar (URL / mode / sha256, so a partial of ANOTHER asset is discarded rather than spliced in), rotates mirrors per attempt, and reports progress.

Three rules keep this from turning into host policy:

| rule | why |
| --- | --- |
| Mirrors and the local archive are OPERATOR config (`downloadMirrors`, `junieArchivePath`, `downloadConcurrency`), never package constants | a mirror is a regional workaround; a hardcoded one ships a third-party host to every operator |
| The download stays INSIDE `setup()` — no new console verb | the wire vocabulary is `setup`/`teardown` (a hook's two state transitions), and `ClientHookStatus` already reports the intermediate ("proxy hooked, agent missing") via `junieVersion`. A third button would invent a third lifecycle state whose teardown semantics nobody has defined |
| Verification is best-effort but never absent | the ACP registry publishes no hash for Junie, so the digest comes from the GitHub release API when reachable; otherwise declared size + zip structure. A mismatch deletes the archive, a truncation keeps it (that IS the resume state) |

Consequence for the console: setup can still take minutes on a bad link, so the adapter logs a progress line every 32 MB (`N/M MB (K KB/s via <endpoint>)`) through the host's logger — the operator can tell "downloading" from "hung" without a new action.

### 6. The takeover also owns the Air agent catalog; the IDE region is opt-in

Air in IDEs picks its Manage Agents catalog from a JetBrains-signed registry
bundle whose URL follows the IDE **Region**, and the bundles are NOT the same
set: the CN bundle ships 8 agents, the international one 45. A takeover that
leaves the region-selected bundle in place is a hook that hands out a proxy and
then silently hides most agents — so `setup` pins the international URL by
writing the Air plugin's own declared Registry key (`air.acp.registry.url`,
`resources.jetbrains.com/agentclientprotocol/registry.zip`) into each hooked
IDE's `<config>/options/ide.general.xml`, backed up once, reverted on teardown,
and never clobbering a value the operator set themselves.

The IDE **Region** itself (`Settings → Language and Region`) is a different
beast: machine-global (one JDK-Preferences value for every JetBrains IDE on the
box) and load-bearing for account, marketplace and AI endpoints — the gate that
answers "JetBrains AI is not available in your region" reads `Region.CHINA` and
nothing else. Flipping it is therefore OPT-IN (`airRegionUnrestrict`, default
off, target `airRegionTarget`), backed up on first use, and restored only once
NO product remains taken over — the same gating rule as the global Junie model
list. Same lifecycle rule as §5: both land inside `setup()`/`teardown()`, no
new console verb.

### 7. A detected running client is a CONSENT stop, not a silent write

An IDE holds its settings in memory and rewrites its own config files when it
exits, so a takeover performed under a live IDE can revert by itself — and a
teardown performed under one can come back, leaving the console saying "not
hooked" while the client still routes through the proxy. Neither is an error
the operator can see, which is why a POSITIVE detection stops the action:
`setup`/`teardown` return `success: false` with `reasonCode: 'ide_running'` and
the detected client names in `params.products`, and the operation only proceeds
when the caller resends it with `acknowledgeRunning: true` (console: a dialog
that explains the exit-time rewrite; CLI: `--force`). The probe FAILS OPEN —
`tasklist`/`pgrep` can wedge (one machine's `tasklist` never returned at all,
which is why `runCommand` now owns a hard deadline), and an unreliable probe
must never be able to lock the operator out of a hook that would otherwise
work. So the gate is consent, never a capability test.

## Consequences

- **Uninstall means uninstall.** Removing `cursor-gateway` removes the launcher row with it; there is no orphan hook and no console table to enforce the pairing.
- **`ocr setup cursor-proxy` still works**, and the help text now says so because the package says so.
- **Build/install requirement:** the packages are still built with `bun run plugins:build` into `<repo>/.plugin-dist/`, but no release distributes them (ADR-0032) — an operator installs a zip from there through the console. A stale zip installed by hand declares only `client-gateway`, and the Client Hub row then simply does not exist (dev trees read `plugins/` directly via `OCR_PLUGIN_SRC_DIR`).
- **Config-writer hooks stay in core.** `opencode`, `claude`, `codex`, `pi`, `dsh`, `omp`, `grok`, `kimi`, `openclaw`, `workbuddy` rewrite a client's own config with model slots, key policy and profile links. Extracting them needs a config-mutation seam ADR-0027 deliberately withheld (`catalogPlugin`/`launchVerbs` do not cover it); they are the next family, not a leftover of this one.
- **i18n still keys a few strings by client id** (`clients.cursorHint`, `clients.*SetupOk`). Those are localized COPY, not the client roster: a package without a translated hint falls back to the shared proxy text. Moving them into the manifest would put UI copy in the protocol; that is a separate decision.
