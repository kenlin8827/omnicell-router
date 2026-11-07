# ADR-0017: Client-Gateway Plugins — Inbound Native-Protocol Wire Ownership Behind the MITM Leg

## Status

Implemented — 2026-11-05.

## Context

Two extension axes were already named but only one existed:

- The plugin manifest's `type` field is the declared extension axis (`plugins/types.ts`), with exactly one type, `'model-service'` — outbound vendor-protocol knowledge (native transports, credential chains, vendored vendor binaries) shipped as user-installed packages.
- ADR-0008's inbound surface table is CLOSED: four wire aliases, everything else 404s. Vendor clients whose protocol is neither OpenAI nor Anthropic shaped (Cursor: ConnectRPC + protobuf over HTTP/2 to `api2.cursor.sh`, no configurable endpoint) had no lawful inbound path.

Cursor cannot be pointed at a custom endpoint by config — its AI traffic is hardcoded to its own API hosts. The only integration topology is TLS interception: point the client at the inbound forward proxy (ADR-0008 §3) and answer/relay the decrypted traffic. That is vendor-protocol knowledge in exactly the sense `plugins/types.ts` already reserves for plugins: multi-MB vendored .proto sets (7 files, ~70k lines, pinned to Cursor 3.28.7), a frame codec, version-drift extraction tooling. It must not live in core.

## Decision

### 1. Second plugin type: `'client-gateway'`

A client-gateway plugin CLAIMS whole SNI hosts on the inbound forward proxy and owns the decrypted traffic of those hosts. The module exports `createPlugin(host: ClientGatewayHost): ClientGatewayPlugin`:

- `hosts: readonly string[]` — the claimed SNI hosts (e.g. `api2.cursor.sh`).
- `match(info)` / `handle(req, res)` — per-request admission and full lifecycle. The gateway sees node-http req/res on the h1 leg and the http2 compatibility API (same shape) on the h2 leg.
- `ClientGatewayHost` SDK (self-contained, same rule as the model-service host SDK — packaged plugins never import backend paths): `chat(body, sink, signal)` runs ONE canonical OpenAI-shaped completion through the SAME `dispatchSurface` pipeline as `/v1/chat/completions` (model resolution, tiers, breakers, captures all apply), `catalog()` exposes the routing surface for AvailableModels-style fabrication, `ocrHome()` for artifact state.

The plugin registry (`plugins/gateways.ts`) is module-level, rebuilt atomically on every plugin-host load cycle (stage → commit mirrors the model-service registry swap), and disable/uninstall hot-unplug immediately. **Host scoping is enforced by the registry, never trusted to the plugin**: `findGateway` gates on `:authority` (h2 compat) / `host` (h1), port stripped, case-insensitive, before the plugin's `match()` is consulted.

### 2. Gateway routes never join the ADR-0008 surface table

The SURFACES table stays closed for DIRECT `/v1` faces. Gateway routes are HOST-SCOPED and exist only behind the MITM leg — a host claim is opt-in by plugin installation (install IS the authorization, unchanged trust model), and an unrecognized path on a claimed host either is relayed by the gateway itself or falls through to transparent forward. This is the lawful home for the fourth Cursor wire: not a fifth table row.

### 3. Forward-proxy h2 leg — transport-complete, not plugin-gated

Cursor's streaming endpoints force HTTP/2 (an h1 client is rejected with 464); the forward proxy's per-host TLS terminators were h1-only (Bun has no server-side SNICallback, hence the existing per-host terminator pattern). h2 is also the base transport of gRPC/Connect traffic generally, so the leg is NOT a vendor feature: it belongs to the proxy, and the plugin only owns vendor SEMANTICS on the hosts it claims.

- EVERY host advertises both protocols; the ORDER differs. Bun honours the SERVER's preference (verified: server `['http/1.1','h2']` + client `['h2','http/1.1']` negotiates `http/1.1`), so an unclaimed host offers `['http/1.1','h2']` — dual-offer clients (curl, browsers, most SDKs) keep the h1 path the surfaces pipeline knows, ZERO regression, while h2-only clients get h2 instead of a broken downgrade — and a gateway-claimed host offers `['h2','http/1.1']` because the plugin speaks the vendor's h2 wire even to dual-offer clients. The terminator cache is keyed by host+mode so a runtime plugin install flips the offer on the next CONNECT.
- Routing to the inner leg is decided on the FIRST DECRYPTED CHUNK: negotiated ALPN is only a hint (Bun does not reliably surface `alpnProtocol` server-side at callback time); the h2 connection preface (`PRI * HTTP/2.0`) is the authority. h2 bytes splice to a prior-knowledge h2c inner loopback (`http2.createServer`, compat `request` API), h1 bytes keep the existing inner. Both inners run the SAME intercept chain, and the h2 fall-through accepts `:authority` where h1 uses `host`.
- The transparent forward RE-ORIGINATES the protocol it accepted: the h2 leg relays upstream over h2 (`forward-proxy/h2-forward.ts` — pooled sessions, `:authority` rebuilt from the dial target, hop-by-hop stripped but `te: trailers` KEPT because gRPC requires it end-to-end, response trailers forwarded via `addTrailers`, bidi bodies with backpressure, cancel on client disconnect). An upstream that will not speak h2 hands the exchange back to the h1 forwarder BEFORE anything reaches the client — including the body bytes already captured, which the h1 leg writes first (Bun's h2 compat IncomingMessage drops chunks emitted while nobody listens, so the head of the body must be captured synchronously).
- Consequence: with NO plugin installed, a gRPC/Connect client is transparently proxied — full HTTP/2 semantics, full access-log capture — instead of being downgraded into a 464. Vendor semantics (Cursor's Connect routes, model catalog) still require the plugin; only the transport is core.

### 4. Reference plugin: `cursor-gateway`

The repo's dev plugin tree carries the reference implementation (`plugins/cursor-gateway/`, vendored protos + `protobufjs`, keepCase loading — extracted protos are snake_case):

- `AvailableModels` (unary) answers from the advertisement artifact `<ocrHome>/gateways/cursor/models.json` (`{models: string[]}`, written by the console's Cursor client adapter), falling back to the live `catalog()` — Cursor's model picker then shows OCR tiers/models verbatim.
- `StreamUnifiedChatWithTools` (bidirectional) implements the AGENT LOOP: conversation history → canonical messages; OpenAI `tool_calls` → `ClientSideToolV2Call` frames (enum `ClientSideToolV2`, `tool_call_id`, `name`, `raw_args` JSON); the client's follow-up `ClientSideToolV2Result` frames (field 2 of the same request envelope) → `role:'tool'` messages and the next turn; a turn with no tool calls closes the stream (Connect 0x80 end-stream JSON trailer).
- `StreamUnifiedChat` (server-stream, bare top-level text) and honest `unimplemented` Connect trailers for the SSE/Poll variants; unknown paths on claimed hosts relay upstream over real TLS via an h2 client (`agent.api5.cursor.sh` is h2-only).
- Wire codec: Connect frame `[1B flags][4B BE length][payload]`, 0x01 gzip, 0x80 end-stream-JSON — ported from the protocol lab the integration was validated against (Cursor 3.28.7). Protos are pinned; a client upgrade re-runs the extractor and re-vendors.

### 5. Traffic observation — capture is full-fidelity, display is windowed

A gateway that wants its traffic visible registers a **dissector**, never a view. The Wireshark model, split by phase:

- **Capture (plugin, write path)** — the plugin streams every decrypted chunk straight to a sidecar file `<ocrHome>/plugins/traffic/<id>/bodies/<YYYYMMDD>/<exchangeId>-<side>.bin` and appends ONE metadata line to the day JSONL (headers, byte counts, status, leg, file refs). Nothing is buffered in memory: a long `StreamChat` costs O(chunk), not O(body). Bodies are **never truncated for storage** — the sole ceiling is a runaway guard (64 MiB per side) that stops the write and sets an honest `truncated` flag. Bodies older than 7 day-directories are pruned on the plugin's own write path.
- **Decode (plugin, read path)** — the plugin's `dissect(exchange)` is called by the backend at READ time with the captured bytes, and returns named protocol layers. Protocol knowledge therefore stays with the plugin that owns the wire; the console renders layers it has never heard of.
- **Display (core route, read path)** — the route reads a fixed WINDOW per side (32 KiB for the dissector, 1 KiB for the inline hex preview) and ships byte counts + file refs, never payloads. `/api/admin/traffic-body/:token` streams the whole capture for download — the SAME neutral endpoint the proxy log uses, so the console never learns which subsystem stored the bytes; full fidelity is one click away and the browser's DOM never receives a multi-megabyte body.
- **One timeline, one filter set** — dissected rows join the existing proxy access-log table (no separate tab, no separate view). Columns classify transport, not vendor: 类型 (`http` / `connect`), 协议 (`h1` / `h2` / `ws` / connect-rpc), 主机, 方法, 路径, 状态, 耗时, ↑/↓ body bytes.
- **One drawer, one decoder registry** — every row (proxy or gateway) is rendered by the SAME detail component from a normalized side model (headers, bytes, layers, download ref); the row kind only builds the model. A body is bytes plus a list of decoders that claim them: `hex` is the FLOOR decoder (Wireshark's `data` — always applicable, the fallback), with `text` / `json` / `image` / `pdf` built in and each plugin dissector layer ranked above them. The default view is the highest-ranked applicable decoder, so protocol knowledge wins over hex with no ordering logic in the UI, and a new format is one registry entry — never a new branch. Layer output is SIDE-TAGGED (`req` / `res`) by the dissector: an empty response body must never appear decoded.

Consequence: the console never learns a vendor protocol, and a plugin that declares no dissector simply does not appear. Retention, feed layout and the tail cap belong to the core route; byte ownership belongs to the plugin.

### 6. Console ownership

`/admin/clients` gains `cursor` as a proxy-access client (`SupportedClient`, `CursorClientAdapter`). Setup cannot write a vendor config file — it (a) requires `forwardProxy.enabled`, (b) writes a launcher (`cursor-launcher.cmd|.sh|.command`) starting the detected Cursor binary with `--proxy-server=http://127.0.0.1:<livePort>`, (c) writes the models advertisement file. CA trust stays EXACTLY the forward-proxy CA (no new trust material); installation remains an explicit operator action (certutil/security/update-ca-certificates probes are best-effort status, honest `unknown` otherwise). Teardown removes only the launcher + advertisement file — never the CA, never Cursor's own files.

### 7. Plugin-level configuration

Plugins may declare operator-facing parameters, and the console renders the settings form generically from that declaration. Three sources, strictly separated — the same triad as §4's advertisement file, generalized:

- **Declaration** — `plugin.json` `configSchema`: a flat array of `{key, type, default?, min?, max?, values?, title?, desc?}` where `type ∈ string|number|boolean|string[]|enum` and `title`/`desc` follow the manifest locale-map convention. Primitives only; there is deliberately no JSON-Schema engine — that would invite arbitrary UI complexity into the plugin protocol. A malformed schema fails the package loudly at install/load (the author-facing API must not degrade silently).
- **Storage** — `<pluginsRoot()>/config/<id>.json` holds only the operator's effective (non-default) values. Plugin parameters NEVER enter `config.yaml` (ADR-0016: frozen schema; plugin lifecycle state lives with the plugin artifacts, disabled.json / registrations.json precedent).
- **Merge** — the host validates stored values field-by-field (unknown keys dropped; wrong-typed/out-of-range values fall back to the default with a warning; a bad artifact never crashes a load) and hands the merged object to the plugin through its host SDK `config()`. Call-time lookup: always current after a console save. The merged result is cached per plugin id; every plugin reload invalidates the cache so hand-edited artifacts are picked up.

Console: `GET /api/admin/plugins/:id/config` returns `{schema, values}`, `PUT` validates + persists + fires the plugin's optional `onConfigChange(config)` (a failing hook never rolls back a persisted save; the merged values reach the plugin via `config()` regardless). A plugin without a schema exposes nothing and rejects writes — there is no free-form parameter bag.

`cursor-gateway` uses the mechanism for `toolTimeoutMs` (0 = omit `timeout_ms` in tool-call frames), `relayUnknownPaths` (false = answer an unimplemented Connect trailer instead of relaying unknown paths), and `debugFrames` (frame-level logging). The models advertisement stays a separate artifact — it is written by the client adapter from the Cursor card's model slots, not operator free text.

## Consequences

- Vendor inbound protocols become pluggable without core growth; the 2 MB proto corpus and its drift tooling live with the plugin that needs them (install = authorization). The TRANSPORT is the other half and it does not move: h2 re-origination is core (§3), so a plugin author only ever writes semantics — and an operator who installs nothing still gets a working, fully logged h2/gRPC passthrough.
- One more TransportContext implementation exists (the callback-sink gateway seam) — the terminal-send discipline is now proven by three implementations, and plugin completions are indistinguishable from native-leg completions to routing/breakers/captures.
- The Bun http2 server-side quirk (unreliable `alpnProtocol` at terminator callback time) is encoded as the preface-sniff rule — do not "simplify" back to ALPN-only routing. Same family of quirks, same rule: ALPN ORDER is a server-preference decision (verified, not assumed), and the h2 compat IncomingMessage drops chunks emitted while nobody listens — so an h2 body's head must be captured synchronously, before the first await.
- Boundaries: Tab completion, codebase indexing and login traffic are NOT intercepted (non-claimed hosts / relayed paths — Cursor keeps working against its real backend for those); the gateway carries no `x-cursor-checksum` obligations (it is the server, not the client); personal use, own machine, own account.
- No new config.yaml section: gateway lifecycle state lives with the plugin artifacts (disabled.json / registrations.json precedent, ADR-0016 posture untouched); the advertisement file is plugin artifact state, not schema.
