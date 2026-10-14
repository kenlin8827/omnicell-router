# Circuit-Breaker Rules — Full Configurable / Visual Coverage (spec v3.1)

Status: implemented — v3.1 (2026-10-14, post-v3): rules moved to the dedicated `/breaker-rules` page
(user decision); QA findings F1 (SUSPECT suppression) and F2 (short-batch reading) adjudicated into
the rule semantics below; hard-trip duration resolution and the `minCooldownMs` rename settled per
shipped behavior. Governing records: ADR-0008 (§Amendment (2026-10-14, rules)) and ADR-0019
(Decision 6). Implementation owner: `@build`.

## Goal

Make every **automatic** trip rule individually enable-able **with its own parameters**, all fully
visual-configurable on the dedicated `/breaker-rules` page — manual trips are not rules and stay
operator-only on `/guardrails` (which keeps live observation plus the manual trip/reset cards and
links into the rules page). With the
**five `trip.*` switches all off, no automatic tripping happens at all** (precise predicate in
Rule semantics) — manual trip/reset remains available. All new
rule toggles default to the current behavior (enabled), so an unchanged `config.yaml` behaves
byte-for-byte as today.

## New config shape (`circuitBreaker.rules`)

Two behavior families, one vocabulary — written in the reader's causal order: **what counts → when
to trip → how it recovers**. `rules.counting.*` decide **what is even recorded as a failure** (each
with `enabled` + the cooldown its failures suggest to the trip rules). `rules.trip.*` are **trip
conditions** — objects with `enabled`, the rule's own parameters, and an advanced `scope` override —
and they only ever see the counted classes. `rules.recovery.*` is the half-open/full-open policy.
Every optional parameter falls back to the existing global knob; the global knobs stay and are
surfaced as the shared defaults (v3.1 resolution: the rules page shows their live values
**read-only** in a "shared defaults" disclosure — editing them stays YAML-only,
`activeProbing.intervalMs` excepted, which the page edits directly). Legacy configs without `rules`
behave byte-for-byte as today.

```yaml
circuitBreaker:
  rules:
    counting:                    # 1 — what is even recorded as a failure
      serverErrors:
        enabled: true            # SERVICE_UNAVAILABLE (5xx / network jitter) feeds the trip rules
        minCooldownMs:           # a trip caused by this class is never shorter than this
                                 # default: initialCooldownMs (30s)
      unknownErrors:
        enabled: true            # unclassified upstream errors
        minCooldownMs:           # default: initialCooldownMs (30s)
      rateLimitErrors:           # countedness of 429 has NO toggle — today the classifier counts
                                 # every 429 (shouldTripBreaker: true unconditional,
                                 # error-classifier.ts:257). This key owns only its floor:
        minCooldownMs:           # floor when Retry-After is absent — default: HARD-CODED
                                 # min(60s, initialCooldownMs) (error-classifier.ts:233);
                                 # a long-Retry-After 429 keeps its RA-derived floor instead
      clientErrors:
        enabled: false           # 400/422 (default OFF = today's non-penalizing CLIENT_ERROR)
                                 # no cooldown param: when counted, the trip rules' own ladder applies
    trip:                        # 2 — when a counted failure opens the circuit
      quota:
        enabled: true            # 402 / quota wording -> immediate OPEN
        cooldownMs:              # default: quotaCooldownMs (12h)
        scope: auto              # auto | pair | account | model (ADR-0019 Decision 6)
      auth:
        enabled: true            # 401 -> immediate OPEN
        cooldownMs:              # default: quotaCooldownMs (12h)
        markSuspect: true        # flag the account SUSPECT on trip
        scope: auto
      rateLimit:
        enabled: true            # 429 with Retry-After above hardTripAboveMs -> hard trip
        hardTripAboveMs:         # at-or-below = feeds the counting layer instead
                                 # default: retry.inplace.maxRateLimitWaitMs (2000)
        minCooldownMs:           # floor of the hard trip's Retry-After-derived cooldown —
                                 # today HARD-CODED 1000 (error-classifier.ts:232)
        scope: auto
      consecutiveFailures:
        enabled: true
        threshold:               # default: failureThreshold (3)
        initialCooldownMs:       # default: initialCooldownMs (30s)
        cooldownMultiplier:      # default: cooldownMultiplier (2.0)
        maxCooldownMs:           # default: maxCooldownMs (5h)
        scope: auto
      failureRate:
        enabled: true
        windowSize:              # default: slidingWindowSize (20) — sizes the shared outcome ring buffer
        failureRate:             # default: failureRateThreshold (0.5, ratio 0..1)
        minCalls:                # NEW (R4J minimumNumberOfCalls / Envoy *_request_volume):
                                 # rate is only evaluated with >= this many recorded calls.
                                 # default: windowSize (today's implicit "full window" behavior)
        cooldownMs:              # default: initialCooldownMs (30s)
        scope: auto
    recovery:                    # 3 — how a tripped model comes back
      onCanaryFailure: backoff   # backoff | initial | close (see Rule semantics #9/#10)
      cooldownMultiplier:        # ladder factor for `backoff` — same-named global knob (2.0)
      halfOpen:
        maxProbes:               # HALF_OPEN trial budget — default: halfOpenMaxProbes (1);
                                 # clamp >= 1; also the active-prober's per-cycle budget
        successThreshold:        # successful probes required to go fully open (CLOSED) — default: 1
                                 # (= today's canary-closes-on-first-success); must be <= maxProbes
        maxWaitMs:               # NEW (R4J maxWaitDurationInHalfOpenState): cap on how long a
                                 # breaker may linger in HALF_OPEN (e.g. no traffic to spend a
                                 # probe); expiry resolves via onCanaryFailure.
                                 # default: 0 = wait forever (today's behavior)
  shadow: false                  # NEW (R4J METRICS_ONLY): rules are evaluated and trips recorded
                                 # (visible in /guardrails, snapshotted, events emitted), but
                                 # canExecute/peek NEVER block traffic — manual trips still
                                 # enforce. Answers "are my rules right?" before going live.
  persistence:
    debounceMs: 1000             # breaker-state file flush debounce — today the constant
                                 # DEFAULT_BREAKER_PERSIST_DEBOUNCE_MS (breaker-state.ts:44)
```

Naming conventions (top-level engineering standard for this surface): durations carry the `Ms`
suffix (matches existing `initialCooldownMs`); ratios are bare decimals (`failureRate`); enums are
snake_case (repo precedent: `tierCrossPolicy: same_tier_only | allow_escalate`); booleans are
adjective/phrasal state names; rule keys reuse the global knob's name for the same quantity
(`threshold`, `initialCooldownMs`, `cooldownMultiplier`, `maxCooldownMs`) so there is exactly one
word per concept across the whole config tree. **Cooldown floors are always
`minCooldownMs`** — "suggested" described the internal pipeline hand-off (classifier proposes,
breaker takes `max(suggested, computed)`), not the operator's intent, and is banned from config
vocabulary; the internal carrier is renamed to match (see Internal vocabulary refactor).

Global knobs remain: `failureThreshold`, `slidingWindowSize`, `failureRateThreshold`,
`initialCooldownMs`, `maxCooldownMs`, `cooldownMultiplier`, `quotaCooldownMs`,
`halfOpenMaxProbes`, `activeProbing.*`, `accountAffinity.cacheTtlMs`, `enabled` — they serve as the
fallbacks for the per-rule parameters above and are displayed (read-only, live value + config key on
hover) in the rules page's "shared defaults" disclosure; editing them stays YAML-only, except
`activeProbing.intervalMs`, which the page edits as a first-class field.

### Threshold inventory (complete sweep of numeric constants in `backend/src/resilience/`)

| Constant (verified location) | Value today | Coverage |
|---|---|---|
| `failureThreshold` | 3 | `trip.consecutiveFailures.threshold` |
| `slidingWindowSize` | 20 | `trip.failureRate.windowSize` |
| `failureRateThreshold` | 0.5 | `trip.failureRate.failureRate` |
| `initialCooldownMs` / `maxCooldownMs` / `cooldownMultiplier` | 30s / 5h / 2.0 | global + `trip.consecutiveFailures.*` + `recovery.cooldownMultiplier` |
| `quotaCooldownMs` | 12h | `trip.quota.cooldownMs`, `trip.auth.cooldownMs` |
| 429 hard-cooldown floor (error-classifier.ts:232) | 1000ms hardcoded | **NEW** `trip.rateLimit.minCooldownMs` |
| 429 counted-class floor (error-classifier.ts:233) | min(60s, initial) hardcoded | **NEW** `counting.rateLimitErrors.minCooldownMs` |
| hard/counted boundary (borrowed from `retry.inplace.maxRateLimitWaitMs`) | 2000ms | `trip.rateLimit.hardTripAboveMs` |
| persist debounce (breaker-state.ts:44) | 1000ms hardcoded | **NEW** `persistence.debounceMs` |
| `halfOpenMaxProbes` (also the prober's per-cycle budget) | 1 | `recovery.halfOpen.maxProbes`, clamp ≥1 |
| HALF_OPEN close-after-successes (circuit-breaker.ts:190-210) | always 1 — hardcoded | **NEW** `recovery.halfOpen.successThreshold`, default 1, ≤ `maxProbes` |
| `activeProbing.intervalMs` | 60s | global knob, UI-editable |
| `accountAffinity.cacheTtlMs` | 300s | global knob, UI-editable |
| manual trip default/max/floor (circuit-breaker-manager.ts:25-26,621) | 1h / 7d / 1s | **deliberately hardcoded** — manual is the user-excluded domain; REST already takes per-call `cooldownMs` via `ManualTripOptions` |
| in-place retry `backoffMs`/`jitterMs`/`maxAttempts` | 200/100/1 | retry family (`retry.inplace.*`), already configurable elsewhere — not breaker scope |
| 429 cooldown clamp ceiling | global `maxCooldownMs` | stays global (a cap on any derived cooldown, not a per-rule knob) |

Not parameterized (deliberate boundary): the error-wording pattern lists in `error-classifier.ts`
(quota markers, ACCOUNT_LIMIT_MARKERS, network patterns) are category *definitions*, not rule
parameters — they stay in code.

## State machine — which rule drives which edge

Every automatic transition edge has exactly one owner in `rules.*`. Cooldown is **not** a separate
"enter half-open rule": it is an output of the trip rule that opened the breaker; the edge
OPEN→HALF_OPEN fires when that cooldown expires (checked on the next gate call, or driven by the
prober when no traffic arrives).

```
                     trip.* rules          cooldown expires              successThreshold successes
              ┌─────────────────►┌──────┐───────────────────►┌───────────┐─────────────────────►┐
              │  (counting.*     │ OPEN │                   │ HALF_OPEN │                      │ CLOSED
   traffic ───┤   gates inputs)  └──────┘◄──────────────────└────────────┘                      └──────┐
              │                                        onCanaryFailure                                 │
              └───────────────────────────────────────── (backoff | initial) ──────────────────────────┤
                 onCanaryFailure = close  ⇒ HALF_OPEN goes straight to CLOSED ─────────────────────────┘
```

| Edge | Plain term | Firing owner | Its configurable parameters | Manual / out-of-band equivalents |
|---|---|---|---|---|
| CLOSED → OPEN | **trip (open)** | `trip.quota` / `trip.auth` / `trip.rateLimit` (hard) and `trip.consecutiveFailures` / `trip.failureRate` (statistical) — each only if the error's `counting.*` class is enabled | the five rules' params + `scope` override | console/REST manual trip (user-excluded domain) |
| OPEN → HALF_OPEN | **enter half-open** | expiry of the cooldown set by the tripping rule | cooldown length rides the tripping rule (`cooldownMs`, `minCooldownMs`, ladder, etc.); no-traffic path = `activeProbing.enabled` + `intervalMs` | manual reset → straight to CLOSED |
| HALF_OPEN → CLOSED | **full recovery** | cumulative successful probes reach `recovery.halfOpen.successThreshold` (window + ladder re-armed empty, as today) | `recovery.halfOpen.maxProbes` (trial budget, = prober per-model budget), `successThreshold` | — |
| HALF_OPEN → OPEN | **half-open re-trip** | a probe failure, or trial budget exhausted below `successThreshold` | `recovery.onCanaryFailure` (`backoff`/`initial`; `close` diverts this edge to CLOSED — except on MANUAL breakers, which always re-OPEN) | — |

Never touched by these edges: **SUSPECT accounts** — an account flagged by `trip.auth`
(`markSuspect`) leaves the pool independently of breaker state and returns only via explicit
operator clear + re-probe (ADR-0019 Decision 6); `counting`/`trip` toggles neither set nor clear
existing flags (invariant 2).

With `circuitBreaker.shadow = true` all four edges above are still evaluated, recorded and
displayed (snapshots, events, `/guardrails` states), but `canExecute`/`peekExecute` only flip the
verdict — **accounting stays complete**: HALF_OPEN probe slots are still consumed, ladders still
advance, the window still fills, so the observer timeline matches an enforcing one.
`ActiveHealthProber` keeps running for the same fidelity reason. Exempt from shadow (operator
intent, not rules): manual OPEN trips, the DISABLED operator takedown (first check in
`isPairOut`), and SUSPECT gating. Known and accepted observation skew: tripped models keep serving
full traffic, so statistical re-trips can extend ladder history versus enforcement mode —
footnoted in the UI.

## Configuration UX contract — a disposition table, not a state machine

Judged by one test: **a first-time operator configures correct behavior without ever reading this
spec**. The layout mirrors how the industry models breaking (Resilience4j: per-exception
record/ignore disposition + one detector set; Envoy: independent detectors, each with its own
on/off), NOT our internal state machine — the machine belongs in docs, not in the form.
"Sentences with inline inputs" (an earlier draft) was rejected as structurally weak: cross-block
causality hidden by prose, and fragile bilingual templates.

**Page placement (v3.1, user decision 2026-10-14).** This form is a page of its own: `/breaker-rules`
(`frontend/src/pages/BreakerRulesPage.tsx`, nav group "Safety"). `/guardrails` keeps what it always
was — the observation matrix (live snapshots, cooldowns, reason codes) and the manual trip/reset
cards — with a single entry link to the rules page; it no longer hosts rule editing. The split is
cosmetic for the contract: the block A/B/C layout, the `auto | custom` inputs and the summary card
below are unchanged, they just render one route over.

Three blocks, fixed reading order **A when an error like this happens -> B when counted
failures trip -> C how a tripped model comes back**. The wireframe is canonical EN (the zh-CN
rendering lives in `locales/zh-CN.ts` — translated copy never in docs or code):

```
+----------------------------- Breaker rules ------------------------------+
| A. When upstream fails this way                      shadow mode [off]    |
|   error class          disposition             that disposition's params   |
|   402 quota exhausted  [trip now          v]   duration [auto: 12h]  blast [auto v] |
|   401 auth failed      [trip now          v]   duration [auto: 12h] [x]mark SUSPECT blast [auto v] |
|   429 rate limited     [trip above        v]   above [auto: 2s] trip floor [auto: 1s] |
|                          threshold             counted floor [auto: 60s] blast [auto v] |
|   5xx / network jitter [count it          v]   min trip duration [auto: 30s] |
|   unclassified errors  [count it          v]   min trip duration [auto: 30s] |
|   400 client errors    [ignore           v]   --  (params appear on "count it") |
|                                                                          |
| B. When "counted" failures trip                                          |
|   [x] consecutive failures >= [auto: 3] -> start [auto: 30s] x[auto: 2.0] cap [auto: 5h] |
|       blast [auto v]                                                     |
|   [x] last [auto: 20] calls, samples >= [auto], failure rate >= [auto: 50%] |
|       -> trip [auto: 30s]   blast [auto v]                               |
|                                                                          |
| C. How a tripped model comes back                                        |
|   cooldown expires -> half-open; allow [auto: 1] probes, [auto: 1] successes -> close (reset) |
|   probe fails / batch short / half-open lingers > [auto: never] -> [backoff re-trip v] |
|       ("optimistic close" does not apply to manual trips)                 |
|   active probing [off]   interval [auto: 60s]                             |
|                                                                          |
| > shared defaults (each auto's live value + knob name)   ! restart required |
|                                        [discard]   [save]                 |
+---------------------------------------------------------------------------+
```

Binding rules:

1. **A is a real table** — fixed columns, aligned dropdowns; the operator scans a column of
   dispositions, exactly like Envoy's detector list or R4J's exception lists. The Disposition
   column is the row's subject; the parameter column shows only what the chosen disposition consumes. Dropdown
   options are limited per error type to valid combinations (no cross-capability states).
2. **Display <-> yaml mapping — explicit per-row option sets** (there is no universal tri-state):
   - 402 / 401 rows: {trip now, ignore}; ignore = `trip.quota/auth.enabled: false`, which is also
     non-counting (semantics #1/#2).
   - 429 row: {trip above threshold, count only} — **no "ignore"** (classifier counts every 429
     unconditionally; deliberate deviation from R4J `ignoreExceptions`, recorded in Prior-art;
     silencing 429 fully is achieved by turning BOTH B detectors off, per the zero-rule predicate).
   - 5xx / unknown rows: {count it, ignore} = `counting.*.enabled`.
   - 400 row: {ignore, count it} = `counting.clientErrors.enabled`.
   B rows = `trip.consecutiveFailures` / `trip.failureRate`. C = `recovery.*` + `activeProbing`.
   Shadow switch = `circuitBreaker.shadow`.
3. **Every numeric input is an `auto | custom` toggle**: `auto` renders as gray text showing the
   live inherited value (knob name in tooltip); only `custom` opens an input. Kills the repeated
   "inherit:" placeholders while keeping one fallback story per field.
4. Unavailable parameter cells render "--" (disabled), never an empty box.
5. `scope` Comboboxes show human blast radius: auto (by error type) / this model + this key only /
   this account's every model / this model's every key. Manual trip/reset UI stays as-is (operator
   cards, not rules).
   Every dropdown here — disposition and scope alike — uses `components/Combobox.tsx`, never a
   native `<select>` (AGENTS.md).
6. Top summary card phrase instead of fractions: **automatic tripping: on / partly off / all off (!) / shadow**.
   Saving a zero-effective-ruleset (the five-switch predicate from Rule semantics) requires a
   confirm dialog naming the consequence ("broken accounts keep receiving traffic").
7. en-US uses the same table structure (column headers + short labels, not prose templates); all
   strings via `t()`; raw yaml keys appear only in tooltips.
8. **Collapsible blocks.** A/B/C each render as a native `<details>` disclosure, **expanded by
   default** (collapsing is opt-in — a first-time operator still sees the fixed reading order).
   Each summary row carries a live state badge — block A: non-ignored classes n/6, block B:
   detectors on n/2, block C: the `onCanaryFailure` mode. Save/discard stays outside the
   disclosures.

## Rule semantics

(Grouped by edge: rows 1-8 = the CLOSED→OPEN edge incl. its input filter; rows 9-10 = the two
HALF_OPEN exits. Row numbers referenced in the UI are these.)

| # | Rule | OFF / option semantics |
|---|------|------------------------|
| 1 | `trip.quota` | 402 neither trips nor counts toward statistics. **Closing the toggle must `reset()` existing breakers whose `reasonCode` is `breaker.quota`** (see Hard invariant 2). `cooldownMs` overrides the 12h block length. |
| 2 | `trip.auth` | 401 neither trips nor counts. **OFF also suppresses NEW SUSPECT flags (no trip ⇒ no flag); existing flags unchanged** — the flag rides the trip, so an "ignore" row must mark nothing (QA finding F1; shipped gate `accountSuspect && trip.auth.enabled && trip.auth.markSuspect`, evaluated where the failure expands to account scope). `markSuspect: false` keeps the trip but stops SUSPECT flags going forward: existing flags in `suspect-accounts.json` (cross-env store) keep gating selection until manually cleared — the UI warning must say so. Invariant across the whole tree: a toggle neither sets nor clears an existing flag. |
| 3 | `trip.rateLimit` | OFF = 429 is **downgraded to a counted statistical failure**, NOT "ignored". Different wording from rules 1/2 in both locales. `hardTripAboveMs` moves the hard/counted boundary (today inherited from `retry.inplace.maxRateLimitWaitMs` — the breaker-side copy must not rewrite the retry-side in-place-retry decision; document the divergence if overridden). `minCooldownMs` un-hardcodes today's 1000ms floor of the Retry-After-derived cooldown (clamped above by global `maxCooldownMs`). When the rule is OFF and a long-Retry-After 429 is downgraded, the RA-derived value STILL flows through as the counted floor via `max(min, computed)` — today's shape, verified; `counting.rateLimitErrors.minCooldownMs` governs only the no-Retry-After case. |
| 4 | `trip.consecutiveFailures` | OFF = consecutive threshold never checked. `threshold` + the cooldown ladder (`initialCooldownMs` / `cooldownMultiplier` / `maxCooldownMs`) ride this row. |
| 5 | `trip.failureRate` | OFF = sliding-window rate never checked. `windowSize` + `failureRate` + trip `cooldownMs` ride this row. `minCalls` (R4J `minimumNumberOfCalls`) separates "how much history is kept" from "how much is required before judging" — default = `windowSize` keeps today's full-window-only behavior; lower it to trip faster on sparse traffic. |
| 6 | `counting.serverErrors` | OFF = SERVICE_UNAVAILABLE errors are never recorded (no direct trip path exists today; they feed rules 4/5). `minCooldownMs` overrides the cooldown floor rules 4/5 take via `max(min, computed)` — allowed; it is not one of the protected fields in invariant 3. |
| 7 | `counting.unknownErrors` | OFF = UNKNOWN errors are never recorded. `minCooldownMs` as above. |
| 8 | `counting.clientErrors` | ON = 400/422 count as failures — UI marks this red / "not recommended". Default OFF matches today's non-penalizing CLIENT_ERROR. No cooldown param: the tripping rule's own ladder applies. |
| 9 | `recovery.onCanaryFailure` | Tri-state dropdown, no boolean (keeps HALF_OPEN exits intact): `backoff` (today: cooldown x2, `cooldownMultiplier`-overridable), `initial` (re-OPEN at the initial ladder), `close` (go CLOSED but **retain `consecutiveFailures` and `currentCooldownMs`** so the very next failure re-trips with the escalated ladder). Also fires when a `halfOpen.successThreshold > 1` trial batch ends short (see #10). **MANUAL-category breakers ignore `close` and always re-OPEN** — never defeat an operator takedown. |
| 10 | `recovery.halfOpen` | The half-open trial becomes a configurable batch instead of a hardcoded single canary: up to `maxProbes` concurrent probes; the breaker goes fully open (CLOSED, ladder + window reset as today) only after `successThreshold` successes. A probe failure resolves immediately via `onCanaryFailure`; a batch that exhausts `maxProbes` with fewer than `successThreshold` successes also resolves via `onCanaryFailure`. **Confirmed reading (QA finding F2, shipped):** "exhausts" = all `maxProbes` slots consumed with successes below `successThreshold`, judged on the next gate poll — in-flight probes are preempted by that verdict and the re-OPEN counts **no new failure** (nothing failed; the trial simply cannot reach the bar, `breaker.canary`). The check is gated on `successThreshold > 1`, so the default 1/1 batch never fires it and a stuck single canary lingers exactly as before. Non-penalty outcomes (rule semantics for disabled classes / CLIENT_ERROR) release their slot (today's invariant, circuit-breaker.ts:219-227). Persistence: `BreakerRecord` gains `halfOpenSuccesses` AND `halfOpenEnteredAt` — no half-open entry timestamp exists today (verified); the OPEN→HALF_OPEN transition (circuit-breaker.ts:449-457) must set it and clear `halfOpenSuccesses` to 0; `maxWaitMs` expiry resolves via `onCanaryFailure`. Restore refreshes both counters exactly like today's HALF_OPEN quota refresh (circuit-breaker.ts:436-441). Interaction (advisor round 2): `recordSuccessScoped` currently closes a HALF_OPEN **model** breaker on any PAIR success (circuit-breaker-manager.ts:444-447) — with `successThreshold > 1` that path must count as a probe success, not force-close. |

Zero-rule state — precise predicate (advisor round 2): **automatic tripping is off if and only if
all five `trip.*` switches are off** (quota, auth, rateLimit-hard, consecutiveFailures,
failureRate). Counting-off is NOT a route to zero: counted 429 failures have no toggle (see UX
binding rule 2) and still feed the B detectors, so four-off-plus-429 can still trip. The page
banner and the summary card "all off" both use this five-switch predicate — never "empty input
set" — and name the consequence ("broken accounts keep receiving traffic").

## Hard invariants (from code review — do not violate)

1. **Gate in `CircuitBreakerManager.recordFailureScoped` / `recordFailure`** — the single join point
   for orchestrator AND `ActiveHealthProber` (`health-prober.ts` calls
   `ErrorClassifier.classify(err, model.id, model.provider)` **without** `circuitConfig`, so classifier-internal
   gating would be bypassed by the prober path). SUSPECT marking lives here too.
   All rule *parameters* (cooldown overrides, the 429 hard/counted re-derivation from
   `diagnosis.retryAfterSeconds` + `hardTripAboveMs`) are likewise applied at the manager gate — the
   classifier stays rule-agnostic, which is exactly why the prober gap must not be closed by
   feeding it config.
2. **Closing a rule reconciles state**: reset live breakers matching that rule, and on
   `restoreState()` (`breaker-state.ts`) drop/skip OPEN records whose `reasonCode` belongs to a
   disabled rule — otherwise a restart resurrects a 12h quota block nobody asked for.
3. **Never rewrite `category` or `isRetriable`** in any gate. Failover depends on `isRetriable`
   (`orchestrator.ts`), snapshots and L2 capture key off `category`. Rule toggles must not change
   failover behavior — only trip/count decisions.
4. Scope override applies **after** credential attribution; chain-less / single-credential providers
   naturally degenerate to the model breaker (ADR-0019 guarantee) — overrides must not fabricate a
   pair space that does not exist.
5. Sanitizer: `rules`, its family maps (`counting`/`trip`/`recovery`) and **each rule object**
   merge key-by-key with default-when-missing = today's behavior (enabled; params unset = fall back
   to the global knob). Nested object replacement would silently drop defaults against the shallow
   merge in config/index.ts. Clamps: `recovery.halfOpen.maxProbes >= 1` (0 starves the prober
   budget — breakers could never recover), `successThreshold <= maxProbes` (an unsatisfiable
   threshold would pin the breaker in HALF_OPEN), and `trip.failureRate.minCalls <= windowSize`
   (otherwise the rate rule can never evaluate and dies silently).
   **Effective-config resolution**: per-rule params resolve into one effective
   `CircuitBreakerConfig` + `rules` set at startup, passed to each `CircuitBreaker` (they snapshot
   config at construction — this stays consistent with the restart-apply semantics, invariant 6).
   Note `trip.failureRate.windowSize` sizes the shared `outcomeWindow` ring buffer (also affects the
   `breaker-state.ts` persistence slice) — it is a breaker-config input, not a check-time constant.
6. Apply semantics: **restart-required**, same as `circuitBreaker.*` today (`handleSaveConfig` only
   hot-applies proxy/capture/layer2/combos/tiers). UI states "takes effect after restart". No new
   hot-apply channel in this change.

## Internal vocabulary refactor (authorized)

Config names are the public contract; the codebase is swept to match (AGENTS.md cleanup contract —
comments, tests and ADRs move with the symbol):

- `ErrorDiagnosis.suggestedCooldownMs` -> `minCooldownMs` applies to the **statistical path only**.
  Verified consumers (advisor round 2): `circuit-breaker.ts:266` and `:285` take
  `Math.max(diagnosis.suggestedCooldownMs, ...)` — the rename states what those already do; but
  `:238` is a **direct assignment** (`suggestedCooldownMs || quotaCooldownMs`) on the hard-trip
  path. That site is not renamed but REPLACED per invariant 1: the manager gate resolves hard
  durations from `trip.quota/auth.cooldownMs` and calls `trip(...)` with the final number, so the
  diagnosis field must never steer hard-trip length. Sweep targets every consumer, not just the
  `Math.max` ones. Wire-contract check first: the field is backend-internal (not in
  `CircuitBreakerSnapshot`, not mirrored in `frontend/src/lib/api.ts`) — verified.
- Post-refactor residue sweep must be empty: `rg -n "suggestedCooldownMs" backend/src backend/tests`
  and `rg -n "suggested" backend/src/config` (YAML_FIELD_COMMENTS wording included).
- `hardTrip` / `shouldTripBreaker` / `tripScope` / `accountSuspect` are already accurate internal
  terms — unchanged.

## Prior-art alignment (verified 2026-10-14)

Benchmarked against **Resilience4j** (`resilience4j.readme.io/docs/circuitbreaker` config table)
and **Envoy outlier detection** (`config.cluster.v3.OutlierDetection`):

| Industry feature | Ours | Status |
|---|---|---|
| R4J `recordExceptions`/`ignoreExceptions` (per-type disposition lists) | A-table disposition (ignore / count / trip now) | **adopted, same model** — and OCR additionally per-type cooldown/scope |
| Envoy `consecutive_5xx` + `failure_percentage_threshold` (two independent statistical detectors) | B-table `consecutiveFailures` + `failureRate`, independently disable-able | **adopted, same structure** |
| Envoy `base_ejection_time × n` capped by `max_ejection_time` | ladder `initial × multiplier` cap `max` | **adopted, richer** (per-rule) |
| Envoy `interval` sweep / R4J `automaticTransition…` | `activeProbing.enabled` + `intervalMs` | adopted |
| R4J HALF_OPEN re-evaluation by failure rate over N calls | `successThreshold`/`maxProbes` batch | equivalent (N-of-M at 0-failure), more direct for operators |
| R4J `minimumNumberOfCalls` / Envoy `*_request_volume` | **NEW** `trip.failureRate.minCalls` (default = windowSize) | adopted this round |
| R4J `maxWaitDurationInHalfOpenState` | **NEW** `recovery.halfOpen.maxWaitMs` (default 0 = forever) | adopted this round |
| R4J `METRICS_ONLY` special state | **NEW** `circuitBreaker.shadow` (default false) | adopted this round |
| R4J `ignoreExceptions` can silence **any** exception type | 429 has no "ignore" option — always counted | **deliberate deviation**: throttling must leave a statistical trace; full silencing = both B detectors off (zero-rule predicate) |
| R4J `slidingWindowType = TIME_BASED` | — | **deferred**: LLM gateway traffic is sparse/bursty; time buckets over last N seconds rarely fill. Revisit with usage data. |
| Envoy `enforcing_*` probabilistic ramp | — | **rejected**: meaningful at high QPS host pools, noise at per-model LLM request volumes |
| Envoy success-rate stdev (relative outlier within pool) | — | **rejected**: OCR's failover pool is alternatives-not-load-sharing; relative comparison has no scheduling meaning here |
| Envoy `max_ejection_percent` (never eject > X% of pool) | — | **open note**: OCR already degrades to error when the whole pool is OPEN; a "never trip the last selectable model" guard is a candidate follow-up, deliberately not in this change |
| Envoy `max_ejection_time_jitter` | — | **open note**: concurrent same-provider breakers re-open together after a region outage; jitter is a cheap later add |

## Implementation surface

- Backend: `resilience/types.ts` (schema: `BreakerRulesConfig`, `ResolvedBreakerRules`,
  `BreakerRulesStatus`, `minCooldownMs`), `resilience/circuit-breaker-manager.ts` (the rule gate —
  `applyFailure`/`dispatchFailure`, restore reconciliation via `disabledTripReasonCodes`,
  `effectiveScope`, `getRulesStatus`), `resilience/circuit-breaker.ts` (`resolveBreakerRules`,
  canary tri-state, HALF_OPEN trial batch + `halfOpenSuccesses`/`halfOpenEnteredAt`, shadow
  `verdict()`), `resilience/error-classifier.ts` (stays rule-agnostic; `suggestedCooldownMs` →
  `minCooldownMs`), `resilience/breaker-state.ts` (new record fields sanitized to 0 on legacy files,
  config-driven debounce), `config/index.ts` (`resolveCircuitBreaker` sanitizer +
  `YAML_FIELD_COMMENTS` Chinese docs), `providers/registry.ts` (passes `config.retry` for the
  `hardTripAboveMs` default) and `index.ts` (boot passes `persistence.debounceMs`),
  `routes/console.ts` (`/api/admin/status` now surfaces `circuitBreakers.rules: getRulesStatus()` —
  the banner reads the same resolved ruleset the gate uses).
- Frontend: `pages/BreakerRulesPage.tsx` (route `/breaker-rules`, split out of the guardrails
  observation page by user decision 2026-10-14 = v3.1) — the rules page implements the
  **Configuration UX contract** verbatim: block A disposition table (error class x disposition
  dropdown x per-disposition parameters), block B two detector rows, block C recovery lines,
  `auto | custom` input toggles, shadow switch, zero-rules confirm dialog, restart note, human
  blast-radius Comboboxes, and the automatic-tripping summary card. `/guardrails` keeps observation
  (live breaker snapshots) plus the manual trip/reset cards, with an entry link to the rules page.
  `lib/api.ts` mirrors the backend contract by name (`ResolvedBreakerRules`, `BreakerRulesStatus`,
  `AutomaticTrippingStatus`); i18n `en-US` + `zh-CN` carry every label via `t()` (never hardcoded).
- Docs (done in the same commit as the code, cleanup contract): **ADR-0008** §Amendment
  (2026-10-14, rules) — rule tree, gate-resolved hard durations, restore reconciliation, trial
  batch, canary tri-state, shadow, SUSPECT-on-trip; **ADR-0019** Decision 6 — the `scope` override
  applies after credential attribution and never fabricates a pair space. zh-CN mirrors under
  `docs/adr/zh-CN/**` (this file stays English-only).
- Tests: `backend/tests/breaker-rules-{toggles,params,ratelimit,mincalls,halfopen-batch,canary,restore,shadow,sanitizer}.test.ts` —
  rule-toggle matrix on the manager gate; per-rule param beats global knob and unset param falls
  back; 429 hard/counted boundary re-derived from `hardTripAboveMs` override; zero-rule no-trip
  case; canary tri-state incl. ladder retention and MANUAL override; HALF_OPEN batch (multi-probe,
  successThreshold close, short batch resolves via onCanaryFailure — the F2 reading, slot release on
  non-penalty, restore refresh of both counters and `halfOpenEnteredAt`; pair success counted not
  force-closed when successThreshold > 1); minCalls gate (rate judged only with >= minCalls, default
  windowSize intact) and sanitizer clamp minCalls <= windowSize; halfOpen.maxWaitMs expiry resolves
  via onCanaryFailure; shadow keeps full accounting yet never denies (manual/DISABLED/SUSPECT
  exempt); downgraded long-Retry-After 429 keeps its RA-derived floor; restore drops disabled-rule
  records; sanitizer key-by-key defaults on legacy config (`rules`, family maps, each rule object)
  and both clamps.

## Verification

`bun run typecheck`, `bun run test` (isolated runner), plus the dead-code audit per AGENTS.md;
English-tree check — CJK is legal ONLY in `locales/zh-CN.ts`, `docs/adr/zh-CN/**` / `*.zh-CN.md`
mirrors, `config/index.ts` YAML_FIELD_COMMENTS, and `caveman-prompts.ts` — must stay empty:
`rg -n '[\x{4e00}-\x{9fff}]' backend/src frontend/src -g '!zh-CN.ts'` (comment forms),
`rg -n '[\x{4e00}-\x{9fff}]' docs/adr/*.md docs/design/*.md docs/reviews/*.md README.md DEVELOPMENT.md AGENTS.md`
(AGENTS.md now enumerates the full English doc tree including `docs/design/*.md`).
