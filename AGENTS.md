# AGENTS.md

Guidance for AI coding agents. Repo conventions only — architecture decisions live in `docs/adr/` and are **never mirrored here**.

## Project

OmniCellRouter (OCR) — a local LLM gateway / cascaded router. Bun workspaces: `backend/` (Fastify + pino) and `frontend/` (React + Vite).

Before touching environments/bootstrap, credentials, or provider definitions, query the current ADRs (`docs/adr/`): ADR-0007 (environment book-sets, bootstrap, controlled-restart switching, export/import), ADR-0006 (the OCR file as the single credential truth, credential sync clients, key-hash identity), ADR-0005 (direct execution, execution topology, credential chains), and ADR-0010 (provider-def ownership — `<ocrHome>/providers.json` is the single def truth; `opencode.jsonc` is a sync-client materialization target). Before touching model-addressing vocabulary — the `modelRef` wording (gateway-visible id namespace, four kinds: auto alias / combo id / registered id / variant sibling id — tagged `kind` by the console catalog), `ModelRegistration` as the resolved physical record, tier-membership or combo types, or the request `model` field resolution — query ADR-0003 (model addressing and tier membership). The historical `ModelRef`/`ModelIdentity` TYPE NAMES never shipped in code — do not reintroduce them. The model-profile mechanism (`modelProfiles`, `ModelProfileConfig`, `ModelProfileBinding`, `slot:` link tags, `refreshProfileBindings`, the `/model-profiles` page) was REMOVED in ADR-0031 — client agent assignment is the clients-page rows (`agentModels`) + smart-assign only; do not reintroduce any profile vocabulary. Before touching tier/effort escalation, the `@ocr-*` directive surface, or the route-entry experience table, query ADR-0011 (scrub-everywhere / apply-last-user-message, per-turn overlays that never touch the ratchet, automatic machinery never steps down, directives never write back) and the syntax reference in `docs/design/directives.md`. Before touching quota tracking — the (provider × keyHashPrefix) pair model, the built-in declaration table / code adapters / the `quotaProbes:` config section, the probe DSL constructs and banned classes, the iron rules (they bind ONLY operator config), or the quota_events ledger — query ADR-0009 (layered quota knowledge, declarative probing, credential-anchored activation). Before touching forward-proxy policy — `forwardProxy.rules`, the `ingress` (`intercept` / `passthrough` / `reject`) and `egress` (`direct` / `proxy`) vocabulary, the admission-gate ordering, the retired `viaOutboundProxy` / `bypassHosts` / `mitmHosts` keys, or the OS proxy bypass list — query ADR-0018 (ONE ordered first-match table, TWO single-axis fields per row: `ingress` = intercepted (the default) / blind tunnel / 403 on admission, `egress` = direct / through the outbound proxy; loopback always direct + passthrough; unmatched fails open to the pre-ADR defaults; `reject` rows answer 403 before any tunnel or certificate; the table has exactly ONE spelling — a row without `ingress`/`egress` is invalid and reported, never translated, and undeclared section keys are dropped on load, never folded). Health vocabulary is layer-disciplined: `CLOSED/HALF_OPEN/OPEN` belong to the CircuitBreaker; model-level aggregation reads `available/recovering/unavailable` (ADR-0004; eviction fires only on `unavailable`, ADR-0002). Before touching protocol conversion, the canonical IR (`backend/src/ir/`), surface↔wire adapters, streaming event lifecycle, or tool-call markup recovery — query ADR-0033 (vendor-neutral canonical IR), ADR-0034 (scoped DeepSeek-v4 / opencode zen markup recovery), and `docs/design/protocol-matrix.md`.

Before touching observation-scope vocabulary — the `session` / `turn` / `request` / `exchange` / `event` ladder, the `requestId` vs `exchangeId` split, the write-time turn boundary, the console Turns column, or capture event naming — query `docs/design/glossary.md` and ADR-0024 first. Bare `turn` means one user prompt; an `exchange` is ONE HTTP request/response pair, never a container; `direction` is only `client | upstream` and names the leg, not a vector. `turn` is a WRITE-TIME attribute: `turnIndex` per session (allocated once at the admission gate by the structural rule in `capture/turn-boundary.ts`, with `isPromptStart` / `turnDecision` provenance, no `turnId`, `null` first-class), stamped on every capture event and trace record of the request — readers copy it and NEVER re-derive a boundary from prompt text or message counts. It is observational only — never a rate-limit, billing or quota key (ADR-0023 budgets are per `request`). The read plane is `CaptureRequestSummary.exchanges[]` bucketed by `(leg, attempt)`; the capture archive root is `capture/` (`CAPTURE_SCHEMA = 2` — the version rides on the data, never on the root name), and `traces.db` is `DB_VERSION = 3`. Schema evolution is a registered chain, one class per hop, one file per class under `capture/migrate/steps/`: the engine resolves a hop by `(from, to)`, builds a fresh instance per file (so `begin()` planning state is never shared) and calls `begin()` per hop over that hop's input shape and rewrites cold files atomically in place at boot and on the hourly sweep — never a new root, never a read-time branch. `V1ToV2Migrate` (`steps/v1-to-v2.ts`) is a real step, not a tombstone: schema 1 is the unmarked baseline, the step replays the SAME structural turn rule over the bodies the archive already recorded, and for archives that predate the gateway ids it rebuilds the request boundary off the recorded span sequence (`traceId` is connection scope, `spanId` is the exchange anchor) instead of guessing — stamping `migratedFrom: 1` so reconstructed identity is never mistaken for a gate stamp. A sequence it cannot close is repaired in place instead of set aside — orphan request with `NO_TURN`, second request over an unfinished one, stray response attached, mid-request file kept — because the pass must never cost the operator data it already has. There is no seal, no `capture-archive/`, no side channel: nothing leaves the live root. The retired spellings `roundNumber` / `totalRounds` / `CaptureRoundIndexEntry` / `gatewayResponse` / `CaptureTurnSummary` / `/turn?id=` do not exist in code — do not reintroduce any of them.

## Gateway quality gates — prompt integrity and cache integrity

Two invariants outrank every other tradeoff in a protocol conversion. A breach is
silent (no client error, no test failure) and expensive; treat either as a bug even
when the request still succeeds.

**Prompt integrity** — the model must see exactly the prompt the client sent:

- Every `system` / `developer` message is preserved. Multiple blocks are JOINED
  (`\n\n`), never overwritten; content-part arrays are flattened to their text,
  never `JSON.stringify`-ed into the prompt (see the system-text join in
  `ir/adapters/anthropic-messages.ts` and `ir/adapters/google-gemini.ts`, and `contentText` in
  `protocols/chat-compat.ts`).
- Tool definitions survive with `strict`, `parameters`, `description`; `tool_choice`,
  `parallel_tool_calls`, `response_format` / `text.format`, history (`tool_calls`,
  tool results, `refusal`, reasoning) all convert. Losing tool definitions collapses
  every agent loop.
- Params with no faithful target representation are rejected with
  `400 unsupported_parameter`, never silently dropped (see
  `IrUnsupportedError` and each surface's `executionError`).
- Regression surface: `backend/tests/surfaces/responses.test.ts`, `providers/provider-tools.test.ts`,
  `surfaces/surface-responses.test.ts`, `providers/anthropic-wire.test.ts`, `ir/chat-compat.test.ts`.

**Cache integrity** — cache hits are money, and a lost marker/usage field is invisible:

- Usage accounting maps cached tokens from EVERY carrier to
  `usage.prompt_tokens_details.cached_tokens`: chat (`prompt_tokens_details`),
  Anthropic (`cache_read_input_tokens`), Responses (`input_tokens_details`),
  Gemini (`cachedContentTokenCount`). Add the mapping when adding a carrier.
- Client cache controls survive the canonical hop: Anthropic `cache_control`
  (system message, content parts, tool definitions), Responses `prompt_cache_key`,
  `prompt_cache_retention`, `prompt_cache_options`, `prompt_cache_breakpoint`.
  They live on the canonical types (`CacheControl`, `ChatMessage.cache_control`,
  `ChatMessageContentPart.cache_control` / `prompt_cache_breakpoint`,
  `Tool.function.cache_control`) and are consumed only by their own carrier.
- Carrier-specific cache fields MUST be stripped before reaching a generic
  OpenAI-compatible upstream (`irToChatRequest(..., { carrierExtensions: false })`,
  which sets `stripCarrierExtensions` on `assertCanonicalRequestSupported`) —
  strict servers 400 on unknown fields. The built-in chat provider and the
  plugin chat bridge both pass that flag.
- Prefix stability is part of the gate: system blocks are emitted in a
  deterministic order with a stable joined separator, and a merged system
  message keeps a client-declared breakpoint.
- Streaming and buffered legs are ONE accounting plane: the SSE encoder exposes
  the same usage fields as the JSON encoder (Anthropic
  `cache_read_input_tokens` on `message_start`, chat's trailing `usage` frame,
  Responses `input_tokens_details` on the terminal event), and relayed upstream
  chunks forward `usage` intact. A field present on only one leg is a bug —
  Claude Code always streams.

**Admission integrity** — what the gateway accepts, and what a refusal says, is ONE
policy on both transports. Like the two gates above, a breach is silent: the client
simply gets a confusing error.

- Body limits are declared once, in `config/defaults.ts` (`GATEWAY_MAX_BODY_BYTES`
  inference, `ADMIN_MAX_BODY_BYTES` control plane, `IMPORT_BODY_LIMIT_BYTES` /
  `PLUGIN_PACKAGE_MAX_BYTES` operator uploads), and only `surfaces/body-admission.ts`
  turns them into behavior. A route never re-declares a byte cap or hand-writes a
  413/415/400 message. The two inference/admin tiers are additionally operator-tunable
  as `client.bodyLimits` (`maxBytes` / `adminMaxBytes`), resolved and clamped into
  `[BODY_LIMIT_MIN_BYTES, BODY_LIMIT_MAX_BYTES]` and installed once at boot
  (`configureBodyLimits` → `bodyLimitFor(plane)`) because Fastify reads a route's
  `bodyLimit` at registration — the knob is RESTART-ONLY (ADR-0007), never hot.
- An inbound `Expect: 100-continue` is answered from the HEADERS before any body is read
  (both legs), which RFC 9110 §10.1.1 requires of a server holding the expectation: send
  an immediate final status when the method, target URI and fields already determine it —
  a declared `Content-Length` over the cap, an undecodable `Content-Encoding`, a media
  type the plane will not parse — otherwise `100` and let the body flow. A promise that
  the server will accept the request is never issued ahead of a refusal. The refusal
  answers through `settleContinuationExpectation`, NOT the framework's `expect-continue`
  route (its default handler writes `100` and then demands the body, so the route would
  500 with `Cannot have a body with expect-continue`) — answering a continuation in the
  pre-dispatch handler is a protocol violation Node answers with `ECONNRESET`, and an
  `expect-continue` route that does not consume its body leaves the exchange hanging.
  Listeners are installed on the native leg AND both MITM inner legs (h1 inner + outer
  proxy); an h2 leg needs none, because RFC 9113 §8.2.2 forbids `Expect`. INSTALLING a
  `checkContinue` listener SUPPRESSES the server's own `request` delivery (verified on Bun
  1.3.14 and Node 24), so every listener re-dispatches when the guard says continue — a
  listener that only refuses is a hang.
- Every listener the gateway owns ARMS its own inbound liveness bounds
  (`applyInboundLiveness` in `utils/server-liveness.ts`, values
  `SERVER_REQUEST_TIMEOUT_MS` = 5 min, `SERVER_HEADERS_TIMEOUT_MS` = 60 s,
  `SERVER_KEEP_ALIVE_TIMEOUT_MS` = 5 s in `config/defaults.ts`): Node ships those
  numbers, **Bun ships none**, so a stalled or half-open client socket was reaped on one
  runtime and held forever on the other — the same class of bug as the original 413, an
  invisible default under a hand-written path. Values match Node's so Node behaviour is
  unchanged and Bun stops being undefined. The h2 inner listener carries none of these on
  purpose (a multiplexed session may legitimately sit open between streams); its body is
  still bounded by the transport timer below and its lifetime by the CONNECT keepalive.
- A server-level clock cannot express per-body PROGRESS (`requestTimeout` measures the
  whole request, so one byte a minute never trips it), so a body that STOPS arriving is
  refused by the transport's own re-armed timer — `REQUEST_BODY_IDLE_TIMEOUT_MS` in
  `readRequestBody` — with 408 `request_body_timeout`, never a second 413: the two verdicts
  ask the client for opposite fixes (shrink the payload versus resend the same one). No
  `Retry-After` rides with it (§10.2.3 scopes that field to 503/429, and nothing about the
  request is wrong), and the answer is written before the socket is closed.
- The surface registry (`surfaces/table.ts`) is never imported from a module inside the
  config graph (`config/index.ts` → quota/plugin host → `forward-proxy/server.ts`): the
  registry imports the surface modules, which import config, so the edge closes a load-time
  cycle and a surface module as entry dies on `Cannot access 'responsesSurface' before
  initialization`. `ForwardProxyDeps.detectSurface` is injected at boot for exactly this
  reason; an un-injected proxy logs that its early refusal degraded to the body gate.
- A 415 carries the negotiation field its cause owns: `Accept-Encoding` for a coding
  refusal, `Accept` for a media-type refusal, and NEVER both (§15.5.16 pairs each cause
  with its field; §12.5.3 makes the coding field a MUST NOT when the cause is unrelated to
  codings). A 413 carries NEITHER — §15.5.14 names no negotiation field for it, and
  advertising codings on a size refusal invites a retry that fails for the same reason.
  No `Retry-After` either: §15.5.14 asks for it only "if the condition is temporary", and a
  standing byte cap is not one. `connection: close` is stated because the refusal arrives
  before any body. The gateway decodes `gzip`/`deflate`/`br`/`identity`; `zstd` is a
  declared gap (no Node codec), and `deflate` stays accepted although §12.5.3 dropped it.
- The same cap bounds the DECOMPRESSED body on both legs. An inbound
  `Content-Encoding` the gateway cannot decode (`zstd`, a chain like `gzip, br`) is a 415
  naming the token — never a body fed raw to a JSON parser, which reads as the client's
  syntax error.
- Absent or non-JSON `Content-Type` is refused the same way on both legs, naming what was
  actually sent; a media-type refusal that guesses the type is a bug.
- Every admission failure is answered in the plane's OWN envelope — surface
  `error.{message,type,code}`, admin `{success:false,message}` — never the framework default
  whose `error` is a reason-phrase string (that is what rendered as the unrenderable
  `413 "Payload Too Large"`). On the Anthropic surface the `type` is `request_too_large`
  (the only size-related member of its type list — §15.5.14 says the response should
  identify the limiting factor, and a 413 has no other Anthropic type); an unframeable
  `Content-Length` — duplicated values (Bun's parser hands the app an ARRAY where Node
  errors at the socket), a non-numeric value, or bytes that do not match the declaration
  — is `invalid_content_length` (400), because the framing lied, not the payload. The
  gateway NEVER relays ambiguous framing: `filterHeaders` drops a non-singleton
  `Content-Length` so the outbound client re-frames, and strips `Expect` (hop-by-hop,
  §7.6.1) after the body was already consumed here. Every refusal logs one structured
  `body_rejected` warn — with the LEG it fired on — a rejection the operator cannot see
  is a support ticket.
- Regression surface: `backend/tests/server/body-admission.test.ts`,
  `backend/tests/server/body-limit.test.ts` (native + MITM legs, negotiation headers,
  `Expect: 100-continue`, the configured cap), `backend/tests/config/config-body-limits.test.ts`
  (resolution, clamping, disk round-trip, v4→v5).

## Common commands

- `bun run typecheck` — **run this after any code change** (backend + frontend; exit 0 = clean).
- `bun run build` — full build (`tsc -p backend && vite build frontend`); `bun run build:frontend` for frontend only.
- `bun run test` — backend suite via the isolated runner (each file runs as its own process with `OCR_HOME` pointed at a sandbox). Never run `bun test backend/tests` directly — the single-process built-in runner produces ~26 phantom failures from shared-config contamination.

## Protocol ids vs SDK packages — two axes, never mixed

OCR stores and serves PROTOCOL ids; it does not know client SDK package names. One vocabulary:

- **Protocol id = wire id** — what provider/model defs, the console dropdown, the plugin
  manifest's `protocol` key, `wireFor()` and the executor keys all use: `openai-chat`,
  `openai-responses`, `anthropic-messages`, `google-gemini`, `systemone`, plus plugin-owned
  ids (`qoder`, `workbuddy`, …). Never `@ai-sdk/*`, never a path. There is NO second "short
  wire" spelling (ADR-0033, amended 2026-11-19 / 2026-11-20); `providers/wire.ts` resolves a def's npm/type
  to one of these ids, it does not translate between two vocabularies.
- **Legacy input aliases** (`openai-compatible`, `openai`, `responses`, `anthropic`, `google`) and inbound surface names
  (`chat`, `responses`, `anthropic`) are READ-ONLY input aliases — normalized by
  `providers/protocol.ts` (`canonicalProtocol`) at every read boundary so old defs/traces still
  route. No write path emits them. The console renders full canonical ids everywhere (badges,
  tooltips, and forms) with no short badge alias table.

Client SDK spellings (`@opencode/ai/providers/<segment>`) are owned by the client integration's
bidirectional map (`opencode/provider-package.ts`, import and export directions). Retired OCR
spellings (`@ai-sdk/*`, `/qoder`) are translated by `providers/protocol.ts` on read — no write path
emits them again. Never add an SDK alias to `wireFor`; normalize at the owning boundary.

## Plugin ids — the suffix names the HALF, never the vendor

A plugin id is a path component (`<pluginsRoot>/<id>.zip`, `unpacked/<id>/`, `plugins/<id>/`) and the
packager REFUSES a manifest whose id differs from its directory name, so the two always move together.
Two plugins of the same vendor are two different halves of the same product, and the id says which:

- `-gateway` — the INBOUND half: claims the vendor's SNI hosts on the forward proxy (ADR-0017).
- `-models` — the OUTBOUND half: a model-service executor giving OCR the vendor's models
  (transport, credential chain, catalog, quota).

A bare vendor name is therefore never a correct id: `qoder` says nothing about which half it is and
reads as the canonical plugin with the other one derived from it, while the two are peers. Suffixes
name direction, not capability — `-provider` / `-direct` / `-native` / `-wire` were all rejected
because they name a credential mode, a core-internal namespace, or one method of the SDK. The WIRE id
inside `wires: []` is not the plugin id and is never renamed with it (`wires: ["qoder"]` on plugin
`qoder-models`): wire ids are core protocol vocabulary, and a plugin is only how one gets executed.
Artifacts that hold operator state keep their vendor-name spelling across a plugin rename
(`<ocrHome>/plugins/workbuddy-auth.json`) — renaming one would silently orphan a live login.

## Language — code comments are always English

Source comments (`//`, `/* */`, JSDoc), identifiers, log messages: English only. Chinese is correct **only** in product content:

- `frontend/src/i18n/locales/zh-CN.ts` (translation table), `docs/adr/zh-CN/**` / `*.zh-CN.md` mirrors. The English doc tree (`docs/adr/*.md`, `docs/design/*.md`, `docs/reviews/*.md`, `README.md`, `DEVELOPMENT.md`) is English-only, including comments inside fenced code blocks — quoted product strings (e.g. `YAML_FIELD_COMMENTS` values) get an English gloss in docs; the CJK originals live only in their sanctioned source files.
- `backend/src/config/comments-zh.ts` `YAML_FIELD_COMMENTS_ZH` / `YAML_FILE_HEADER_ZH` (the zh-CN config comment dictionaries; ADR-0016: never written into the user's `config.yaml` — the console renders them dynamically; the en counterpart is `comments-en.ts`, English-only).
- `backend/src/compression/caveman-prompts.ts` (the Chinese prompts are the feature).
- `desktop/src-tauri/src/i18n.rs` (the native tray menu label table — the Rust shell builds it before any console document exists, so it cannot use the React tables; it follows the OS locale with the same eight languages, English fallback).
- `desktop/src-tauri/nsis/installer.nsi` (`LangString OCR_*` only — the wizard's five first-run strings, one set per language declared in `tauri.conf.json` `bundle.windows.nsis.languages`; the installer runs before any console document exists and takes its language from NSIS / the OS locale, so it cannot use the React tables either).
- Copy-paste console snippets (e.g. cURL samples in `pages/ApiKeysPage.tsx`) and test fixture strings.

## Model-service plugins — one catalog-def contract

A `-models` plugin translates its vendor's vocabulary into `VendorCapabilities`
and a single `toOcrDef` (`backend/src/plugins/catalog-def.ts`, ADR-0035) builds
the models.dev-shaped def. No plugin hand-builds a def. The rules the mapper
enforces, each of which is a silent production bug when broken:

- An effort TABLE (`{type:'effort',values}`) is the only level declaration. A
  bare `{type:'toggle'}` resolves to an EMPTY ladder and `downgradeReasoning`
  then collapses every requested level to `none` — the qoder-models bug that
  produced `400 / code 1210` on models whose vendor forbids thinking-off.
  A model that always thinks is `disableable: false`, which withholds `none`
  from its ladder.
- Omit `tool_call` / `temperature` / `structured_output` / `limit.input` /
  `cost` unless the vendor declared them. `undefined` means "not stated".
- `attachment` and `modalities.input` are one fact; the modality vocabulary is
  models.dev's full one (`text|image|audio|video|pdf` in, `text|image|audio`
  out). `attachment` is the VISION boolean specifically.
- Unmappable vendor fields are kept verbatim under `vendor`, never read by
  routing.

The rules are pinned once in `backend/tests/plugins/catalog-def-contract.test.ts`.

**User-facing UI text is never hardcoded** — it must go through `t('i18n.key')`. A hardcoded Chinese string in a `.tsx` is a bug; fix it.

Verify (expected hits: `config/index.ts` `*` globs and `ApiKeysPage.tsx` snippet only):

```bash
rg -n '//.*[\x{4e00}-\x{9fff}]|\*.*[\x{4e00}-\x{9fff}]' backend/src frontend/src -g '!zh-CN.ts'
rg -n '[\x{4e00}-\x{9fff}]' docs/adr/*.md docs/design/*.md docs/reviews/*.md README.md DEVELOPMENT.md AGENTS.md
```

## Frontend conventions

- `frontend/src/lib/api.ts` mirrors backend response types 1:1 **by the backend contract name** (`CredentialMeta`, `CredentialHealth`, …). Never weld a consuming page/panel prefix onto the wire type; module prefixes are reserved for genuinely different entities (`CredentialStore*` = the key repository).
- **Dropdowns: always `Combobox`, never native `<select>`** (native popups can't be themed). Use `frontend/src/components/Combobox.tsx`: `value: string`, `onChange: (v: string) => void`, `options: { value, label, meta?, swatch? }[]`, optional `placeholder` / `clearable`; filter input only appears when `options.length > 8`.
- **Tables that scroll: always `ScrollTable`, and never a sticky `<th>`.** The header is a normal
  row OUTSIDE the scrolling body, so the scrollbar belongs to the body and rows never slide under a
  floating head; column widths are measured from the body's first row, so the head stays aligned
  under either `auto` or `fixed` body layout (`fill` for flex parents, `maxHeight` for dialogs,
  `minWidth` for a sideways floor). Page-level tables keep a plain header row too. Reference
  consumers: `pages/HarnessPage.tsx` (MCP parameters) and `pages/ModelsPage.tsx`.

## Single-source constants — no drift twins

A runtime default or cross-cutting magic number is declared **exactly once** and imported
everywhere else. Re-declaring the same literal locally (config fallback + runtime fallback,
backend + frontend mirror, provider × provider) is a drift twin: identical today, silently
divergent after the next edit.

- Backend defaults live in `backend/src/config/defaults.ts` (provider timeout, forward-proxy
  port, headroom port/timeout, maxBodyBytes, the gateway/admin body tiers, layer2 timeout,
  route-entries cap, forward-proxy hang guard). Config defaults, runtime fallbacks and CLI
  fallbacks all import from there.
- Frontend mirrors of backend defaults live in `frontend/src/lib/defaults.ts`; when a backend
  default changes, update the mirror in the **same** commit (header of that file says so).
- The three observation ledgers (failure / ratelimit / quota events) share the ring skeleton
  in `backend/src/utils/event-ring.ts` (capacity, coalesce window, message bound, id scheme,
  upsert-then-trim order) — never re-declare `MAX_EVENTS`-style constants per module.
- Shared wire/payload helpers (e.g. `DATA_URL_RE`) live in `backend/src/providers/wire.ts`.
- The release version is declared once, in the root `package.json`; `scripts/version-sync.ts`
  (wired as the `npm version` lifecycle hook) mirrors it into the workspace subpackages,
  `tauri.conf.json`, `Cargo.toml`, the self-crate entry in `Cargo.lock` and the two workspace
  entries in `bun.lock`. Never hand-edit those copies; CI drift-guards with
  `bun scripts/version-sync.ts --check`.
- Exception: defaults baked into prose (`YAML_FIELD_COMMENTS`, i18n strings) are sanctioned
  copy — changing a constant means sweeping those strings in the same pass (cleanup contract
  below).

Spot-check for regressions:

```bash
rg -n '\|\| *300000|\|\| *4555|\|\| *8787|\?\? *16777216|setTimeout\(60000' backend/src -g '*.ts'
```

## Cleanup contract — code, comments and ADRs move together

Deleting or renaming a symbol is **not finished** until every reference to the removed
behavior is gone: source comments, docstrings, test titles/describe blocks, README and ADR
prose. A comment that describes deleted code is residue — it teaches the next reader a
contract that no longer exists. Sweep it in the same pass:

```bash
rg -n "(//|\*).*\b<DeletedSymbol>\b" backend/src frontend/src backend/tests   # must be empty
```

Behavior changes update the governing ADR under `docs/adr/` in the **same** commit — code
and doc together, never a later "docs follow-up".

`bun run typecheck` does **not** detect dead code: `backend/tsconfig.json` omits
`noUnusedLocals` / `noUnusedParameters`. Audit before claiming any cleanup is complete:

```bash
npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters   # 0 hits as of 2026-12
npx tsc -p frontend --noEmit --noUnusedLocals                       # 0 hits
```

Treat a green typecheck as necessary, not sufficient. Any new hit is a review finding.
