# Rate-Limit Waiting — Complete Control Flow

Companion diagrams for [ADR-0023](../adr/0023-rate-limit-waiting-and-reentrant-admission.md)
(§1 re-entrant admission, §2 budgets, §2.1 timeout exit, §3 the 429 ladder, §4 hard
constraints). The ADR keeps a condensed overview in §1.1; **this file is the
archival home of the full diagrams**.

> Status: **Proposed**, mirroring ADR-0023. The FLOWCHARTS describe the target
> state; the prose notes quoting `parseInt`, `evaluate()` or `penalize()`
> describe today's baseline, as ADR-0023's Context does. A zh-CN mirror lives at
> [`zh-CN/rate-limit-waiting-flow.md`](./zh-CN/rate-limit-waiting-flow.md):
> node IDs and edge topology are identical; only labels and prose are localized.
> This file is authoritative for structure. Where a diagram and an ADR table
> disagree, **the ADR table is normative**.

## 1. Full path

One turn, from admission to its single terminal. Subgraphs are the four owners of
control flow; every arrow crossing a subgraph boundary is either a re-entry into
`admitTurn()` or a handoff to the client.

```mermaid
flowchart TD
  subgraph A["admitTurn() — cumulative per-turn budget"]
    A0["turn in: requestId + admission state"]
    A1["peek() non-consuming probe"]
    A2{"local cap hit?"}
    A3["apiKeys limits: 2s budget"]
    A4["credentials overlay: 30s budget"]
    A5{"window open?"}
    A6{"budget or reentries left?"}
    A7{"client still alive?"}
    A8["SSE comment heartbeat"]
    A9["lock model x credential, no rebind"]
  end
  subgraph P["executeCandidatePool — single funnel"]
    P1["tryDispatch(): consume exactly 1 slot"]
    P2{"credential cap peek?"}
    P3["skip candidate"]
    P4["upstream call"]
    P5{"upstream result"}
    P6["success terminal"]
  end
  subgraph R["upstream 429 ladder — by cache cost"]
    R0{"Retry-After declared?"}
    R1{"RA at most 30s?"}
    R2["in-place sleep on locked pair"]
    R3{"RA under 2min?"}
    R4["429 + upstream Retry-After"]
    R5{"switch legal: breaker + candidate?"}
    R6["switch path, rebind"]
    R7["429 + pool-min Retry-After"]
    R8["suppress shaping cooldown"]
  end
  subgraph E["timeout exit — §2.1"]
    E0["re-read verdict at timeout"]
    E1{"binding source?"}
    E2["exact: msUntilBelow over full constraints"]
    E3["lower bound: reservation-only or pool"]
    E4["Retry-After = max(1, ceil(remaining ms / 1000))"]
    E5{"200 SSE headers sent?"}
    E6["429 + Retry-After + headers"]
    E7["SSE error event with retry_after_ms"]
    E8["client backs off; turn continues"]
  end
  C0{"relay.committed?"}
  C1["close stream, never re-enter"]

  A0 --> A1
  A1 --> A2
  A2 -->|"apiKeys limits"| A3
  A3 --> A9
  A2 -->|"credentials overlay"| A4
  A4 --> A9
  A2 -->|"none"| P1
  A9 --> A5
  A5 -->|"yes"| P1
  A5 -->|"no"| A6
  A6 -->|"yes"| A7
  A7 -->|"yes"| A8
  A8 --> A1
  A7 -->|"no"| C1
  A6 -->|"no"| E0
  P1 --> P2
  P2 -->|"at-cap, another candidate"| P3
  P3 --> P2
  P2 -->|"at-cap, keep-bound or last"| A4
  P2 -->|"free"| P4
  P4 --> P5
  P5 -->|"2xx"| P6
  P5 -->|"429"| R0
  P5 -->|"other failure"| C0
  R0 -->|"yes"| R1
  R1 -->|"yes"| R2
  R2 --> P4
  R1 -->|"no"| R3
  R3 -->|"yes"| R4
  R4 --> E8
  R3 -->|"no"| R5
  R5 -->|"yes"| R6
  R6 --> P1
  R5 -->|"no"| R7
  R7 --> E8
  R0 -->|"no"| R8
  R8 --> C0
  C0 -->|"no"| A1
  C0 -->|"yes"| C1
  E0 --> E1
  E1 -->|"time window or cooldown"| E2
  E2 --> E4
  E1 -->|"reservation-only or pool"| E3
  E3 --> E4
  E4 --> E5
  E5 -->|"no"| E6
  E6 --> E8
  E5 -->|"yes"| E7
  E7 --> E8
```

Two arrows carry the whole decision: `P2 --> A4` is the replacement for today's
`forced` dispatch (an at-cap keep-bound pair **waits** instead of hitting a full
window), and `C0 --> A1` is the only re-entry out of a failed call. Both are
gated on `!relay.committed`; `C0 --> C1` is the terminal that forbids a second
copy of a partly consumed stream.

## 2. Upstream 429 ladder — zoom

```mermaid
flowchart TD
  S0["upstream 429"] --> S1{"Retry-After parse: Number + isFinite"}
  S1 -->|"HTTP-date or NaN: treat as no RA"| S9["no Retry-After branch"]
  S1 -->|"value in ms"| S2{"at most maxRateLimitWaitMs (30s)?"}
  S2 -->|"yes"| S3["RATE_LIMIT_BURST: in-place sleep, locked pair"]
  S3 --> S4["re-dispatch the same pair locally"]
  S2 -->|"no"| S5{"under failoverThresholdMs (2min)?"}
  S5 -->|"yes"| S6["429 + Retry-After = upstream RA"]
  S5 -->|"no"| S7{"canExecuteScoped + pool has candidate?"}
  S7 -->|"yes"| S8["switch path, rebind, new dispatch"]
  S7 -->|"no"| S10["429 + Retry-After = pool min peek.retryAfterMs"]
  S9 --> S11["suppress penalize(); breaker still records"]
  S11 --> S12{"relay.committed?"}
  S12 -->|"no"| S13["return to admitTurn(), let probing decide"]
  S12 -->|"yes"| S14["close stream, no re-entry"]
  S6 --> S15["client backoff"]
  S10 --> S15
```

`parseInt` at the four provider call sites AND in the classifier itself
(`error-classifier.ts`, which also requires `parsed > 0`) turns
`Retry-After: 0.5` into `0` and an HTTP-date into `NaN`; both are discarded today
and misrouted to the "no declaration" branch. Replacing only the provider sites
would leave `S1` dishonest. `RATE_LIMIT_BURST` here is the `networkCause` /
retriable cause, not the classifier's `ErrorCategory` (`RATE_LIMITED`).
A no-RA 429 must not write a shaping cooldown: `evaluate()` consults
`cooldowns` before window math, so a 60s `penalize()` would make every probe
inside a 30s budget report roughly 60s-to-available and the re-entry would be
mathematically guaranteed to time out.

## 3. Timeout exit and backoff handoff — zoom

```mermaid
flowchart TD
  T0["budget exhausted or reentries = 0"] --> T1["re-read verdict via peek() at timeout"]
  T1 --> T2{"binding source?"}
  T2 -->|"sliding window"| T3["msUntilBelow(), max over full constraints"]
  T2 -->|"cooldown"| T4["until - now"]
  T2 -->|"reservation-only"| T5["max(probeIntervalMs, 1s), flag estimate"]
  T2 -->|"pool-wide"| T6["min(peek.retryAfterMs), lower bound"]
  T3 --> T7["remaining ms, not the first-probe value"]
  T4 --> T7
  T5 --> T7
  T6 --> T7
  T7 --> T8["Retry-After = max(1, ceil(ms / 1000))"]
  T8 --> T9{"200 SSE headers sent?"}
  T9 -->|"no"| T10["429 + Retry-After + RateLimit-Reset"]
  T9 -->|"yes"| T11["event: error with error.retry_after_ms; close stream"]
  T10 --> T12["code: rate_limit_exceeded; optional waited_ms"]
  T11 --> T12
  T12 --> T13["client backs off and retries"]
```

`RateLimit-Limit` / `-Remaining` cross the boundary **only** on the inbound
path, where they describe the client's own key contract; on the outbound path
they describe a credential the caller does not own and stay in the event ledger.
A `costUsd` window reopens by time, so it answers `429 + Retry-After`, never
`402` — SDKs read 402 as "do not retry". A window full purely on token
reservations does not age out, so the 1s `RESERVATION_RETRY_FLOOR_MS` is a
guessed floor: echoing it produces a "return in 1s, still full, another 1s"
retry storm.

## 4. Diagram-to-ADR map

Config keys inside node labels drop their module prefix; fully qualified names
and target defaults are in ADR-0023 §5.

| Nodes | ADR-0023 section | Governing statement |
| :--- | :--- | :--- |
| `A0`–`A9` | §1, §2 | one `admitTurn()`, cumulative budget, pair locked while waiting |
| `P1`–`P6` | §1, consequences | `executeCandidatePool` stays the single funnel; denials are not counted |
| `R0`–`R8` | §3 | the ladder ordered by cache cost; local caps never license a switch |
| `E0`–`E8` | §2.1 | budget exhaustion still returns a usable backoff instant |
| `C0`, `C1` | §4 | `committed` is terminal |
| `S1`, `S9`, `S11` | §4 | shared lossless parser; no shaping cooldown on RA-less 429s |
| `T2`–`T8` | §2.1 | exact value vs lower bound; remaining, not original |

## 5. Maintenance

- Fig. 1 is the only end-to-end picture. Figs. 2 and 3 zoom into its `R` and `E`
  subgraphs; a change to a branch must be made in both places.
- ADR-0023 §1.1 is the condensed view of Fig. 1. If Fig. 1's topology changes,
  check whether §1.1 still tells the same story — this is the FIRST deliberate
  pair (Fig. 1 ↔ §1.1), not two independent copies.
- The zh-CN mirror is
  [`zh-CN/rate-limit-waiting-flow.md`](./zh-CN/rate-limit-waiting-flow.md) —
  the SECOND deliberate pair (this file ↔ the mirror). Node IDs and edge
  topology are identical; only labels and prose are localized. This file is
  authoritative for structure: a topology change must land in both files in the
  same commit and pass a structural diff.
- The mirror lives in a `zh-CN/` subdirectory so it stays outside the
  English-doc CJK scan (`docs/design/*.md` matches one level only).
- When the code lands, ONE commit promotes the whole set: the Status line of
  both ADR-0023 language versions → `Accepted`, both index Status cells →
  `Implemented`, and both diagram companions → `Implemented`.
