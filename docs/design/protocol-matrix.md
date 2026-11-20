# Canonical IR protocol and execution matrix

Status: implemented for the built-in protocols listed here. The executable tests and `ir/capabilities.ts` are the source of truth; this document explains their dimensions rather than maintaining a second hand-written list of every case.

## 1. Conversion coverage

Northbound: OpenAI Chat Completions (`openai-chat`), OpenAI Responses (`openai-responses`), Anthropic Messages (`anthropic-messages`). Southbound: those three plus Google Gemini `generateContent` (`google-gemini`). Every hop is `client protocol -> Canonical IR -> provider protocol`; responses and streams take the reverse path through the same IR.

| Dimension | Exhaustive set | Cases | Executable proof |
| --- | --- | ---: | --- |
| Request conversion | 3 northbound × 4 southbound | 12 | `backend/tests/ir/ir-matrix.test.ts` |
| Buffered response conversion | 4 southbound × 3 northbound | 12 | `backend/tests/ir/ir-matrix.test.ts` |
| Streaming conversion | 3 client protocols × 4 upstream protocols × 2 client shapes (JSON/SSE) × 2 upstream shapes (buffered/native) | 48 | `backend/tests/ir/ir-matrix.test.ts` |
| Streaming posture | client `allow/deny/always` × upstream `follow/stream/buffered` | 9 | `backend/tests/ir/ir-matrix.test.ts` |
| Native transport and JSON fallback | four provider implementations | all | `backend/tests/providers/provider-native-streams.test.ts` |
| Sanitized persisted stream corpus | Chat/Responses/Anthropic/Gemini golden JSON | 4 | `backend/tests/ir/ir-golden-fixtures.test.ts` and `backend/tests/fixtures/ir/` |

The common fixtures contain semantics every target can express: instructions, ordered conversation input, function definitions and calls, tool results, assistant text, terminal status and cached usage. They do not imply every vendor feature is portable. Feature-specific negative cases prove that an unsupported mapping fails explicitly instead of disappearing.

## 2. Capability and fidelity dimensions

`backend/src/ir/capabilities.ts` is the executable feature matrix. `ir-gates.test.ts`, `ir-conformance.test.ts`, `cache-integrity.test.ts` and protocol surface suites cover both positive mappings and rejection paths.

| Dimension | Chat | Responses | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| Native upstream SSE | Yes | Yes | Yes | Yes |
| Buffered JSON / stream-request JSON fallback | Yes | Yes | Yes | Yes |
| Content parts | text, image, refusal | text, image, file, refusal | text, image, file | text, image, file, audio |
| Tool definitions | function | function, custom, builtin | function | function |
| Structured output | JSON object/schema | JSON object/schema | JSON schema mapping | JSON object/schema |
| Reasoning controls | effort mapping | effort, budget, summary, signatures | budget, signatures | budget, thought signatures |
| Multiple candidates | Yes | No | No | Yes |
| Response annotations | No | Yes | Yes | opaque carrier extension only |
| Request cache controls | key plus carrier-owned breakpoints; generic upstream strips foreign markers | key, retention, options, part breakpoint | part/tool/item `cache_control` | none advertised |
| Item references / stateful upstream | No | Yes | No | No |

Additional gates cover media source kind, strict tool schemas, allowed tool choice, parallel tool calls, generation fields, verbosity, logprobs, service tier, attribution, metadata, item references and stream options. Opaque same-carrier extensions may round-trip; a foreign opaque item/part or an unrepresentable load-bearing feature raises `unsupported_parameter`. No adapter stringifies unknown content into the prompt or silently discards signed reasoning, citations, tool definitions or usage details.

## 3. Streaming, backpressure and terminal semantics

| Concern | Contract |
| --- | --- |
| Client JSON + native upstream SSE | Drain upstream events into one IR response; send one JSON response. No client byte is committed, so retry/failover remains legal. |
| Client SSE + buffered upstream | Expand the final IR response into canonical events and encode the client's native SSE lifecycle. |
| Client SSE + native upstream SSE | Decode once upstream, relay each IR event, encode once for the client. The registry accumulates the same event objects for usage/accounting. |
| Slow client | Both node transports await `drain`; production does not enqueue an unbounded frame history. |
| Cancellation | Early iterator exit cancels the upstream body. Normal disconnect handling still drains terminal usage where the relay contract requires it. |
| Commit point | After headers/first SSE byte, do not retry or append a JSON error terminal; close without a second terminal response. |
| Total/idle timeouts | Defaults: buffered 30 min; stream total 60 min; stream idle 5 min. Provider config can override them. |
| Semantic accumulation | 32 MiB character cap across accumulated text/tool/reasoning data. |
| SSE parser | 32 MiB cap for one unterminated frame/data payload; a large network chunk containing complete small frames is valid. |
| Raw stream capture | 256 KiB cap, independent of semantic event delivery. |

## 4. Cache accounting and request controls

| Carrier | Cached-input usage source | Other retained usage |
| --- | --- | --- |
| Chat | `usage.prompt_tokens_details.cached_tokens` | reasoning, audio and prediction token details |
| Responses | `usage.input_tokens_details.cached_tokens` | reasoning, audio and prediction token details |
| Anthropic | `cache_read_input_tokens` | cache creation total and 5m/1h buckets |
| Gemini | `usageMetadata.cachedContentTokenCount` | reasoning/thought token count |

Buffered and native-stream legs map these into `CanonicalResponse.usage.cachedInputTokens`; both JSON and SSE northbound encoders expose their carrier's equivalent. Prompt-cache keys, retention/options and client cache breakpoints remain on canonical request types and are consumed only by carriers that declare support. Generic OpenAI-compatible upstreams strip foreign carrier extensions before rendering.

## 5. Compression pipeline

Compression runs before routing and upstream rendering; it never becomes a second execution IR.

| Stage | Mutation boundary | Integrity contract |
| --- | --- | --- |
| RTK | text parts of `tool_result` items only | Never rewrites assistant tool-call arguments, tool definitions, cache markers, signatures or extension parts. Deterministic transformations keep prefixes stable. Lossy compactors identify their marker. |
| Headroom | Optional external Chat `/v1/compress` projection | Projection/conversion failure, non-200, message-count mismatch and `compression_skipped` fail open to the original IR. Projection failure exposes `headroomSkippedReason`. |
| Caveman | appended system instructions only | Existing prefix stays ordered and unchanged; repeated injection is deterministic and idempotent. |

`backend/tests/ir/compression-integrity.test.ts` pins these rules together with capture order: the client leg records the pre-compression client protocol body, while the upstream leg records the actual post-compression provider payload.

## 6. Capture fidelity

Capture stays on the two physical HTTP legs, not on the IR: client events retain the client protocol envelope and upstream events retain the actual provider wire body. Converting through IR therefore does not replace either protocol with a canonical debug payload.

“Raw wire” is an operational description, not a promise of byte-for-byte archival: JSON can be reserialized, configured directives are removed where the execution path removes them, credentials are redacted by default, and size caps/truncation apply. Upstream streamed-response raw capture is specifically capped at 256 KiB without truncating semantic deltas.

## 7. Verification entry points

- `bun run test` — hermetic isolated suite; no live provider calls.
- `bun run test -- ir-matrix ir-golden-fixtures provider-native-streams compression-integrity stream-resource-boundaries` — focused conversion/resource suite.
- `bun run bench:ir` — deterministic local baseline for four request renderers, four native decoders, long context, 10k deltas, the 48 streaming combinations, slow-client backpressure and concurrent heap use. Results are machine measurements, not portable CI timing thresholds.
- `bun run test:live` — inert unless `OCR_LIVE_TEST=1` and `OCR_LIVE_PROVIDERS` are explicit. Each selected provider needs its own `OCR_LIVE_<PROTOCOL>_API_KEY` and `_MODEL`; optional `_BASE_URL`, `_TIMEOUT_MS` and Chat `_ORGANIZATION` are supported. It runs buffered/native-stream text and tool-call contracts, reports cached usage when returned, never prints credentials, and labels missing configuration `skipped`, not `pass`.

Live checks are not part of ordinary CI evidence until they have actually run against the relevant provider accounts and models.

## 8. Explicit boundaries and remaining work

- There is no Gemini northbound surface.
- Responses northbound Conversations, background execution/polling and automatic truncation are rejected explicitly; they are not implemented gateway features.
- Plugin model-service API v1 remains a versioned Chat executor boundary. A native plugin IR v2 contract is not claimed or implemented.
- System One is a decision protocol, not another chat item surface.
- A same-carrier opaque extension is not proof of portable cross-vendor semantics. New dialects need a faithful adapter mapping and conformance fixtures, or a visible rejection.
- Golden fixtures and local simulations prove gateway behavior; they do not replace live-account interoperability tests for every provider/model combination.
