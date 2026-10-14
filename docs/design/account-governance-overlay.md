# Implementation Plan — Account Governance Overlay & Rate Limiter (ADR-0020 material)

> Status: PLAN (no code yet). Prerequisite: land ADR-0019 P3 as commits first —
> 4k uncommitted lines + this overlay would form a review backlog.
> This document consolidates every decision taken in the 2026-10-13 design thread
> (operator + @advisor reviews). Sections 2–5 are binding design; 6–8 are execution.

## 1. Scope

Two governance capabilities, one mechanism serving two directions:

- **Outbound (accounts = upstream provider credentials)**: per-account alias and
  request/token window caps. Purpose: *shape* traffic to avoid provider 429s
  (proactive layer; the breaker remains the reactive hard edge).
- **Inbound (apiKeys = client keys OCR issues)**: same limit shapes + cost budget.
  Purpose: *enforce* contracts — over-limit rejects the caller with 429 + Retry-After.
- **Shared engine only where the semantics are actually shared** (see §3 for the
  verdict-not-action rule). Concurrency caps are deferred (§6) — v1 is a pure
  ledger engine, no lease machinery.

## 2. Vocabulary (follows the established doctrine)

| Term | Meaning | Surface |
|---|---|---|
| `account` | operator-manageable identity anchored on `keyHash` (governance projection of a credential) | wire `'account'`, config `accounts:`, `AccountStateStore` |
| `credential` | key material + runtime carrier; opencode's own word | `CallCredential`, `CredentialStore` |
| `pair` | (model × account) breaker scope; UI renders "model × credential" | `TripScope 'pair'` |
| `limiter` | the shared mechanism that answers *verdicts* about a subject's window budgets | `Limiter` |
| `subject` | discriminated key: `account:<provider>:<keyHashPrefix>` \| `apikey:<id>` | limiter API only; never user-facing |

Config naming rule (one concept one spelling, both directions): **no `rpm`/`tpm`
sugar** beside the structured form, and **no co-located multi-countable entries** —
one entry = one window = one countable = one addressable constraint.

```yaml
accounts:
  anthropic:
    - keyHashPrefix: "ab12cd34ef56"
      limits:
        - { window: 1m, requests: 10 }
        - { window: 1m, tokens: 50000 }
        - { window: 1d, requests: 800 }
apiKeys:
  - id: key-abc
    limits:
      - { window: 1m, requests: 30 }
      - { window: 1m, tokens: 60000 }
      - { window: 1d, costUsd: 5 }
```

`window` parses standard duration strings (`30s / 5m / 1h / 1d` — Go/Prometheus
syntax, the industry vocabulary). Coexistence note: existing knobs stay in ms
numbers (`cacheTtlMs`); **new** knobs speak duration strings — no retro-migration
(moving old keys is out of scope, mixing by generation is honest).
Countables: `requests`, `tokens`, `costUsd` (costUsd inbound only — a budget is a
contract with the caller, never a cap on the provider's own key). Per-model
overrides: not in v1 (aggregate account caps are a conservative bound; reopen only
with ≥3 real use cases).

## 3. The Limiter — one mechanism, two policies at call sites

Advisory precedent: collapsing `*Scoped` was rejected because an optional flag
hides protocol switching. Same law here: the limiter **outputs verdicts, never
actions**. Any need that would make it know "what to do on denial" splits it.

```ts
/** Reason codes echo the config field names VERBATIM (one concept one spelling —
 *  an operator maps a log reason straight back to the YAML key, zero translation). */
type Verdict =
  | { allowed: true }
  | { allowed: false; limitedBy: 'requests' | 'tokens' | 'costUsd';
      rule: string;          // "1m/requests" style — unique per subject (see §5)
      retryAfterMs: number };

class Limiter {
  peek(subject: Subject): Verdict;                       // NON-CONSUMING filter
  tryDispatch(subject: Subject): Verdict;                // atomic check-and-count requests
  recordUsage(subject: Subject, u: { tokens?: number; costUsd?: number }): void; // terminal/usage events
  rehydrate(readback: DayLedgerReadback): void;          // boot-time day windows from the trace/finops ledger
  counters(subject: Subject): { admitted; skippedAtCap; forcedThrough };
}
```

`peek` vs `tryDispatch` is the breaker's own `peekExecute`/`canExecute` pair —
non-consuming vs consuming, no boolean flags. `tryDispatch` exists because
check-then-act over the requests counter races under inbound concurrency (two
simultaneous requests at the last slot would both pass a bare `peek`); outbound
shaping tolerates ±1 (breaker-backed), inbound enforcement must not.

Call-site policies (the enforcement action — the policy half — lives here, in callers):

| Site | On `!allowed` |
|---|---|
| `account-selection` spread filter | `peek`; exclude candidate from **new-session spread only** |
| keep-bound / last candidate | **forced-through** — never rebind (Decision 7 iron law: cap ≠ failure; rebinding burns prompt cache) |
| `registry.execute` | `tryDispatch()` at dispatch (requests += 1 atomically); provider 429 still flows through the breaker chain unchanged |
| inbound auth middleware | `tryDispatch()`; 429 + `Retry-After` (local `retryAfterMs`, no upstream call); `costUsd` denial → 402 contract refusal |

**The iron law (comment-pinned at the selection site)**: local caps are a shaping
input to candidate selection. The breaker is the reactive layer. Forced-through
preserves today's semantics; a real 429 teaches us the cap was wrong, a silent
local wait teaches us nothing.

### 3a. Multi-layer caps — combination semantics (binding)

Three shapes guard orthogonal provider failure modes (`requests`→RPM 429,
`tokens`→TPM gate, `costUsd`→budget/money facts, inbound-only). They compose:

1. **Deny = ANY rule full** — the limits list is an AND constraint set with an OR
   denial gate. Same countable across several windows (`1m/10` + `5m/40`) is a
   legitimate, recommended multi-window cascade: short window = burst guard, long
   window = quota guard (Envoy/Google rate-limit-design pattern).
2. **`limitedBy` = the binding rule** — among all full rules, the one with the
   LATEST `nextOpenAt`; the verdict names the true bottleneck, not first match.
3. **`retryAfterMs` = max over full rules** of each rule's next opening — the
   subject recovers only when every constraint is simultaneously slack; an earlier
   value would send clients back into a still-denied wall.
4. **Exactly one countable per entry** — `{window: 1m, requests: 10, tokens: 50000}`
   is a VALIDATION ERROR, not a compound condition. Co-located multi-countables
   would be a second spelling of the same two constraints that two split entries
   already express (the `rpm:`-sugar rule applied to shape): one entry = one
   constraint = one `limitedBy` hit = one unique YAML line for log-to-config echo.
5. **Future implementation warning — if a concurrency shape is ever added (see §6),
   it must NOT be approximated with windows.** Little's Law `L = λ × W` correlates
   in-flight with arrival-rate only while duration W is stable — and W is the least
   stable quantity in LLM traffic (500 ms non-stream vs 10-minute extended
   thinking). Slow streams keep a `1m/requests` window occupied while in-flight
   silently doubles; fast streams churn any window while instantaneous occupancy
   stays unbounded. A window bounds the measure; a lease bounds the supremum.
   Envoy / K8s-APF / Resilience4j / Kong all keep count and gauge separate machinery.

```yaml
accounts:
  openai:
    - keyHashPrefix: "ff00aa11bb22"
      limits:
        - { window: 1s,  requests: 3 }        # burst hammer guard
        - { window: 1m,  requests: 40 }       # provider RPM
        - { window: 1m,  tokens: 90000 }      # provider TPM
        - { window: 6h,  requests: 500 }      # slow self-throttle
```

## 4. State policy — nothing new gets persisted (three-question test, pinned)

> 1. Is the value still true after restart? 2. Is the loss cost "brief under-shaping"
> or "a lie"? 3. Can an existing fact-source rebuild it?

| State | Answer | Placement |
|---|---|---|
| policy (alias, limits entries) | person's decision, persists | `accounts:`/`apiKeys:` config; alias in `account-state.json` §meta |
| minute/hour windows | ≤1 min loss = under-shaping, breaker catches | memory only (breaker state itself became durable 2026-10-14 — ADR-0008 amendment; these rate windows stay ephemeral under the same loss doctrine) |
| day windows / budget | spent money is a physical fact — **but the ledger already owns it** | **rehydrate at boot from traces/finops daily data** (`Limiter.rehydrate`), then memory-increment. No fourth truth source |
| SUSPECT / affinity | administrative | already persisted (unchanged) |
| multi-instance shared store | single-process is the product form | NOT a goal (factory comment: *"two OCR processes racing … uncoordinated by design"*) |

Rehydration data path: per-account day windows read the same trace ledger keyed by
`servedAccountPrefix` (field exists, surfaced per turn); per-key costUsd reads the
existing keyId capture path (`capture-keyid` precedent) — **no new accounting, the
ledger is already complete for both subjects**.

Token accounting on streams: record on **usage events** (Anthropic `message_delta`,
OpenAI `include_usage` tail chunks — already captured by the upstream-event layer);
aborted stream without usage → record known partial + `usage: partial` marker.
No pre-reservation (that door opens only with measured TPM-precision demand).

Terminality discipline (the LiteLLM #20256/#27955 class, surviving as a COUNTING
hazard even with leases designed out): `recordUsage` must fire on EVERY terminal
path — natural completion, upstream error, client abort (SSE cancellation, existing
mechanism), timeout — so usage is recorded exactly once (never double, never
zero-when-billed).

## 5. Lifecycle, validation, observability, security

- **Uniqueness**: `(subject, window, countable)` repeats are a validation error —
  this is what makes `rule: "6h/requests"` a unique address inside a subject, and
  what lets one entry express exactly one constraint without ambiguity.
- **Stale anchors**: boot + pool-rebuild compare every `keyHashPrefix` entry against
  the live `resolveKeyChain`; unmatched entries are marked stale in console (never
  silently applied). Orphan cleanup reuses the Decision 6 GC rule verbatim
  (*"absent from the current snapshot → garbage-collected after a grace period"*).
- **Config validation (trust boundary)**: duration syntax, unknown provider ids,
  duplicate prefixes, negative/zero counts, co-located countables → loud boot error
  naming the offending line; YAML comments (`YAML_FIELD_COMMENTS`) ship Chinese docs
  for every new field. Absent entry = byte-identical to today (the degeneracy
  promise, extended: no entry → no cap, no state).
- **Observability** (machine-readable reason culture): denial verdicts recorded into
  `failoverPath`/decision capture with `limitedBy`/`rule`; per-subject counters
  (`admitted / skippedAtCap / forcedThrough`) surface in the **existing
  `withAccountHealth` overlay** — account rows get cap state beside breaker state,
  KeysPage stays the single account panel (Guardrails view reads the same overlay).
  No second dashboard.
- **Security**: alias/notes are untrusted input — length cap, no key-shaped strings
  (echo-containment negative test, `credentials-leak-surfaces.test.ts` pattern).

## 6. Explicit non-goals (closed doors, each with the reason)

| Door | Why closed |
|---|---|
| `rpm:`/`tpm:` sugar; co-located multi-countable entries | one concept one spelling, both directions: sugar is a second spelling of a window rule; `{requests, tokens}` in one line is two constraints wearing one entry. Single-constraint entries make `(subject, rule, limitedBy)` address exactly one YAML line |
| `maxConcurrent` (v1 feature) | **deferred, not folded** — no mainstream cloud LLM provider enforces account-level concurrency caps (OpenAI/Anthropic/Gemini/Bedrock publish rate windows only); 529-class overload is the provider's own capacity, owned already by the breaker (pair/model trip + failover) — a local slot cap cannot prevent someone else's saturation and only clips throughput. Re-entry condition: a routed self-hosted backend (vLLM `max-num-seqs`, KV-cache pressure); then the shape arrives schema-additively (new field + lease machinery; existing configs byte-identical). §3a item 5 is the standing warning: never approximate it with windows |
| unified inbound+outbound controller *with action flags* | verdict-not-action; callers own protocol |
| TPM token pre-reservation | shaping layer, not adversarial; overshoot documented and tolerated (LiteLLM ships reservation and still overshoots) |
| queue/bounded-wait on caps | coding-agent clients retry; waiting adds leak-prone state machines |
| priority/weight knobs | Decision 7 bans balancing bound sessions; spread filtering is the full freedom we need |
| Redis / multi-instance | single-process product form |
| per-model cap overrides | aggregate is conservative bound; 3-use-case rule applies |
| persisted counters | four-truth-source problem; ledger rehydration is strictly more accurate |

## 7. Execution phases

| Phase | Deliverable | Verification |
|---|---|---|
| P0 (gate) | ADR-0019 P3 committed & reviewed | existing suite green at commit points |
| P1 engine | `Limiter` + `SlidingWindowCounter` + duration parser; fake-clock unit tests | new `limiter.test.ts`; `bun run typecheck` |
| P2 policy store | `account-state.json` rename (suspect→`{version:2, suspects, meta}`), alias read/write, `accounts:`/`apiKeys:` limits schema + validator (incl. uniqueness + co-location rejection) + YAML comments | `credentials-*` suites + `validator.test.ts` extensions |
| P3 outbound wiring | selection spread filter (`peek`), `execute` `tryDispatch` at dispatch, usage-event `recordUsage` on all terminalities, boot `rehydrate` | `account-affinity-orchestrator`, `resilience-*`, new abort/terminality usage test |
| P4 inbound wiring | apiKeys `limits` parsing, auth middleware `tryDispatch` → 429/Retry-After / 402, budget via ledger readback | `auth.test.ts`, `model-access` suites |
| P5 surfaces | console overlay (cap state + stale list + counters), GuardrailsPage read-only display, i18n en/zh | typecheck + `build:frontend` + manual console check |
| P6 hardening | GC/stale tests, echo-containment, docs (ADR-0020 + this plan trimmed to decisions) | full isolated suite (`bun run test`), sweep greps |

Ordering constraint: P1 before P2 (engine is the contract), P3 before P4 (outbound
is the product core; inbound reuses a proven engine). ~1.5–2k lines incl. tests
(concurrency/lease stack removed), 4 reviewable commits — not one.

## 8. Test strategy (beyond unit)

- Window engine unit pins (fake clock): boundary aging, cascade windows, max-rule
  `retryAfterMs`, binding-rule `limitedBy`, exactly-once `recordUsage` per terminality.
- Race pin: N concurrent `tryDispatch` at remaining=1 → exactly one allowed
  (atomicity, no check-then-act gap).
- Iron-law pin: bound-at-cap account **must not** rebind while a sibling is idle;
  spread must exclude at-cap candidates; forced-through must still dispatch.
- Rehydration pin: boot with today's ledger → day-window counters exactly match
  ledger (per-account via `servedAccountPrefix`, per-key costUsd via keyId capture),
  minute windows start empty.
- Degeneracy pin: zero `accounts:`/`limits` entries → byte-identical request paths
  (reuse the P3 single-credential harness).
- Stale pin: rotate key → entry marked stale, never applied, GC'd after grace.
- Validation pins: co-located countable, duplicate `(window, countable)`, bad
  duration string, unknown provider — each a named-line boot error.
- Inbound response pins: 429 + `Retry-After` header and 402 are OpenAI-compatible
  shapes on all four inference surfaces; cost exhaustion answers 402 (never 429).
- Echo-containment: alias/notes never carry key material into logs/exports
  (negative-test template).
