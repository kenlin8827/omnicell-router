# ADR-0034 — Scoped Tool-Call Markup Recovery With Residual Observation

- Status: Accepted (implemented)
- Date: 2026-11-19
- Supersedes: the earlier same-numbered observation-only and unrestricted-repair
  revisions

## Context

Some model families emit a tool call as markup inside assistant text and rely on
the API in front of them to convert it into structured `tool_calls`. DeepSeek V4
has been observed doing so, in both a DSML-spelled form and a form with no DSML
sentinel:

```
<｜tool_calls｜>
<｜invoke name="ls">
<｜parameter name="path">src</｜parameter>
</｜invoke>
</｜tool_calls｜>
```

The authoritative converter belongs to the layer that owns the chat template:
the model server (`vLLM --tool-call-parser deepseek_v3`, SGLang's equivalent) or
the provider API before it answers. OCR cannot repair that upstream component.
When the opencode zen relay passes the markup through, however, OCR clients see
tags as prose, no tool runs, and the model repeats its own markup on later turns.

An earlier unrestricted gateway repair was unsafe: it keyed on a literal `DSML`
sentinel that real traffic did not contain, could rewrite code examples, treated
truncated calls as complete, duplicated native calls, reused synthetic ids, and
turned streaming providers into assembled-then-replayed responses. An
observation-only revision exposed the leak but left the affected known path
unusable. The decision is therefore narrower than either predecessor.

## Decision

**1. The endpoint owns the authoritative fix; OCR performs one defensive,
strictly scoped recovery.** `toolMarkupRecoveryFor` in
`backend/src/providers/compat/tool-markup-recovery.ts` enables the `dsml` recovery only when
all of these facts hold:

- the resolved model's `upstreamModel` contains `deepseek-v4` as its own id token (case-insensitive; `deepseek-v4-flash` matches, `deepseek-v40` does not);
- the provider `baseUrl` has hostname `opencode.ai` and path `/zen/v1` (a
  trailing slash is equivalent);
- the request declares at least one callable function tool allowed by its
  `toolChoice` (`none` and incompatible `custom` choices disable recovery).

Provider ids deliberately play no role, so renaming a provider does not change
behavior. Official DeepSeek endpoints, other opencode paths, other model
families, and requests without callable tools remain untouched. This is not a
general DSML compatibility mode and must not grow into an undeclared dialect
sniffer.

**2. Recovery is all-or-nothing per call and never guesses.** The parser accepts
the observed full-width/ASCII spellings, optional DSML sentinel, wrapped or bare
`invoke` blocks, parallel calls, and zero-argument calls. It converts only a
complete, closed invocation whose name was declared by the request and whose
arguments pass structural schema checks (including declared types, required
properties, enums, arrays and `additionalProperties: false`). This is not a full
JSON Schema validator. A real untyped string parameter may be accepted only when
the declared schema establishes that it is a string; arbitrary non-JSON values
are never cast to make a call succeed.

Unknown tools, malformed parameters, schema mismatches and truncated markup stay
ordinary text. A malformed wrapper is indivisible: OCR never recovers one
parallel sibling while leaving another behind. Fenced code and inline-backtick
code are prose, even when their contents are a syntactically valid invocation.
Assistant text that is an exact echo of a user message or tool_result text is
never recovered — a model that mirrors attacker-supplied DSML must not upgrade
that prose into an executable `tool_call`.

**3. Buffered and streaming legs share the same IR semantics.** The buffered path
uses `recoverToolMarkupInResponse`; the native SSE path uses
`createToolMarkupStreamRecovery`. Ordinary text deltas continue incrementally.
Only text that can still become a tool tag, fenced block or inline-code span is
held, with a 1 MiB pending bound that falls back to pass-through rather than
unbounded buffering. Tool items wait for end-of-stream reconciliation so an
upstream empty native placeholder and a recovered call cannot both execute.
There is no whole-response fake stream and no transport switch.

Recovered synthetic ids include the response id, candidate index and sequence.
A native same-name empty/`{}` placeholder receives the recovered arguments and
keeps its native id instead of producing a duplicate. Candidate zero mirrored as
the primary output is converted once. Non-length terminal reasons, including
`content_filter`, are preserved.

Failed buffered responses are never repaired. On a failed stream, queued
recovered calls are discarded and suppressed source blocks are re-emitted as
text before the failure terminal; deltas already relayed cannot be retracted.
No terminal path silently converts an incomplete invocation into an executable
call.

**4. Recovery and residual leakage are separate observations.** A successful
conversion stamps `CanonicalResponse.toolTextRecovery` and emits
`X-OCR-Recovered-Tool-Calls: <n>` on buffered responses. It does not pretend the
upstream parser is healthy.

After scoped recovery, `backend/src/providers/compat/tool-markup-leak.ts` remains a read-only
detector for markup still present in text. On unscoped responses it observes the
original leak. Residual markup stamps `X-OCR-Tool-Markup-Leak: <n>` where a
buffered header is available and records one serving failure-ledger row on both
legs (`errorClass: 'UNKNOWN'`; the message names provider and count). Streaming
uses the incremental scanner or the recovered response, never a late response
header. No new breaker/error category is introduced for one diagnostic.

**5. The client does not grow a second parser.**
`frontend/src/pages/PlaygroundPage.tsx` does not recover tool markup. Northbound
protocol surfaces receive the same canonical tool items; the single defensive
parser lives at the southbound provider execution boundary, where endpoint and
model scope are known.

## Consequences

- The affected opencode zen + DeepSeek V4 path can execute complete, declared
  tool calls on both buffered and native streaming requests, while ordinary
  prose continues to stream.
- Code examples, unknown tools, malformed or truncated calls, failed responses,
  unrelated endpoints and tool-less requests do not acquire synthetic tool
  executions. Failed streams retain suppressed source as text.
- Operators can distinguish a defensive recovery
  (`X-OCR-Recovered-Tool-Calls`) from markup that still leaked
  (`X-OCR-Tool-Markup-Leak` plus the serving ledger). Recovery is not evidence
  that the endpoint was fixed; the provider/model-server parser remains the
  authoritative repair point.
- Expanding support to another endpoint or dialect requires observed evidence,
  an explicit scope change, adversarial tests and an amendment to this ADR. A
  provider rename alone neither enables nor disables the existing scope.
