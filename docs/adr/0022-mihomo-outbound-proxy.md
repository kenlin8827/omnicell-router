# ADR-0022: Outbound Proxy — Manual URL or a Managed Mihomo Core

Date: 2026-11-13
Status: Accepted
Governs: `backend/src/config/types.ts` (`ProxyConfig`), `backend/src/utils/proxy.ts`,
`backend/src/utils/proxy-node.ts`, `backend/src/proxy/mihomo-*.ts`,
`backend/src/routes/mihomo.ts`, `frontend/src/pages/ProxyPage.tsx`.

## Context

The outbound proxy was one URL (`proxy.url`) plus provider/model include and
exclude lists. Operators who already run a subscription client (Clash Meta /
mihomo) had to point `proxy.url` at that process by hand, and the console
could not switch nodes. Separately, `proxiedFetch` passed `{ proxy }` to
`fetch`. That option works on Bun and is ignored by Node's fetch, so a
gateway started with `node` silently went direct.

ADR-0018's forward-proxy egress still answers "through the outbound proxy or
not" and still refuses to consult `proxy.includes` / `proxy.excludes`. This
record only changes which endpoint "the outbound proxy" is.

## Decision

### 1. `proxy.mode` selects the endpoint; the default is `manual`

- `manual` (default, and the value used when `mode` is absent or unknown) —
  the endpoint is `proxy.url`, exactly as before.
- `mihomo` — the endpoint is `http://127.0.0.1:<proxy.mihomo.mixedPort>`
  (default mixed port 7890). `proxy.url` is ignored.

`includes`, `excludes`, and the loopback bypass apply in both modes, in the
same order. Loopback includes the external controller, so controller calls
are never sent back through the mixed port. `outboundProxyUrl()` (the
forward-proxy egress, ADR-0018) uses the same endpoint and still does not
consult the include/exclude lists.

`proxy.enabled` remains the master switch. The sidecar runs only when
`enabled` is true and `mode` is `mihomo`.

### 2. The sidecar is generated config plus a loopback controller

The gateway writes a mihomo config under `<env>/mihomo/` (`mixed-port`,
`external-controller: 127.0.0.1:<controllerPort>`, `secret`, one
`proxy-provider` per enabled subscription, one `select` group, `MATCH` to
that group). It adopts a controller that is already healthy, otherwise it
spawns `mihomo -d <dir> -f <config>`. A pid file and an `owner` marker
(`spawned` / `adopted`) record who started it. Explicit stop kills a local
listener. Leaving mihomo mode stops only a process this gateway spawned.

Binary lookup is `proxy.mihomo.binaryPath`, then `<ocrHome>/bin/mihomo`,
then `PATH`. Download from the MetaCubeX/mihomo GitHub releases is an
explicit admin action, never a boot side effect. `selectedNodes` is restored
through the controller after start.

### 3. Secrets stay out of logs and redacted archives

The controller secret is generated on first start when empty and written
back through `saveConfig`. Subscription URLs may embed tokens. Neither value
is written to a log line. Environment archives redact
`proxy.mihomo.controllerSecret` and every subscription `url` (both the flat
shape and `upstream.proxy.mihomo.*`). The authenticated console still
receives the URLs, because the operator edits them there. Status responses
report `secretConfigured`, not the secret.

### 4. Node fetch opens the proxy itself

On Bun, `proxiedFetch` keeps `fetch(url, { proxy })`. On Node it uses
absolute-form HTTP and, for HTTPS, `openViaProxy` (CONNECT) followed by
HTTP/1.1 on the tunneled TLS socket. The body is a web stream. Redirects
stay on the proxy unless the next hop is loopback.

### 5. No schemaVersion bump

The new keys live inside the existing `upstream.proxy` section. Missing
keys take defaults in `loadConfig`. That is value cleaning, not a disk-shape
migration (ADR-0016). `schemaVersion` stays 1. A file that does not mention
`mode` keeps `manual`.

## Consequences

- A pre-existing config proxies exactly as it did.
- Forward-proxy rows with `egress: proxy` follow the same endpoint, so a
  mihomo mode also covers transit traffic without a second URL.
- The admin surface is `/api/admin/proxy/mihomo/*` and the Proxy page's
  three tabs (general, subscriptions, nodes).
