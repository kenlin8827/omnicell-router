# ADR-0040 — Local Run Monitoring: Gateway-Side Counters, Not An Engine Scrape

- Status: Accepted (implemented)
- Date: 2026-12-03
- Amends: ADR-0037 §6 (the run record gains a counters block), ADR-0038 §3 (the `local` provider is the accounting seam)

## Context

The Local Models console can install engines, download GGUFs, plan a launch and
run a model (ADR-0037/0038/0039). What it could not do is **watch** one.

`LocalRunPage` polls `/api/admin/local-models/runs` every two seconds, but only
to drive the launcher: it renders the run of the *selected* model and folds every
other live run into a small "other runs" strip. The run record itself carries
lifecycle facts only — `status`, `ctx`, `ngl`, `pid`, `port`, `restarts`
(`LocalRun` in `backend/src/local/runner.ts`). The operator's actual question
("is this model healthy, who is calling it, how fast is it answering") had no
answer anywhere in the console:

- **No concurrency view.** Several runs can be ready at once (the runner's
  `live` map, one port each), but no page showed them together.
- **No throughput or latency.** Decode speed and TTFT — the two numbers that
  tell you whether a local model is usable — existed only inside the engine's
  own stdout, buried in the run-log drawer.
- **No request accounting.** Nothing counted how many requests a run served or
  how many tokens it produced. The global `FinOpsTracker` aggregates per TIER,
  not per model, and a local model joins no tier (`tier: undefined` by design,
  ADR-0038 §6) — so it contributed to no tier bucket at all.
- **No auxiliary-leg health.** `LocalRun.aux[]` (a vision leg, a helper server)
  was visible only inside the selected model's own panel.

The tempting fix was to scrape the engine: llama.cpp exposes `/metrics`, and a
polling sidecar could read `llamacpp:tokens_predicted_total` and friends. That
was rejected — see §1.

## Decision

### 1. The gateway counts; the engine is never scraped

Every observation on the monitor page comes from data the gateway already sees
on the request path. No `/metrics` poll, no per-engine health dialect, no second
HTTP client pointed at a loopback port that may not be listening.

The reasons are structural, not stylistic:

- **Not every engine has the surface.** The `/metrics` family is a llama.cpp
  fact. Strata (ADR-0039) is a different runtime with a different
  observability story, and a third engine will differ again. Scraping means the
  monitor silently degrades to "unknown" for every engine but one — exactly the
  per-engine branching ADR-0039 spent a whole record removing.
- **The gateway is the only party that sees the request.** Clients are told to
  call the gateway, never the engine's port (ADR-0038 §4: loopback-only, the
  engine is not a second public face). So the gateway's own view is not an
  approximation of the traffic — it IS the traffic. A request the engine served
  but the gateway never saw does not exist for an operator-facing console.
- **Counters must survive an engine restart.** A `runs.json` record outlives its
  process (ADR-0037 boot sweep adopts survivors). Engine-side counters reset on
  every crash-restart; gateway-side counters do not have to.

### 2. The accounting seam is the `local` provider decorator

`LocalDialProvider` (`backend/src/local/local-provider.ts`) already sits on both
execution paths — `createCompletion` and `createStream` — and already resolves
which run answers (`localBaseFor(installedId)`). It is therefore the one place
that knows, in one stack frame, **which run** served a request and **what it
cost**, with no new plumbing through the registry, the orchestrator or the
surfaces.

The decorator reports to a run-stats module (`backend/src/local/run-stats.ts`):

- **On entry** — `beginRequest(runId)`: increments in-flight, records the start
  timestamp.
- **On the buffered path** — the returned `CanonicalResponse.usage` is the
  measurement: `inputTokens`, `outputTokens`, `cachedInputTokens` are the
  billable facts.
- **On the streaming path** — the decorator wraps the returned iterable, so the
  terminal usage event is observed as it passes through. This is the same
  discipline the cache-integrity gate demands ("streaming and buffered legs are
  ONE accounting plane"): a field counted on only one leg is a bug, and Claude
  Code — the heaviest local-model user — only ever streams.
- **On exit, success or failure** — `endRequest(runId, outcome)`: flushes the
  in-flight gauge in a `finally`, and on failure increments the error count.
  A thrown request must never leak an in-flight slot, or the gauge climbs
  forever and the page lies.

A request that never reaches a run (the `local_run_inactive` 503, ADR-0038 §3)
is **not** a served request and never enters these counters: the run is stopped,
so there is no run to attribute it to. That refusal is already observable on the
failures ledger.

### 3. Speed is measured at the gateway, over a declared window

Two rates, both derived from gateway timestamps rather than an engine's
self-report:

| Metric | Basis | Why this window |
| --- | --- | --- |
| TTFT (ms) | request start → first streamed `response.output_text.delta` (or the response's completion time on a buffered leg) | The operator's perceived wait. A buffered leg has no first-chunk instant, so its TTFT is "the whole thing" and is flagged as such — never silently omitted. |
| Decode (tok/s) | output tokens ÷ (first-delta → stream end) | The same boundary `decodeRate()` in `frontend/src/lib/format.ts` already uses for the capture chips, so a local model's number is comparable to a cloud model's on the same page family. |

Both are kept as a rolling aggregate plus a most-recent sample: an average over
the run's lifetime answers "is this model slow in general", the latest sample
answers "is it slow *right now*". A single number cannot answer both, and
conflating them is how a 2-hour-old good average hides a just-started thrash.

The aggregate carries its own sample count so a page can say "3 samples" instead
of presenting a 1-request average as a trend.

### 4. The monitor reads one endpoint; run records grow a counters block

`GET /api/admin/local-models/monitor` returns, per known run, the registry's
`LocalRun` merged with its counters block, plus a machine summary (in-flight
total, live run count, and the gateway's own port so the page can say where
clients should point).

Counters live **beside** the run record, not inside its persisted JSON:

- `runs.json` is lifecycle state — what the boot sweep adopts and what a stop
  kills by pid. Gauge/rate data is derived and process-local; persisting it
  would make a stale 4-hour-old TPS look like a live reading after a gateway
  restart, which is worse than showing nothing.
- Counters are keyed by run id and pruned together with the run
  (`pruneLocalRuns`, the existing history-hygiene route).

The response is additive and version-tolerant, the console convention every
status endpoint here follows: an older gateway omits the route and the page
shows the Launcher's own polling as its fallback.

### 5. No GPU sampler in this record

VRAM utilisation, SM occupancy and power draw were explicitly out of scope when
this was scoped. They are not a gateway observation — they need a periodic
external sampler (`nvidia-smi` / `rocm-smi`), a vendor split, and a decision
about what to show on machines with no discrete GPU. `detect.ts` already reads
`nvidia-smi` for total/free VRAM at *plan* time; a live time series is a
separate record and is deliberately not smuggled in here.

## Consequences

- The Local group gains a sixth page, `/local-monitor` (nav label **Run Monitor**),
  placed AFTER the run/registry/settings pages: it answers "what is happening",
  while `/local-run` stays the answer to "start this". It sits last because it
  observes whatever the rows above it configured and launched — an end-of-
  workflow readout, not a step inside it. The label names RUNS deliberately: the
  page monitors live runs and their request counters, not the machine (no
  GPU/VRAM sampling, §5).
- A request's accounting happens inside the provider decorator, so it is
  reachable only for models the gateway serves — which is every local call by
  construction (ADR-0038 §4).
- The counters are process-local. A gateway restart zeroes them while the run
  keeps serving (adopted runs). The page states the window rather than
  pretending the numbers are lifetime figures.
- Adding a fourth engine requires no change here: the counters hang off the
  `local` provider, not off any engine's surface.

## Rejected alternatives

- **Scrape `/metrics`** — §1; degrades to one engine and reports "unknown" for
  the rest while claiming to be a monitor.
- **Extend `FinOpsTracker` with a per-model dimension** — it is a tier-keyed
  cost tracker whose whole shape assumes billed dollars; a local model is
  `pricing: 0` and tier-less. A per-model dimension there would be a second
  axis bolted onto a tier table, and it would still miss in-flight/aux facts.
- **Persist counters in `runs.json`** — §4; stale-after-restart readings.
- **Render the monitor from the launcher's existing poll** — the launcher asks
  for one model's launch state; a board needs every run plus aggregates, and
  doubling the poll's payload to serve both would couple two different pages'
  costs.