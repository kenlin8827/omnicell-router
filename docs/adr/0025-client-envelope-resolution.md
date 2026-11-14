# ADR-0025: Client Envelope Resolution — Layered Inference, Declared Prompts Win

Date: 2026-11-14
Status: **Implemented** — all four layers below exist in code and are pinned by
tests. Governs: `backend/src/utils/client-envelope.ts`,
`backend/src/utils/harness-profiles.ts`,
`backend/src/pipeline/orchestrator.ts`,
`backend/src/capture/recorder.ts`,
`backend/tests/client-envelope.test.ts`,
`backend/tests/session-title.test.ts`,
`backend/tests/capture.test.ts`.

> **Change discipline.** A new harness is covered by DATA (one profile entry)
> or not at all — the normalizer's rules do not grow per client. A profile tag
> lands only after it was measured on the wire from the real client, and its
> evidence (session id, date, instrumented version) lands in the same commit.

## Context

Every agent harness prepends its own context to the human turn. Cursor's agent
sends a standalone `<timestamp>11/8/2026, 8:53:57 PM GMT+8</timestamp>` message
and a whole `<user_info>`/`<rules>`/`<agent_skills>`/`<mcp_server_catalog>`/
`<hooks_context>` bundle, then wraps the real turn in `<user_query>`. Claude Code
(measured 2026-11-14, `claude-cli/2.1.317`, capture session `cc_c6a59aae…`)
instead MIXES machinery and human text in ONE user message: a git-attribution
`<system-reminder>`, the `/clear` command record
(`<local-command-caveat>` / `<command-name>` / `<local-command-stdout>`), then
the human prompt as the last content part — and a SessionStart hook output as
plain text on the next user message.

Those bytes are the client's prompt and the gateway MUST forward them
untouched. But the console renders four *identification aids* from them — the
session title, the per-turn prompt summary, the route-entry snippet, and the
capture-session preview — each capped at 120–200 characters. Measured defects
came from exactly that: a title that was nothing but a `<timestamp>`, a title
that opened with `<user_info> OS Version: …`, a title that was the raw
`<system-reminder>` attribution boilerplate, and a per-turn summary that quoted
`SessionStart:clear hook success: …` while hiding the question.

The earlier design (three rules, one evidence-backed tag list) handled
STANDALONE envelopes and nothing else. Two gaps remained:

1. **Mixed messages.** A message that carries machinery blocks AND the human
   text has no standalone-envelope signal at all, so rule 3 (blank tag-only
   messages) never fired, and the machinery won the 200-char cap by position.
2. **Plain-text conventions.** Hook output carries no markup whatsoever, so no
   structural rule can see it.

The deeper point: for a third-party harness, "always correct" is unreachable
from bytes alone. The only 100%-accurate signal is the sender declaring which
bytes are human. A regex race against other people's prompt formats is not a
design.

## Decision

Resolve the display form from a LADDER of signals, strongest first. Each layer
is independently sufficient; each weaker layer exists to cover clients that
cannot or did not use the stronger one.

### Layer 0 — Declared prompt (authoritative)

A client that knows which bytes are the human turn states them in
`x-ocr-prompt-hint`. The value is adopted verbatim (whitespace flattened, capped
with an ellipsis) — no inference, no vocabulary, no profile. This is the only
channel that is correct by construction, and it is the answer for a harness
whose shape is unguessable.

The header is display-only and spoofable by anyone who can send it. It is read
ONCE on the display path and its value never reaches routing, prompt hashing,
session anchors, conversation keys or capture bodies; the header itself rides
upstream untouched, exactly as `x-session-id` already does (a model provider
attributes no meaning to an `x-ocr-*` header). A forged header therefore costs
exactly one wrong session title. Precedence at the session level: the FROZEN birth title
wins (a title is a birth attribute and later turns copy it verbatim), then the
declared prompt, then inference.

### Layer 1 — Structural rules (client-agnostic, zero vocabulary)

`displayPromptText` keeps its scan and gains rule 4 beside the existing three:

1. A transport wrapper (`<user_query>`, `<session>`) IS the human content: its
   body is kept bare and the rest of that message is dropped.
2. Known metadata blocks are dropped wherever they sit.
3. A message that is NOTHING but XML-style blocks is a client envelope: blank
   it, whatever its tag names are.
4. **A message that OPENS with top-level blocks and carries its outside text
   only AFTER them is the prepend-machinery shape**: drop the head block-run,
   display the later text alone.

Rule 4 is the load-bearing addition. It names a SHAPE, not a vocabulary — any
future harness that prepends context and appends the prompt is covered on the
day it ships, with no code change. Its guard is symmetrical and structural:
text BEFORE the first block disables it (a human "please analyze: `<data>…`"
keeps everything), a wrapper message still resolves through rule 1 first, and
unterminated markup is unaffected (its verbatim tail is the only post text, so
either branch yields the same string).

### Layer 2 — Harness profiles (scoped vocabulary)

`harness-profiles.ts` maps a User-Agent fingerprint (`claude-cli/` → the Claude
Code profile) to that client's vocabulary: metadata tags dropped wherever they
sit, plus anchored plain-text prefixes that mark a whole message as machinery
(`SessionStart:<matcher> hook (success|error|failure):`).

Scoping is the point, not an optimization. A Cursor user who pastes a literal
`<command-name>` block into a question keeps it in the display, because that
tag is only machinery for the client that emits it as machinery. The tables are
data; the algorithm does not grow with the number of clients.

Profiles are resolved the same way on both planes:

- **Live**: `fastifyRequest.headers ?? clientRequest.headers ?? headers` — the
  same precedence the trace identity already uses, so the native leg, the MITM
  leg and in-process callers all resolve correctly.
- **Archived**: the UA and the declared prompt are read back off the archive's
  own `requestHeaders`, so a replay of a stored session resolves exactly what
  its live turn saw. The read plane never consults the live request.

### Not adopted — Layer 3 repetition suppression

"Same block content repeated across ≥2 requests of one session ⇒ machinery"
would cover per-turn context re-injection (a re-sent `CLAUDE.md`) with zero
vocabulary. It is rejected for now: it needs cross-request state on the display
path, has no cold-start behavior, and no measured defect is left uncovered by
layers 0–2. It stays the documented fallback if such a defect appears.

### Invariants

- Display-only, unchanged: nothing here feeds routing, prompt hashing, session
  anchors, conversation keys, capture or the upstream request.
- One derivation, four surfaces: title, per-turn summary, route snippet and
  capture preview all call the same normalizer and differ only in cap and in
  whether a profile is threaded through.
- Linear scan, not per-tag regex: the normalizer runs on arbitrary client bytes
  on the request path, so a `[\s\S]*?<\/tag>` matcher (quadratic on a document
  full of unclosed tags — measured ~5 s on 300 KB of literal `<a>`) stays out.

## Consequences

- **Rule 4 is a deliberate behavior change.** The previously pinned
  `<foo_state>x</foo_state> 你是谁` → verbatim becomes `你是谁`. Cost: a human
  who pastes markup AHEAD of a question loses the markup in the ≤200-char
  display aid (the bytes on the wire, the archive and the upstream request are
  untouched). That trade is accepted: the intent line identifies the row; the
  markup does not.
- **The measured Claude Code case is fixed at the source of the defect**: the
  `cc_c6a59aae…` opening message now displays `你是谁`, verified by replaying
  the captured wire bytes through the shipped normalizer.
- **A new harness costs data, not code** — as long as it prepends its context
  (rule 4 covers the mix shape). Only plain-text conventions need a profile
  entry, and those are added from measured captures.
- **Existing sessions keep their titles.** `firstUserSummary` is frozen at
  birth and copied verbatim on later turns (so trace-ring eviction cannot
  blank the title); the fix applies to sessions born after it, never
  retroactively. This is the price of a title that cannot evaporate.
- **Vocabulary is scoped, so it cannot regress another client**, and the UA is
  treated as untrusted input: a forged fingerprint changes a title, nothing else.
- **Fixtures are the regression gate.** Each profile and each structural rule
  is pinned with bytes captured from the real client, so a refactor that
  re-quotes machinery fails loudly instead of silently renaming sessions.
