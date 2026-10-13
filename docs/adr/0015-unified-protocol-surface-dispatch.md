# ADR-0015: Unified Protocol-Surface Dispatch Across Both Inference Transports

## Status

Proposed — 2026-10-12. Layer: system. Scope: global. Domain: routing.
Amends the surface-location and MITM-leg scope of ADR-0014; its §4 capture exclusion remains binding (see Decision Outcome).
**Amended 2026-10-13** — adds the optional on-disk recovery log for the shared RespStore (see Decision Outcome §RespStore recovery log). Default OFF: the in-memory-only posture of step 3b remains the shipped default; the amendment only adds a config-gated durability option.

## Context and Problem Statement

Every inference request enters the gateway through one of two transports:

- the native Fastify `/v1/*` routes (API-key clients), and
- the MITM forward proxy (clients dialing upstream hosts directly).

Each transport carried its own full copy of the per-request choreography: validation, header emission, capture wiring, error envelopes, model-access policy. Only the orchestrator core and the pure protocol converters were shared. The duplication demonstrably drifted:

- X-OCR sets drifted apart: 15 headers (chat route), 6 (responses), 5 (MITM legs).
- MITM capture logged empty request lines and headers.
- MITM capture missed the response and 499 events entirely.
- `auto-*` on the chat leg double-wrote `force_tier` (server.ts + orchestrator).
- Error envelopes, SSE header sets and abort semantics differed per handler.

Adding a wire meant auditing four hand-written handlers, and every fix had to be applied twice.

## Decision Drivers

- One implementation of per-request choreography, shared by every transport.
- Drift must be impossible by type and structure, not by review discipline.
- Behavior preservation must be gateable:
  - byte-identity harnesses + red/green capture tests,
  - pinned per runtime (Bun + Node), not assumed uniform.
- Auth posture changes must be explicit in the types, never accidental.

## Considered Options

### A. Pure-function surfaces + two shared pipelines + two transport adapters

**Pros**

- Choreography single-homed; both transports call the same pipelines.
- Per-surface policies (capture, gate) encoded as literal types.
- A new wire is one table row; both transports inherit it.

**Cons**

- Capture finalize discipline lives in the two adapter files.
- Upfront seam-design cost; migration needed stepwise gates.

### B. Per-surface monolithic handler closures shared by both transports

**Pros**

- Each route migrates independently; small, local diffs.

**Cons**

- Re-implements the choreography once per surface (x4).
- Drift becomes inevitable again — the disease being cured.

### C. MITM internally fetches Fastify loopback endpoints

**Pros**

- One HTTP stack; the choreography is physically impossible to duplicate.

**Cons**

- Double network hop inside the gateway; added latency.
- Loses the original dialed `Host` — bare-name host-pinning breaks.
- Client-abort / 499 semantics distorted by the internal hop.

### D. Transport-profile parameter freezing MITM's old 5-header set

**Pros**

- Zero wire change; smallest possible migration.

**Cons**

- Institutionalizes the drift inside the shared code. Rejected.

## Decision Outcome

Chosen option: "A. Pure-function surfaces + two shared pipelines + two transport adapters", because it is the only option that makes the observed drift structurally impossible while keeping behavior preservation gateable by tests.

The decision ships as `backend/src/surfaces/`:

- `table.ts` — the `SURFACES` registry (chat / anthropic / responses / systemone).
  - `server.ts` registers every protocol route by looping the table.
- `detectSurface()` — one suffix table for MITM path detection AND route identity.
  - The two can no longer disagree about which wires exist.
- `types.ts` — `TransportContext`, terminal-send discipline: exactly one send.
  - One `sendJson`, or one `beginSse` → `writeSseChunk`* → `endSse`.
- Capture finalize is folded INTO the terminal sends themselves.
  - A response that exists has been captured — no separate step to forget.
- `ModelAccessGate` — union: `'key'` (Fastify per-key guard) | `'exempt'` (MITM).
  - The POLICY EXEMPTION is type-enforced: never silently dropped, never applied.
- `chat-pipeline.ts` — frozen order for every chat-shaped wire:
  - parse → 400 → gate → process → builder headers → afterResult → encode/send.
- `decision-pipeline.ts` — serves systemone on the same transport seam,
  - but calls the registry executor directly (`protocols/systemone/decide.ts`);
  - structurally capture-free.
- `transport-fastify.ts` / `transport-node-http.ts` — the two adapters.
  - They own response writes, X-OCR staging, capture finalize, abort checks.
- Fastify capture hooks (`onRequest`/`onResponse`/`onSend`) deleted from `server.ts`.
  - Finalization is adapter-owned.

### Amendment to ADR-0014 (ADR-0014 itself untouched)

- `POST /v1/systemone` is now ALSO served on the MITM leg.
  - `detectSuffix: '/systemone'` is deliberately wider than `routePath`.
  - Matches the native-upstream URL shapes of ADR-0014 §2.
- The capture exclusion of ADR-0014 §4 REMAINS binding — enforced structurally:
  - literal `capture: false` on the `DecisionSurface` type;
  - zero `captureProcessContext()` calls in the decision pipeline;
  - wire-level invariant test: `backend/tests/forward-proxy-systemone.test.ts`
    ("systemone capture exemption") — zero client events, both legs, capture ON.
  - ADR-0016 later supersedes this exclusion limb: `DecisionSurface.capture`
    widens to the literal `'configurable'`, resolved by `capture.systemoneEnabled`
    (default `false` — the zero-events behavior above stays the default).
  - ADR-0016 FINAL TREE (same-day rewrite): `capture:` is renamed
    `requestCapture:` — the surface now resolves on
    `requestCapture.enabled && requestCapture.systemone.enabled`
    (surface master; the intermediate `clientEnabled` never shipped);
    the key names in the note above are retired (see ADR-0016).
- The route moved: `backend/src/routes/systemone.ts` no longer exists.
  - The surface lives at `backend/src/surfaces/systemone.ts`.

### Consequences

**Positive**

- Drift is structurally impossible: one choreography, builder and capture path.
- A new protocol wire = one `SURFACES` row; both transports inherit it for free.
- MITM legs gain the full X-OCR diagnostics and capture parity with the native leg.
- Approved header growth, disclosed as deltas Δ-1/2/3 (append-only, responses):
  - chat SSE responses gained the three conditional Thinking headers.
  - the responses route went 6 → 15 headers on both send shapes.
  - MITM legs went 5 → the full builder set.
- Approved behavior convergences C-1..C-6:
  - MITM execution errors map per surface (bad `#variant` now 404, not 500).
  - MITM `/v1/responses` gained `previous_response_id` via the shared RespStore.
  - `stream === true` strict everywhere; truthy non-booleans take the JSON path.
  - capture bodies no longer pre-inject `force_tier` on the chat Fastify leg.
  - MITM SSE writes per-event; the total stream bytes stay byte-identical.
- Security and observability side effects folded into the seam:
  - host-pinning reads `clientRequest` headers on the MITM leg only.
  - a forged `Host` on the native leg can no longer steer provider selection.
  - `traceparent` is honored on both legs (transport headers feed the orchestrator).

**Negative / Risks**

- Capture finalize semantics now live in two adapter files.
  - The frozen contract document records their discipline; invariant tests guard.
- The shared RespStore is visible across legs (sessions can continue leg-to-leg).
  - Mitigation: bounded FIFO (20k nodes + age sweep); unguessable 96-bit ids.
  - Cross-leg reach is a capability, not an exposure.
  - Because BOTH legs share the singleton, the optional recovery log
    (amendment below) mirrors intercepted MITM-leg chains to disk too —
    one more reason its default is OFF and enabling it is a conscious
    disk-privacy choice, same content class as `requestCapture`.
- The broad `/systemone` suffix intercepts any local POST ending `/systemone`.
  - Tolerated under the loopback-trust model documented in the proxy code.
  - Failures return a loud gateway envelope, never silence.
- Bun cannot observe a client abort once the request body is fully read.
  - 499 synthesis relies on req `'aborted'` events under Node + destroyed sockets.
  - `backend/tests/capture-abort.test.ts` pins the per-runtime truth.
- The capture flip (step 3c) concentrated risk in one change.
  - Mitigation: red/green capture + abort tests written against the OLD code first.

---

## Amendment (2026-10-13): Optional RespStore Recovery Log

**Problem the amendment answers.** The in-memory-only store makes every gateway
restart amnesiac: mid-conversation `previous_response_id` turns hit the
fail-visible 400, and clients without full-resend logic lose the conversation.
For long agent sessions that outlive config edits and upgrades, the degradation
path was not good enough.

**Decision.** The store may mirror its node tree to an append-only JSONL
recovery log (`responses.persist`, **default false**). Semantics:

- L1 (the Map) stays the sole authority; the log is a restart-survival
  optimization. Appends queue best-effort at `afterResult`; a disk failure
  warns at most once and NEVER fails or slows the request path.
- Boot replays the log synchronously before the first parse can resolve an
  id: TTL filter (same 24h), skip-and-warn on malformed/torn lines, insert in
  `createdAt` order (FIFO eviction keys on insertion order — out-of-order
  replay would evict live conversations), ONE sweep after the bulk load
  (per-append sweeps at the 20k cap would be O(n²)).
- Compaction is an atomic rewrite from live L1 state (temp + rename): TTL
  drops, per-node cap (256 KiB default — oversized turns stay in L1 only),
  total byte budget (64 MiB default, oldest-first trim). Cadence: boot + every
  1000 appends. `clear()` purges the log so deleted conversations never
  resurrect.
- The file lives under the environment's own data dir (ADR-0017 book-set
  isolation — a cross-env log would replay the wrong book-set's chains),
  mode 0600.

**Default-off posture.** The log carries raw conversation text — the same
content class as `requestCapture` (ADR-0016), so the repo's disk-privacy
opt-in applies verbatim. Off, the step-3b in-memory behavior is byte-for-byte
unchanged. The switch self-advertises: the first request bearing
`previous_response_id` under persist=off emits one warn per process naming
`responses.persist`; under persist=on, boot logs the replay counts.

**Ceilings (deliberate, not oversights).**

- SessionManager (ratchet tier, pinned model, account affinity) stays
  in-memory. Post-restart continuation is functionally intact but routes
  cold. Per ADR-0019 D7 an account change on a stateful thread is a hard
  functional break — the recovery log does NOT prevent that on restart; it
  only removes the message-chain loss. Persisting the session layer was
  considered and deferred: no measured evidence the cold-route re-bill
  outweighs its consistency cost. Upgrade path if evidence appears: a tiny
  per-session `{account, tier, model}` sidecar, not full session persistence.
- The last unflushed turn (crash between response and disk) still falls into
  the 400 path. Fail-visible contract and its frozen text are unchanged.
