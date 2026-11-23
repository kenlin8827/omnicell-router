# ADR-0022: Outbound Proxy — Manual URL or a Managed Clash Core

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

`proxy.enabled` remains the master switch — for OUTBOUND traffic. Whether the
sidecar runs is a separate axis: `proxy.mihomo.autoStart` decides whether the
process should exist. The core can therefore keep running while outbound goes
direct (subscriptions refresh, nodes stay probed, its mixed port stays usable by
other clients), and it can be stopped while `mode: mihomo` stays configured.

> **Amendment — run policy split.** Earlier revisions ran the sidecar only when
> `enabled` was true and `mode` was `mihomo`. That conflated two questions —
> "where does outbound traffic go" and "should this process exist" — and left the
> core unusable as a standalone capability: a manual-URL setup could not keep it
> warm, and any config save killed a hand-started one. `autoStart` now carries the
> intent (`true` run, `false` stopped by hand, absent = follow `mode`), the
> console's Start/Stop buttons persist it, and an absent value reproduces the
> old rule exactly, so existing configs need no migration.

### 2. The sidecar is generated config plus a loopback controller

The gateway writes a mihomo config under `<env>/mihomo/` (`mixed-port`,
`external-controller: 127.0.0.1:<controllerPort>`, `secret`, one
`proxy-provider` per enabled subscription, one proxy group (`select` by
default — see `groupType`), `MATCH` to that group). Each provider may also
carry `proxy: <node|group>` (mihomo's provider-level `proxy`): the download is
an INNER connection matched against the rule set, so an empty value routes it
into the group — direct until a working node exists — while a subscription
host the local network blocks (TLS handshake timeout, SNI reset) needs a
reachable node or group named here. The value is stored as a free-form name and
never validated against the live proxy table, because existence is a runtime
fact; the console offers a picker, but a name whose provider is gone stays
stored and only that provider's fetch fails — it never fails the config. It adopts a controller
that is already healthy, otherwise it
spawns `mihomo -d <dir> -f <config>`. A pid file and an `owner` marker
(`spawned` / `adopted`) record who started it. Explicit stop kills a local
listener. Switching away from mihomo mode no longer stops anything — the run
policy (`autoStart`) owns that; when it does stop, it stops only a process this
gateway spawned. Boot reconciles once, unconditionally, against that same
policy — the process exists or it does not, independent of which mode is
configured.

> **Amendment — the spawned core is a CHILD of this gateway.** The core is
> infrastructure the gateway started, so it is bound to the gateway's lifetime,
> not the other way round:
>
> - A core this gateway spawned is killed when the gateway exits, including a
>   console restart (the restart supervisor is a surviving process; the child is
>   not). The teardown runs in the synchronous `process.on('exit')` hook through
>   `stopSpawnedMihomoSync`, which only ever knows a pid this process spawned or
>   took ownership of — an operator's own mihomo (`adopted`) has no entry and is
>   never touched. A kill that reports success also removes the markers naming
>   that pid, so the state directory never claims a core that no longer exists.
> - A start that fails at any stage (spawn error, immediate exit, not ready,
>   bind refusal) reaps the process it just spawned and clears the markers that
>   name it — a kill that failed keeps the markers, so the next start's self-heal
>   can still find the survivor. When the core's own output names the refusal
>   (`bind:` / `address already in use`), the failure is classified `port-in-use`
>   with the port, distinct from `port-collision` (the configured mixed and
>   controller ports being equal): one remedy is "close the other program", the
>   other is "change the numbers".
> - Adoption takes ownership deliberately: markers written by a previous
>   gateway (`spawned` + a live pid) are treated as an orphan of this gateway
>   shape and are killed on exit from then on. A core the operator started
>   (`adopted`, no markers) is left running across every gateway lifecycle; a
>   `spawned` marker whose pid is already dead is stale and is rewritten to
>   `adopted`, because the live core behind the controller is not the one it
>   recorded.
> - A recorded pid that is alive but holds neither the mixed nor the controller
>   port failed to bind; it answers nothing while making every later start
>   collide, so it is reaped before a replacement spawns.
> - A hard-killed gateway (taskkill, power loss) runs no handler; the survivor
>   is adopted on the next boot under the rules above — reaped if it is deaf,
>   owned and later killed if it is healthy.

Binary lookup is `proxy.mihomo.binaryPath`, then `<ocrHome>/bin/mihomo`,
then `PATH`. Download from the MetaCubeX/mihomo GitHub releases is an
explicit admin action, never a boot side effect. `selectedNodes` is restored
through the controller after start, so a restart routes through the node the
operator last picked instead of waiting for a manual selection: the first
attempt is synchronous (an already-loaded group switches immediately), and a
provider-backed node that mihomo has not downloaded yet is retried in the
background for 30 s — start never blocks on a slow subscription. The generated
`profile.store-selected` setting lets the core restore the same choice from its
own cache as well. This restore is manual-selector only: under `url-test` /
`fallback` the choice belongs to the core, and `PUT /proxies/{group}` is
mihomo's `Set` — a pin that outranks the group's own delay ordering for as long
as the node stays alive. An automatic group therefore skips the boot restore,
and its own `selectedNodes` entry is dropped on every save; other groups'
entries survive.
Deleting a manual node also prunes any `selectedNodes` entry that named it, in
the same write — a dangling name would otherwise be replayed on every boot.

The install endpoint (`POST /api/admin/proxy/mihomo/install`) answers NDJSON
rather than one JSON body: `progress` events carry `downloaded` / `total`
bytes while the release asset streams in (the console shows a percentage,
or an MB count when the host sends no `Content-Length`), then exactly one
`result` carries the plain install outcome. Release lookup prefers the
GitHub API with the shared `GITHUB_TOKEN` header and falls back to the
release-page redirect tag when the anonymous hourly cap answers 403/429,
so a binary download no longer depends on API quota.

The core's own output is not discarded. Its stdout/stderr are piped into a
bounded, memory-only ring (500 lines, oldest dropped first) that the console's
logs section polls through `GET` / `DELETE /api/admin/proxy/mihomo/logs`, and
the gateway appends its own `core process started` / `exited` / `spawn error`
markers to the same ring so a restart stays legible even while the pane still
holds the previous process's last words. The ring is process-lifecycle
evidence, not a metrics stream: an adopted core was not spawned here and
contributes nothing, and the ring survives a crashed core on purpose — the
lines right before an exit are the diagnosis the controller cannot give. The
core's `log-level` stays `warning`, and neither the controller secret nor a
subscription URL is among the lines it prints; the gateway strips ANSI colour
codes and joins partial lines before storing.

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
`mode` keeps `manual` unless the legacy `proxy.mihomo.enabled: true` flag is
set — that shape predates `mode` and still asks for the core.

## Consequences

- A pre-existing config proxies exactly as it did.
- Forward-proxy rows with `egress: proxy` follow the same endpoint, so a
  mihomo mode also covers transit traffic without a second URL.
- The page lands on the scope that matches the configured `proxy.mode`:
  `Proxy settings` for `manual`, `Clash core` for `mihomo`. A manual
  install therefore never opens on the core tab reporting a core it was never
  asked to run.
- The admin surface is `/api/admin/proxy/mihomo/*` and the Proxy page's
  six Mihomo sections (general, subscriptions, nodes, rules, connectivity, logs).
  Controller-backed actions (node select/test, subscription refresh) stay
  clickable; a down core
  answers 409 `not-running`, which the console renders as the localized
  "not running" notice and switches to the general tab's core card
  (install / start), never as the raw transport string. An unreachable
  controller is that same `not-running` case, not a separate transport error.
  The same rule covers every core/install failure code (`disabled`,
  `binary-missing`, `port-collision`, `port-in-use`, `spawn-failed`, `not-ready`,
  `spawn-exited`, `kill-failed`, `pid-unknown`, `unauthorized`,
  `reload-failed`, download codes): the
  backend message stays an English diagnostic for logs, the console renders
  the `code` through its i18n table in all eight languages. A down controller
  (transport-unreachable once the secret exists) is reported as that same
  `not-running` code, never as the transport string. The mixed and
  controller port inputs lock while the core runs (a port only takes effect at
  start, so editing it mid-run would silently desync the console from the
  process); the card says so and the operator stops the core to change them.
  The proxy page has TWO nav levels, never two tab strips in a row: the page's
  own tabs are `Proxy settings` (enable switch, manual URL, include/exclude lists)
  and `Clash core`, and the six Clash sections (general, subscriptions,
  nodes, rules, connectivity, logs) are a vertical menu on the left of that second
  scope — a section switch is navigation, so it reads as a menu, not as a
  second tab row stacked under the first. The rail hugs its six rows (it
  never stretches
  to the page bottom) and the section card fills the remaining page height and
  scrolls internally, so the document itself never scrolls. In the general
  section only the fields scroll: the save row is the pane's footer, pinned to
  its bottom edge so the action never leaves the screen (the right choice here
  because the fields are the tall part); every other section scrolls its whole
  card, action included.
  Core action buttons mirror the core's state: start is disabled while the core
  runs, stop/restart are disabled while it is stopped (each carries the localized
  reason as a tooltip), and the binary download is disabled while the core runs —
  a live process must not have its binary replaced — and relabels to
  "Re-download" once the binary already exists.
  Every label the operator can read says **Clash**, never "Mihomo": users know
  the product by the name Clash, while "mihomo" is only the kernel's release
  name. The kernel name survives in exactly three places — the config key
  `proxy.mihomo`, the `mode: mihomo` literal, and the binary / cache paths
  (`<ocrHome>/bin/mihomo`, `<env>/mihomo/`) — because those are facts an
  operator has to type or find on disk, not product copy. ADR prose keeps the
  architectural noun "mihomo core" wherever it means the kernel process itself.
  The nodes listing answers per group (`GET .../proxies?group=<name>`): every
  row's type and delay is resolved from the live controller snapshot, and the
  console re-fetches when the operator switches groups instead of remapping a
  group's members from another group's rows — that remap labelled every member
  of the newly picked group "Unknown" (the snapshot is the only truth for a
  node's type).
  The nodes table sorts by its delay column on demand (click the header to
  cycle ascending/descending; config order is the default). An unmeasured node
  is not a zero: `—` rows sort AFTER every measured one in both directions, so
  a descending sort never floats the untested tail to the top.
  Every subscription row states its auto-update cadence (mihomo's provider
  `interval`): the core re-fetches on that interval **only while it runs**, and
  saving a subscription while the core runs restarts it so the new interval
  applies.
  Each row also names the proxy its own download uses (`proxy`): follow the
  rules (into the `MATCH` group), this machine directly (`DIRECT` — the core's
  own dial, which does not read the OS proxy, unlike the Geo sync's machine
  leg), the group, or a node. The picker lists manual nodes from the config
  plus the live provider nodes, and keeps a stored name the live list cannot
  offer as an explicit row instead of rendering it as empty. A blocked
  subscription host is fixed by naming a reachable node.
  The subscriptions panel keeps the two verbs apart: the form above the list
  only ever creates — a half-filled add form can never be mistaken for a
  pending edit — editing a row opens a dialog, and each row carries its own
  enable switch. Enabling or disabling is therefore a one-click state flip on
  the row it governs, not a field buried in a form: a disabled subscription
  stays in the list but is left out of the generated `proxy-providers` and
  skipped by automatic updates, and the flip reconciles the sidecar on the spot.
  Nodes can also be authored by hand: `proxy.mihomo.manualNodes` is a
  whitelisted list (`{ id, name, type, server, port }` plus the fields the
  selected protocol owns) rendered into the generated `proxies:` block and
  added to the group's `proxies` list beside the provider-backed `use`
  entries — a manual node needs no subscription and no fetch. The protocol
  whitelist is `ss`, `vmess`, `vless`, `trojan`, `hysteria2`, `http`,
  `socks5`; a row missing its protocol credentials is dropped on load rather
  than handed to the core, because one malformed proxy fails the whole config.
  The console creates, edits and deletes them through
  `POST/PUT/DELETE /api/admin/proxy/mihomo/nodes`; each mutation saves and
  reconciles the sidecar like a subscription edit, and `GET .../proxies`
  carries `manualId` so the nodes table offers edit/delete only on rows it
  owns. Node names may not shadow a built-in (`DIRECT`/`REJECT`/`PASS`/
  `GLOBAL`) or the configured group, and are unique among manual nodes.
  Passwords and uuids are credentials: redacted in environment archives,
  never logged.
  A row may also carry a pasted Clash proxy mapping. The console parses it,
  stores the canonical mapping as `yaml`, and the renderer emits it verbatim,
  so a raw mapping is redacted whole in archives. A paste of several mappings
  (or a profile's `proxies:` block) adds the whole batch or nothing; identity
  fields are validated exactly as for a typed row. Editing is form-first, and
  ONE field table (`manual-node-spec`) owns all three directions: sanitizing a
  typed draft, rendering it into the mapping, and projecting a stored mapping
  back into the form. `GET /api/admin/proxy/mihomo/nodes` uses that projection
  (`reality-opts`, `ws-opts`, `grpc-opts`, `h2-opts`, `client-fingerprint`,
  `alpn`, `udp`, `tfo`, `ip-version`, ss plugin and hysteria2 obfs/ports
  settings included), so a pasted row opens on a populated form, and names the
  mapping keys the form does not model (`unmodeled`) so the console can say
  "these stay in YAML" instead of hiding them. A form save overlays exactly the
  form-owned keys onto the mapping — a field cleared in the form is removed,
  unmodeled keys survive — and a protocol outside the whitelist edits identity
  only. Invalid input answers `400 {code: 'invalid-node-field', field}` and the
  console puts the message on that control. `GET .../nodes/catalog` serves the
  protocol/field/enum tables so the console never mirrors a backend whitelist,
  and the YAML tab remains for keys the form does not model.
  Every node row also carries one `source` — `{ kind: 'subscription', id }`,
  `{ kind: 'manual', id }`, or `{ kind: 'builtin' }` when mihomo owns the
  entry (DIRECT/REJECT/PASS, and provider names that do not match a declared
  subscription). The console renders it as the nodes table's source column and
  builds its source filter from it, so the manual list is filterable exactly
  like an airport instead of disappearing behind a provider-only filter.
  The add-node dialog can probe an unsaved node before it is written: since the
  core has no route to a row that is not in the generated config yet, the probe
  opens a DIRECT TCP connection to the node's server:port (5 s budget; raw
  sockets never consult `HTTP_PROXY` / `HTTPS_PROXY` or this gateway's own
  forward proxy) and reports reachability only — it never claims the
  credentials or the tunnel work. A full delay test stays where it belongs, on
  saved rows in the nodes table; that one deliberately routes through the node.
  A failed delay test is not a measurement: mihomo reports it as `0` (history
  entry, single test, or group map), and the client layer maps `0` to "no
  measurement" so the console renders `—` rather than a misleading `0 ms`;
  batch tests also clear rows the response did not measure. A whole-group batch
  answers 504 (`get delay: all proxies timeout`) when no member succeeded, and
  older builds answer 408 for the same failure; the client normalizes both to
  one stable `timeout` code, so the console shows its localized timeout message
  and settles those rows as timed out instead of surfacing a raw controller
  status as an operation failure.
  A delay test is scoped by where the name lives. mihomo resolves
  `/proxies/{name}/delay` only through its own proxy map — the generated
  `proxies:` block, the groups, the built-ins — so a proxy-provider
  (subscription) member, which exists only inside its provider, answers that
  route with 404 `Resource not found` even when the node is healthy. The
  client therefore resolves membership first: a config proxy keeps the
  config-scoped route, a provider member goes to
  `/providers/proxies/{provider}/{name}/healthcheck` (the same URL test under
  the provider scope), and a name neither side knows fails as
  `node-not-found` instead of being reported as an unreachable node.
  Two different checks, never conflated: **connectivity** fetches the
  configured URL THROUGH the currently selected node, via the core's delay
  endpoint — it proves the tunnel and the URL together. **Latency** measures
  the node itself; an unsaved node is only probed with a DIRECT TCP connect to
  its server:port (no proxy), because the core has no route to it yet. The
  console labels them accordingly, and the URL check reports the node it went
  through together with the endpoint the core actually fetched — the default
  when the field is still empty — so a result never describes an address the
  operator cannot see. A failed URL check opens no second, per-URL test
  surface: it points at the nodes tab's batch test, the existing answer to
  "is the endpoint dead for every exit or only for the node in use".
  A row in the console's node table is never a bare number. It is untested,
  in flight, timed out, errored or measured: mihomo answers a dead node with
  delay 0, so a sentinel that reached a cell as "0 ms" would be a lie, and a
  row must not keep showing an older number while its own test is pending. A
  batch marks every member in flight up front and settles them together, so
  the sort order cannot churn while results arrive. Measurements are graded
  (< 250 ms / < 400 ms / slower) and every non-measurement state sorts below
  every measurement in BOTH directions — descending never floats empty rows to
  the top. Console readings are cached per node for 30 minutes, then dropped:
  past that they no longer describe the node. The delay budget is one constant
  (`MIHOMO_DELAY_TIMEOUT_MS`, 5 s) shared by the controller client's defaults
  and both console routes, each of which accepts a per-request override
  clamped to 20 s.
  The test URL is ONE config key, `proxy.mihomo.testUrl` (http/https, no
  embedded credentials, default the gstatic 204 endpoint mihomo itself uses),
  not a list: the generated group has exactly one `url`, so "which endpoint is
  this delay measured against" must stay unambiguous. The console offers
  Google/Cloudflare/OpenAI/Anthropic presets as shortcuts but the field is free
  text, and a test request may carry the field's current value so an unsaved
  edit is exercised immediately (mihomo's delay test accepts any HTTP status,
  so an auth-protected endpoint still proves connectivity).
  Probing several candidate endpoints is still one field: one action runs the
  presets plus the field's current value through the CURRENT node and grades
  each row, the results live only in the page, and choosing a winner remains an
  ordinary field edit — a probe never rewrites what the core health-checks.
  The opposite question ("is this URL dead for every exit?") still belongs to
  the nodes tab's batch test, not to a second testing surface.
  Subscription timestamps are locale-formatted for display, and a provider that
  never fetched loses its timestamp at the client boundary — Go marshals
  `time.Time{}` as `0001-01-01T00:00:00Z`, which is a protocol zero value, not
  an ancient date, so it must never reach a rendered label.
  The gateway serves a PAC document itself (`GET /proxy.pac`, outside `/api`,
  whitelisted in the auth preHandler — it is one generated script with no
  secret in it). It is built from the LIVE config on every fetch, so the mixed
  port in the console is the single source of truth, and it carries the
  direct-bypass list a bare host:port cannot: loopback, link-local, private
  (RFC1918, CGNAT 100.64/10) and mDNS names answer `DIRECT`, everything else
  answers `PROXY 127.0.0.1:<mixedPort>` — with no `DIRECT` fallback for proxied
  hosts, because a dead core must fail loudly instead of silently leaking
  traffic around the tunnel. `proxy.includes` / `proxy.excludes` are NOT
  mirrored into it: they match provider/model names, not hosts. The console's
  proxy-patterns page offers a multi-select quick-add dialog of provider-level
  patterns derived from the LIVE connected provider ids (`<provider>/*`). The
  dialog only APPENDS the ticked rows — it never rewrites rules the operator
  typed. Nothing is seeded: an empty includes list keeps the proxy-all
  default, and the console never invents vendor names no configured provider
  carries. The console
  (Mihomo → basic settings) puts the URL behind a button that opens a dialog
  with the address and a copy action. The address is composed by the gateway
  from the request's own Host header plus the gateway port (`pacUrlFor`), never
  from the console document's origin: under the Vite dev server
  `window.location.origin` is the 5174 dev origin, which dies with the terminal
  and is never what the OS or a browser should be pointed at. The status
  payload therefore carries `pacUrl` (older gateways omit it and the button
  stays disabled), and a remote-opened console still hands out the address it
  was reached on. The URL is reference copy, not a setting, so it must not
  occupy a permanently read-only input in the middle of the form.
  Outbound mode is mihomo's own switch and is kept separate from `proxy.mode`
  (manual vs. core): `proxy.mihomo.routingMode` is `rule` (default), `global` or
  `direct`. The generated config injects exactly one `MATCH,<group>` rule, so
  `rule` and `global` route identically today — the selector is exposed anyway
  because `direct` is a cheaper kill switch than stopping the core (the
  controller and provider auto-updates keep running) and because the value is
  mihomo-native. Changing it in the console persists the config field AND
  PATCHes the live controller (`PATCH /configs {mode}`), so it takes effect
  without a restart; when the core is not answering the value is saved for the
  next start and the response says `live: false` with a warning instead of
  pretending it applied. Reads compare the saved value with the mode the core
  reports (`liveRoutingMode`) and surface a mismatch rather than letting the
  selector lie about the running process — except while the operator's own
  write is in flight: the selector flips optimistically, so the pre-write
  snapshot would read as a spurious deviation and flash a banner on every
  switch. The comparison resumes once the follow-up status read lands, so a
  real mismatch (core refused, another client won) still shows.
  Sanitization whitelists the field like
  every other one — an unknown string becomes `rule` instead of reaching the
  generated config. A PAC only decides direct-vs-proxy at the client; the
  outbound mode decides what happens to the traffic that reaches the core, which
  is why both exist and why the PAC hint never claims to carry rules.
  Who picks the node is a separate axis: `proxy.mihomo.groupType` is `select`
  (default — the console's node picker), `url-test` (the lowest measured delay
  wins) or `fallback` (the first member that answers), with `groupInterval`
  (seconds, 30..86400, default 60) and, for `url-test`, `groupTolerance` (ms,
  0..5000, default 50). The interval is the failure-DETECTION window, not a
  display refresh: a dead node keeps taking traffic (and its latency reading
  stays stale) until the next cycle, so the gateway ships 60 s rather than
  mihomo's 300 s default — a full five-minute outage window for a node that
  died right after a test. The 30 s floor keeps one real request per member per
  cycle from turning into a self-inflicted test flood on large subscriptions.
  The generated group takes the same type, points at the
  shared delay-test URL and carries the provider list. An automatic group
  deliberately has NO `DIRECT` member: a direct route measures ~0 ms, so
  `url-test` would select it on every cycle and silently bypass the tunnel, and
  `fallback` would hand all traffic to it the moment one node failed. The
  manual selector keeps `DIRECT` because there a human chooses it on purpose.
  Applying a change goes through the config save (the group lives in the
  generated file, so it needs a core restart — unlike the outbound mode, which
  the controller can PATCH live). The nodes tab reads the LIVE group's kind from
  the proxies response (`groupType`) and disables the picker under an automatic
  group with an explanatory note, so the console never offers a click the core
  would ignore. A batch delay test is not a second selection path: it records
  each member's last delay for the shared test URL, and the core's next
  ordering pass (bounded by its own short result cache, seconds not the
  interval) re-ranks with those numbers under the same tolerance. Running it
  after a failure is therefore the operator's way to shorten the detection
  window without changing who owns the choice. Sanitization whitelists and
  clamps all three fields; unknown values fall back to `select` / the shipped
  defaults, and an automatic group keeps no remembered pick (see §2).
  Saving is a card footer, never a page-header action: the button lives inside
  the card it writes, on the leading edge next to the fields it affects, followed
  by an unsaved-changes badge and an InfoTip that names the scope (a footer
  paragraph is documentation nobody reads, and it competes with the action) — a save rewrites
  the whole `proxy` section (this card plus the other settings scope), so it must
  not read as "save this field", and the action must not sit in a corner shared
  by scopes that do not write it.
  The node actually in use is a header micro-label pill on EVERY console scope
  (the running group's `now`, plus type and last delay), not a settings row:
  clicking it mirrors state into Mihomo → nodes and anchors to that row, which
  carries the accent rail and an "active" badge in the table. The answer to
  "which node am I on" therefore needs neither a tab switch nor a scroll through
  a hundred-row list, and a filter that hides the row cannot hide the answer.
  The nodes tab filters by the subscription that contributed a node and by the
  protocol type, both keyed by the real value (provider id, protocol name) and
  both narrowing each other: picking one airport must not keep offering a
  protocol only another airport provides. Protocol names are NOT translated —
  `Vless` / `Hysteria2` are wire names an operator matches against their
  subscription, not UI copy. A filter whose last member disappeared stops
  filtering instead of leaving an empty-looking group.
  The console also shows the RUNNING core's rule table (Mihomo → rules via
  `GET /api/admin/proxy/mihomo/rules`, backed by the controller's `GET /rules`):
  type, match payload and outbound target, read from the core rather than from
  the config the gateway wrote, so a rule that was rejected or dropped is
  visible instead of assumed. This is also what makes the provider boundary
  auditable: `proxy-providers` contribute PROXIES only, and a subscription's
  own `rules:` / `proxy-groups:` are never imported — the table on screen is the
  generated one. A dead core answers 409 `not-running`; the console renders that
  as an empty table plus a localized "not running" note, never as an error
  dialog.
  Operators who need their own routing write it themselves: `proxy.mihomo.rules`
  is an ORDERED list (`{ type, payload, target }`) rendered ahead of the final
  `MATCH,<group>`, first match winning. Targets stay symbolic — `PROXY` resolves
  to the configured group name at render time, so renaming the group cannot
  silently point a rule at a dead name. The type whitelist is narrow on
  purpose: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `IP-CIDR`, `IP-CIDR6`,
  `GEOIP`, `GEOSITE`, `DST-PORT`, `SRC-PORT`, `PROCESS-NAME`, `PROCESS-PATH`.
  `GEOIP` / `GEOSITE` require the explicitly downloaded geo databases (see the
  amendment below) and are refused at save and at start without them;
  `RULE-SET` (a remote fetch at load) and logical rules are rejected, because a
  rule that cannot be evaluated either fails the config or falls through
  silently, and a silent fall-through changes egress. Payloads carrying a list
  separator are dropped for the same reason. The editor (`PUT
  /api/admin/proxy/mihomo/rules`) writes the whole list and reconciles the core,
  and it lives beside — not instead of — the read-only table: the editable draft
  and what the core actually loaded stay separate facts.
  A subscription's rules can be pulled in ONCE, through `POST
  /api/admin/proxy/mihomo/rules/import` (`source: 'subscription' | 'text'`).
  The import is a DRAFT operation: it parses the profile, flattens every target
  that names one of the subscription's own `proxy-groups` to `PROXY`, skips what
  the core cannot evaluate (`RULE-SET`, logical rules) with a count, dedupes,
  and returns rows the console merges into the
  editable list — nothing is written and nothing reaches the core until the
  operator saves. A live binding was rejected: an airport that edits its profile
  would silently change egress while the console screen showed an unrelated
  state, and rule targets are exactly the place where that surprise is worst.
  A target the gateway does not recognize is mapped to `PROXY` by default
  (the console offers a tick to drop them instead), so an airport's own group
  name does not become a dead target.
  The document itself comes from the core's own provider cache
  (`<workDir>/providers/<id>.yaml`) whenever that file exists: it is the copy the
  running config actually uses, it works offline, and it survives a subscription
  host whose TLS chain this runtime rejects — the exact failure that made the
  network path unusable ("unknown certificate verification error" from `fetch`
  while the core had already accepted the same URL). The network is only a
  fallback, and the console names the source it used instead of implying one.
  Every row carries a `source` provenance label (`manual`, a subscription name,
  `paste`, and the built-in labels `default` / `preset`). It is metadata only — never rendered into the YAML, never evaluated —
  and it exists for one operational job: grouping rules that arrived from the same
  place so they can be filtered and removed together when a subscription is
  dropped. Import is two-phase: the parsed list appears as a tickable, filterable
  preview and only the ticked rows move into the draft, because parsing is cheap
  and changing egress is not. The section then shows ONE of two views — the live
  rules (what the core loaded) or the rule editor (the draft) — never both at once:
  on a stacked layout the operator cannot tell which rows are in force. Long lists scroll
  inside their own bounded box while the save bar stays pinned to the card bottom,
  and the dialog body is never itself scrollable, because nested scroll areas hide
  rows and hand the wheel to the wrong container.

> **Amendment — the LAN baseline is seeded, the CN bypass is an opt-in preset,
> and geo data is an explicit install.** The rule table does something useful
> without the operator writing it, and no rule ever depends on a file that is
> not on disk:
>
> - `proxy.mihomo.rules` absent ⇒ the generated config carries the LAN
>   baseline (`MIHOMO_LAN_DIRECT_RULES`, `source: 'default'`): loopback,
>   RFC1918, CGNAT, link-local and the IPv6 ULA / link-local ranges → `DIRECT`.
>   Once the key exists — including an explicitly empty list — the saved list is
>   authoritative and the baseline never reseeds, so a default row the operator
>   deleted stays deleted. The console's "Default rules" dialog re-adds the rows
>   the operator ticks (deduped, draft-only); that explicit action is the only
>   way they come back.
> - The CN bypass (`GEOIP,CN` + `GEOSITE,cn` → `DIRECT`,
>   `MIHOMO_CN_DIRECT_RULES`, `source: 'preset'`) is a ONE-CLICK PRESET, never a
>   default. Core rules apply to every client of the mixed port — including
>   ADR-0018 forward-proxy rows whose `egress` is `proxy` — so a blanket
>   domestic-bypass default would silently send a CN vendor host the operator
>   deliberately routed through the exit out direct. The preset dialog states
>   that consequence instead of hiding it.
> - `GEOIP` / `GEOSITE` are in the type whitelist, but the geo databases
>   (`geoip.metadb`, `GeoSite.dat`, tens of MB) are an EXPLICIT download into
>   the core's work directory (`POST /api/admin/proxy/mihomo/geo`, NDJSON
>   progress, same MetaCubeX release host as the binary, 64 MB cap; existing
>   non-empty files are kept, so a retry after a partial failure fetches only
>   the missing one). mihomo downloads the files itself while parsing a config
>   that needs them — and a failed download (offline machine, blocked GitHub
>   host) makes the core exit fatally, taking the gateway's own outbound path
>   with it. Both boundaries therefore refuse a geo-rule list while the files
>   are missing: the rules save answers 400 `geo-missing` BEFORE persisting
>   (persist-then-fail would leave config and process disagreeing at every
>   later boot), and the sidecar start returns the `geo-missing` code before
>   spawning. The generated config leaves `geo-auto-update` off; installed
>   files are used offline and never re-fetched. The preset dialog checks
>   `GET /api/admin/proxy/mihomo/geo` and downloads before the rows land in the
>   draft, so the operator sees the cost as a progress bar, not a failed save.
> - The importer treats `GEOIP` / `GEOSITE` like any whitelisted type (payload
>   casing is normalized at render: uppercase for GEOIP, lowercase for
>   GEOSITE); `RULE-SET` (remote fetch at load) and logical rules stay out of
>   both the whitelist and the importer, counted as skipped.
> - The two presets are SERVED by the backend
>   (`GET /api/admin/proxy/mihomo/rules/presets`) from the same declaration the
>   fresh-config seed reads. A console-side copy would be a drift twin of the
>   seeded rows.

> **Amendment — the connectivity check runs on TWO legs, not one.** The delay
> endpoint answers "can the current node carry this URL"; it cannot answer "is
> this URL reachable from this machine at all", so a failure leaves the
> operator unable to tell a node/subscription fault from a local-network one.
> `POST /api/admin/proxy/mihomo/test-url` therefore takes `mode: 'tunnel' |
> 'machine'` (default `tunnel`, the historical behavior; any other value is a
> 400, never a silent fallback). The machine leg answers "what would this
> machine's own egress do with this URL": it follows the OS system proxy when
> one is enabled (`readOsProxyEndpoint` — WinINET `ProxyEnable`+`ProxyServer`,
> the active macOS service, or GNOME manual mode), honouring that proxy's
> bypass list (`osProxyBypasses`: loopback always direct, `<local>`, WinINET
> wildcards, CIDR, suffix domains, exact hosts), and goes raw direct when no
> system proxy is set. It needs no running core. The transport is a raw
> `net`/`tls` HTTP/1.1 client (origin-form direct; absolute-form or CONNECT +
> TLS through the proxy, `Proxy-Authorization` from userinfo), chosen because
> on this runtime BOTH `fetch` and `node:http`/`node:https` consult
> `HTTP_PROXY` / `HTTPS_PROXY` from the environment while raw sockets consult
> nothing (verified: a dead env proxy fails `fetch`, `fetch(url, { proxy: '' })`
> and the node HTTP clients alike), so an HTTP client stack would answer
> "whatever the shell env says" instead of "what the OS is configured to do".
> Env proxies are deliberately ignored — they are a launch artefact. A PAC
> (`AutoConfigURL`) is not followable from here and falls back to direct. The
> response carries `via: 'direct' | 'system-proxy'` and, when proxied, the
> `host:port` used. The console puts a two-state switch (via Clash node /
> machine network) at the top of the connectivity tab, keys answers by (URL,
> leg), and so switching never erases the other leg's result. There is
> deliberately no third "through Clash's DIRECT" mode, and no operator gate:
> the machine leg answers a question that is meaningful in every state. When
> Clash itself holds the OS system proxy, the machine leg necessarily shares
> the node path — the tab says so in an amber note, so the pair reads as a
> full-machine-path cross-check rather than a node-independent baseline.

> **Amendment — the UI calls it Clash, everywhere.** An earlier revision
> labelled the surface "Mihomo (Clash)" so both names were visible. That was
> wrong: "mihomo" is a release artefact of the kernel, not a word an operator
> recognises, and a two-name label made the console look like it had two
> products. All operator-facing copy — the nav item, page headings, mode
> option, status card, every error toast and the generated `config.json`
> comments — now says Clash. Nothing else moved: the config key stays
> `proxy.mihomo`, the `mode: mihomo` literal stays, the admin routes stay
> `/api/admin/proxy/mihomo/*`, and the binary keeps its upstream name so
> download, lookup and PATH resolution are unchanged.

> **Amendment — the page is the "Clash Panel", the core is still "Clash Core".**
> The nav item, breadcrumb and page subnav label moved from "Clash Core" to the
> "Clash Panel" (zh-CN 「Clash面板」). "Core" named one component, but the page
> owns five sections — core lifecycle, subscriptions, nodes, rules and
> connectivity — and in a code context it read as the gateway's own kernel.
> "Console" was rejected because it is already this product's word for the whole
> admin UI (and Clash's own dashboards use it for live traffic views, not
> forms); "Management" duplicated the "Proxy Management" group above it. The
> split stays deliberate: the status card, every error toast and the generated
> `config.json` comments still call the running process the Clash core. The
> i18n keys, the `/proxy-clash` route, the `proxy.mihomo` config key and the
> binary name did not move.

> **Amendment — the OS proxy target lives on ONE System Proxy page.** The Clash
> panel no longer hosts "Use as the system proxy": assigning the OS pointer
> (enabling or switching between the inbound forward proxy and the mixed port)
> belongs to a dedicated System Proxy page in the Proxy group, which renders
> both targets side by side through the SAME ownership module the inbound card
> uses (ADR-0018 amendment — one snapshot slot, target switch that keeps the
> pre-OCR payload, restore returns the pre-OCR settings). The action is
> immediate and deliberately outside any tab's config save; enabling the Clash
> target is gated on a running core, and the page warns when the core is
> stopped while it owns the OS proxy. Every other surface keeps only status:
> the inbound card (and its setup wizard), the Clash panel and
> the outbound page show the owner, the bypass / env copy and a restore action,
> each linking to the System Proxy page
> (`/proxy-system?target=forward|clash`) for enable and switch.

> **Amendment — geo data syncs on the operator's word, over a leg the operator
> chooses.** The install is explicit, so updates are too: nothing refetches the
> databases on its own (`geo-auto-update` stays off), and an installed pair older
> than `MIHOMO_GEO_STALE_DAYS` (30 days) reports `stale` from
> `GET /api/admin/proxy/mihomo/geo` and carries a "sync suggested" badge in the
> console — an advisory only, never a start-block; a core with old data still
> starts. Basic settings now carries a Geo card (file, size, updated time, stale
> badge, one sync button, a machine/node leg switch), so the download is no longer
> reachable only as a side effect of the CN preset.
>
> `POST /api/admin/proxy/mihomo/geo` takes `leg: 'machine' | 'node'` (default
> `machine`; any other value is a 400, never a silent fallback) and
> `refresh: boolean`. The machine leg is the default because it is the leg that
> can always answer: it dials the OS system proxy when one is enabled (the same
> `readOsProxyEndpoint` + `osProxyBypasses` pair as the connectivity machine leg,
> judged per URL so a redirect to `objects.githubusercontent.com` is decided on
> its own host) and goes direct otherwise — it works with the core stopped. The
> node leg dials the mixed port and therefore requires a LIVE core
> (`getMihomoStatus`, not merely a configured controller) whenever a fetch will
> actually happen; with it down the route answers `not-running` before any
> download request is attempted.
> One tradeoff is stated rather than hidden: a direct machine fetch on this
> runtime still honours `HTTP_PROXY` / `HTTPS_PROXY` from the environment, exactly
> like every other `fetch` in the process. The OS proxy is the definition of the
> leg; the env is launch residue.
>
> Sync means REPLACE: `refresh: true` re-downloads both files even when copies
> exist, each written to a temporary file and renamed over the old one, and a
> failed refresh keeps the working copies — the operator's sync never trades a
> working database for a broken one. Without `refresh`, existing non-empty files
> are skipped; that is the mode the CN preset uses (install what is missing, never
> re-fetch what is already there).
