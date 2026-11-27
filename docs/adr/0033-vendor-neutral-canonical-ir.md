# ADR-0033 — A vendor-neutral canonical IR between protocol surfaces and wires

- Status: Accepted (implemented)
- Date: 2026-11-18; completed 2026-11-19
- Supersedes: the "canonical chat chain" wording of ADR-0008 §9

## Context

ADR-0008 standardized every conversion on `ChatCompletionRequest`. That was a
pragmatic bridge, not a neutral model: chat has no typed items, no item
lifecycle, no signed reasoning, no multi-part tool results, and no neutral
cache-control object. The old chain consequently dropped Anthropic documents,
signed/redacted thinking and multimodal tool results, flattened Responses typed
items, and needed carrier-specific patches on a Chat-shaped intermediate.

A gateway whose product is conversion cannot use one vendor's API shape as its
semantic model. The model must sit above all of them.

## Decision

1. **Canonical IR is the single semantic model.** It lives in
   `backend/src/ir/` and uses item semantics rather than Chat message semantics:
   - `instructions` is first-class and separate from conversation `input[]`;
   - typed `input[]` / `output[]` items (`message`, `tool_call`, `tool_result`,
     `reasoning`, `item_reference`, `extension`) preserve item ids, status and
     ordering;
   - typed content parts (`text`, `image`, `file`, `audio`, `refusal`,
     `extension`) preserve media sources, citations, signatures and cache
     breakpoints;
   - tools are a typed union: `function`, `custom`, `builtin` and `extension`;
     `tool_choice` includes Responses `allowed_tools`;
   - tool calls keep both item `id` and correlation `callId`; malformed argument
     JSON fails at a target that requires an object instead of being rewritten.
     Carriers without item ids (Chat, Anthropic, Gemini) put the tool-call id in
     both slots, and the Responses wire rejects a `function_call` / `custom_tool_call`
     item id that does not start with `fc_` / `ctc_` ("Expected an ID that begins
     with 'fc'", param `input[n].id`). The Responses adapters therefore derive the
     item id from the incoming tool-call id deterministically
     (`responsesToolItemId`); `call_id` keeps the string it was given whenever it is
     already inside its own field budget AND the shared id charset `[A-Za-z0-9_-]`
     (the shape and the length are two rules, and a charset-only test would let a
     120-character id through), and is otherwise replaced by a deterministic
     `call_`-prefixed SHA-256 digest (`responsesCallId`, budget
     `RESPONSES_CALL_ID_MAX_LEN`) because upstream Responses APIs field-validate that
     string's length and answer 400 on an over-long one — a client id arriving from
     another carrier (chat owns `tool_calls[].id`, and a plugin agent loop re-injects
     the id a PREVIOUS upstream minted) is not ours to shape. Neither derivation may
     sanitize or truncate the ORIGINAL: the same history must yield the same id on
     every turn, or the replayed prompt prefix turns over and the upstream prompt
     cache misses, and two ids that share a prefix must never merge onto one
     correlation id. The projection exists on the OUTBOUND REQUEST LEG ONLY, on the
     `call_id` field —
     canonical state, the session store a `store: true` chain replays, and the recorded
     canonical response
     keep the original id (the archive of the UPSTREAM request records what was actually
     sent, which is the rendered form), because a digest handed back to a client would meet the
     original in the next turn's history, pair as an orphan, and let pairing repair
     overwrite the client's real tool result with a synthetic "cancelled" placeholder.
     Buffered and streamed encoders share both derivations so an emitted item never
     changes id between `output_item.added` and the terminal response, and an item id that
     already carries its item-type prefix passes through unchanged;
     A tool call whose upstream supplied NO id (a lenient OpenAI-compatible server returns
     `tool_calls[]` without one) is given ONE minted anchor that fills both its item id and
     its `call_id`: never the digest of an empty string — that is a CONSTANT, so every
     unlabelled call in one response collapsed onto a single item id a client cannot tell
     apart — and never an empty `call_id`, which no reply can name and which the request-leg
     budget then refuses when the client replays it. The mint's prefix follows the item
     TYPE (`fc_` / `ctc_` for a tool call, `msg_` / `rs_` / `item_` for the rest), an
     `extension` item's name is read from its own payload before anything is minted so the
     buffered and streamed legs cannot disagree, and the extension passthrough is a COPY —
     writing a minted name into the payload would stamp it into the recorded upstream item;
     the anchor is minted in CANONICAL state by the reader, from ONE namespace shared by every
     adapter (`ir/tool-identity.ts`), because canonical state is what the session store records,
     what capture archives and what every carrier renders from — a name invented later, at
     wire-render time, would leave the stored turn unnamed and the next turn of a `store: true`
     chain would be refused by this gateway's own gate. A stream leg reads one item MORE THAN
     ONCE (`output_item.added`, then `output_item.done`, and the accumulator lets the later frame
     replace the earlier one), so an inbound stream decoder remembers the name it minted for that
     output index; without that memo the anchor handed to the client mid-stream is not the anchor
     its tool result pairs against. Minting lives on the RESPONSE plane only: the request plane
     copies the name the client wrote, empty or not, because a harness resends its whole history
     every turn and a name invented while reading it changes the outbound prefix bytes on each
     resend — the same cache gate above. A correlation named by NOTHING is therefore refused at
     the outbound gate (`tool_call_id`) rather than renamed;
   - reasoning text, summary parts, signatures and encrypted content are
     distinct fields — text is never relabelled as a summary;
   - generation, structured-output, reasoning, cache, stateful-request and
     attribution controls have explicit canonical fields;
   - usage retains cached input, cache writes, reasoning, audio and prediction
     token breakdowns;
   - streaming uses a vendor-neutral item lifecycle (`StreamEvent`), including
     text/refusal/reasoning/summary completion and terminal status events.

2. **Every northbound surface parses directly into IR.** Chat Completions,
   Responses and Anthropic Messages retain their external wire contracts.
   Gemini is an OUTBOUND provider protocol only; no Gemini northbound surface is
   claimed. System One remains a separate decision protocol, not a chat item
   model.

3. **Every southbound provider consumes and returns IR.** OpenAI Chat, OpenAI
   Responses, Anthropic Messages and Gemini `generateContent` have independent
   adapters. The orchestrator, router, session history, RespStore, usage
   accounting and surface encoders never require a Chat intermediate.

   Chat remains only at explicit boundaries: the Chat surface/provider adapter,
   the versioned plugin Chat contract, the external Headroom API, legacy disk
   migration, and tests that deliberately exercise those boundaries.

   Physical layout matches that rule: vendor-neutral stream helpers live in
   `ir/stream.ts` (`createEventAccumulator`, `canonicalResponseToEvents`); Chat
   SSE codecs live in `ir/adapters/openai-chat-stream.ts` beside `adapters/openai-chat.ts`.
   Endpoint-scoped tool-markup recovery (ADR-0034) lives under `providers/`,
   not in the IR core.

4. **Vendor knowledge is namespaced and loss is visible.** Carrier-owned data
   lives in `VendorBag` or an `extension` item/part. Same-carrier conversion may
   replay it. A foreign opaque item, unsupported media source, tool kind,
   citation, signature or cache control throws `IrUnsupportedError` and maps to
   `400 unsupported_parameter`; it is never blanked or JSON-stringified into a
   different meaning. Gemini grounding/logprob response metadata is retained as
   opaque extension output until a faithful target mapping exists.

5. **One capability gate runs before payload rendering.** Each southbound
   adapter calls `assertCanonicalRequestSupported` against the executable
   matrix in `ir/capabilities.ts`. The matrix covers content and source kinds,
   tools, structured output, reasoning, state, generation, attribution and cache
   breakpoints. Client-only `stream_options` is consumed by the northbound Chat
   encoder and is not misreported as an upstream capability.

6. **Payloads are explicit whitelists.** No provider spreads a client request
   into an upstream body. Generic OpenAI-compatible Chat still strips
   carrier-only cache markers at its boundary, as required by the cache
   integrity gate; this is a deliberate adapter policy, not a second canonical
   model or a growing cross-protocol conversion chain.

7. **Streaming capabilities are honest.** All four built-in providers — OpenAI
   Chat, Responses, Anthropic and Gemini — decode native upstream SSE into IR
   events. A JSON upstream response remains a supported fallback and is expanded
   through the same canonical event and terminal-status semantics as a buffered
   call. The client and upstream streaming axes are independent: a JSON client
   may drain native upstream SSE into one response, while an SSE client may
   receive events synthesized from a buffered upstream call. Responses item ids
   allocated while streaming are reused by item-completion events and the
   terminal response.

8. **Conversion work and buffering are bounded.** Each boundary parses or renders
   once; streaming relays events incrementally. One unterminated SSE frame and
   accumulated semantic text are each capped at 32 MiB, raw streamed-upstream
   capture is capped at 256 KiB independently of semantic deltas, and client
   writes await drain instead of building an unbounded slow-client queue. Early
   iterator exit cancels the upstream body; normal client disconnect accounting
   still drains terminal usage. No all-pairs converter matrix or repeated Chat
   round-trip remains in the core path. The conformance and resource suites
   cover long context, high-frequency deltas, oversized frames, cancellation,
   timeout and backpressure; `bun run bench:ir` records machine-specific latency
   and heap measurements without a fragile universal timing threshold.

## Naming

- **Protocol id = wire id** (stored, console, plugin manifest `protocol`,
  internal executor key — ONE vocabulary, ADR amendment 2026-11-19 / 2026-11-20):
  `openai-chat`, `openai-responses`, `anthropic-messages`,
  `google-gemini`, `systemone`, plus any protocol id a model-service plugin
  declares (bare protocol name, never an SDK npm package). A `WireKind` value
  IS its protocol id — there is no second "short wire" spelling. The plugin
  half of this list is DERIVED from the loaded plugin manifests, not enumerated
  here — see below.
- **Legacy input aliases** (read-only, never emitted): the retired ids
  `openai-compatible` / `openai` / `responses` / `anthropic` / `google` and inbound surfaces
  `chat` / `responses` are normalized by `providers/protocol.ts` at every read
  boundary (`wireFor`, `protocolForWire`, probe, dispatch traces, `trace/persist.ts` replay), so archives
  and defs authored before the rename keep routing and display identically.
  No stored data is rewritten.
- **Unambiguous display** (ADR amendment 2026-11-20): the console renders the
  full canonical ids (`openai-chat`, `openai-responses`, `anthropic-messages`,
  `google-gemini`, `systemone`) everywhere — badges, tooltips, and editing forms —
  eliminating any ambiguity with short names (`chat`/`responses`/`messages`).
- **IR types**: `CanonicalRequest`, `CanonicalResponse`, `InputItem`,
  `OutputItem`, `StreamEvent`.

> Amended 2026-11-20: renamed `openai-compatible` to `openai-chat` so every
> built-in protocol follows the `<vendor>-<api>` naming shape (`openai-chat`,
> `openai-responses`, `anthropic-messages`, `google-gemini`), and dropped the
> short badge alias table (`chat`/`responses`/`messages`/`gemini`) so console
> badges are unambiguous; `openai-compatible` remains a read-only input alias.

## Amendment (2026-12) — the wire vocabulary is registry-driven

The plugin host is the ONE authority on which wires exist: a model-service
manifest declares `wires: []`, and `getModelServicePlugin(wire)` matches a
loaded plugin's `PluginView.wires`. Everywhere that used to answer "is this a
plugin protocol?" by naming vendors was wrong in the same way — a plugin
protocol nobody named fell through to the OpenAI-compatible chat wire and the
resulting `400` was blamed on the upstream.

- `backend/src/providers/plugin-wires.ts` is the bridge: the host PUSHES the
  claimed wire set at the tail of every registry rebuild (`claimPluginWires`),
  every decision point ASKS (`isPluginWire`). No core file enumerates a plugin
  protocol; a new plugin protocol needs no core edit.
- Consumers and what they now derive: `wireFor` (`providers/wire.ts`) resolves a
  plugin wire to itself and only after the core shapes (a plugin never annexes a
  core wire); `DispatchingProvider` (`providers/executors/dispatch.ts`) and
  `ProviderRegistry` (`providers/registry.ts`) build the plugin executor from the
  registry and leave the wire UNSET when the plugin is absent, so dispatch fails
  by wire id instead of routing to a chat executor; the console vocabulary
  (`providers/vocabulary.ts`) appends plugin wires only while an installed plugin
  claims them; `CLIENT_PACKAGE_FALLBACK` (`opencode/credentials/def-materialize.ts`)
  substitutes `openai-chat` for EVERY plugin wire (a vendored transport has
  no client SDK segment by definition) instead of listing vendors.
- `WireKind` / `ProbeKind` / `ProviderConfig.type` / `ModelRegistration.wire` are
  therefore open: core literals for readers, plugin ids as `string & {}`. A
  closed enum here is a drift twin of the plugin registry.
- Bootstrap floor: `NATIVE_WIRES` in `plugin-wires.ts` (`qoder`, `workbuddy`) is
  an IDENTITY list, not a dispatch table — an OCR-native protocol id IS its own
  wire and a def carrying one must resolve to it even while the plugin is absent
  (the def may predate the install; the wire is decided at boot, long before a
  missing executor could raise its own error).

## Implementation state

- The core execution and observation path is IR-only; the old route-level Chat
  converter libraries and Chat chunk accumulator are deleted.
- Responses continuation nodes store canonical input/output items (`v: 2`);
  Chat conversion exists only when replaying legacy recovery records.
- `backend/tests/ir/ir-conformance.test.ts` pins cross-protocol ordering, tool and
  media fidelity, reasoning, cache controls, usage, explicit failures, stream
  lifecycle/id stability and bounded conversion work.
- `backend/tests/ir/ir-matrix.test.ts` executes 12 request, 12 buffered-response,
  48 streaming and 9 posture combinations. Golden sanitized stream fixtures,
  compression/cache integrity and resource-boundary suites are listed in
  `docs/design/protocol-matrix.md`.
- `bun run test:live` is the explicit opt-in real-account contract entry point;
  it is excluded from the hermetic suite and skipped setup is never evidence of
  provider compatibility. `bun run bench:ir` supplies the local performance baseline.
- ADR-0008 §9 now states the IR invariants instead of a canonical Chat chain.

## Consequences

- More explicit types and adapters replace implicit loss and pair-wise patches.
- Every new carrier must declare capabilities and pass the conformance corpus.
- “Buffered upstream with synthesized client SSE” is not described as native
  provider streaming.
- Unsupported vendor dialects are not silently accepted: a faithful mapping must
  be implemented, or the conversion must fail visibly.

## Amendment — prefer-native southbound dial from `protocols[]`

OCR-owned models carry `protocols: string[]` (ADR-0010). Northbound conversion into Canonical IR is unchanged. Southbound dial selection is request-scoped:

1. Resolve the model's ordered protocol set (model override → catalog model → provider def → catalog provider).
2. If the inbound surface protocol id is in that set, dial it (same-carrier fidelity; no cross-wire conversion loss for that attempt).
3. Otherwise try each remaining id in declaration order; the first wire for which `assertCanonicalRequestSupported` admits the request wins (capability escalate).
4. If none admit, dial `protocols[0]` and let the existing gate refuse visibly.

One attempt still speaks exactly one wire. Multi-protocol is a dial set, not a parallel fan-out. Plugin wires and `systemone` participate when listed; they are never invented by the dialer.
