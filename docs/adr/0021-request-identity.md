# ADR-0021: Request Identity — Gateway-Owned Keys, Caller Values as Correlation Only

## Status

Implemented — 2026-11-12.

## Context

A caller can legally place MANY requests inside one distributed trace: a retry, a tool loop, a sub-agent, or — as measured in the field — one client reusing a single W3C `traceparent` for an entire conversation. A trace id therefore names a DAG of spans, never one request. The gateway used to store each request's observation record under the CALLER's trace id (`traces.db` primary key `trace_id`), so eight requests sharing one `traceparent` collapsed onto one row, and a second session's row was overwritten by the first one's later turn. The console then showed a phantom session and multiplied token totals (`7 × 67 217`).

The same ambiguity reached the capture plane and the response headers: `sessionId` sometimes WAS the client's own value, `X-OCR-Trace-ID` echoed a value the caller already knew, and no surface named the gateway's own record.

## Decision

### 1. One vocabulary; unqualified names are the gateway's

This service is the default namespace, so only foreign namespaces carry a prefix.

| Name | Owner | Cardinality | Role |
| :--- | :--- | :--- | :--- |
| `requestId` | gateway | unique per request, immutable | trace record's primary key, console row identity, capture join key, `X-OCR-Request-ID` |
| `sessionId` | gateway | unique per conversation | session entity (ratchet / pins), `X-OCR-Session-ID` |
| `clientRequestId` | caller | repeatable, optional | correlation only — never a key |
| `clientSessionId` | caller | repeatable, optional | client conversation alias, carried as `request.clientRef` with its provenance (ADR-0002) — no second field |
| `upstreamRequestId` | upstream provider | optional | the provider's own call id (`x-request-id`), recorded on the capture archive's upstream-response event — never invented, absent when the provider does not name its calls |
| `exchangeId` | gateway | unique per HTTP exchange | pairs a request event with its response event (2+ exchanges per request) |

There is no `traceId` and no `spanId` anywhere in the domain model, storage, admin API, console, or response headers. This module chain is the ONLY place the wire vocabulary is understood: `observability/request-identity.ts` parses W3C `traceparent` (then `x-request-id`, `x-trace-id`, `x-correlation-id`, `request-id`) into `clientRequestId`, and mints `requestId` / `exchangeId`.

### 2. Scope ladder

```
trace (caller)  ⊃  requests (ours)  ⊃  exchanges (ours)
session (ours)  ⊃  requests
```

A caller value may repeat across rows; the gateway's keys may not. The gateway never invents a `clientRequestId`: an invented correlation value would be a gateway-owned id in disguise.

### 3. Storage rules

- `TraceTracker` maps and the session index are keyed by `requestId`; the session index holds one entry per RECORD.
- `record()` never overwrites: a missing id (legacy/planted row) or a duplicate key mints a fresh `requestId`.
- `traces.db` schema v2 (`PRAGMA user_version`) is `(request_id PRIMARY KEY, session_id, ts, data)` — no trace-id column. The gate is VERSION **and SHAPE**: a file can carry the v2 number with a foreign shape (an intermediate build left `request_id` as PK plus a NOT NULL `trace_id`, which made every write fail the constraint and — because writes fail open — silently stopped all persistence). The rebuild therefore also runs whenever `PRAGMA table_info` does not show exactly `(request_id PK, session_id, ts, data)`, and a row that already has a gateway `request_id` keeps it. The v1→v2 migration rebuilds the table inside ONE transaction (SQLite cannot drop a PRIMARY KEY column) and re-keys legacy rows under their old (primary-key-enforced, therefore unique) trace id; those v1 rows had already collapsed whatever collided, so nothing further is recoverable. `ExecutionTrace` replay normalization fills `requestId` from that key and drops rows carrying neither id. The file is shared with the FinOps / failure-event / quota-event / ratelimit stores — each has an independent handle and only runs `CREATE TABLE IF NOT EXISTS`; `user_version` is FILE-wide, so this store is its sole owner, and a version NEWER than the binary is read as-is (never down-migrated).
- `sessionId` is the gateway entity id, with ONE sanctioned naming exception (ADR-0002 §session resolution): under `header_fallback` the gateway NAMES a freshly-resolved session after the vendor header value, so `sessionId` may coincidentally equal a client-supplied string. It is still the gateway entity (resolved by the gateway, never used as a raw key by another store); the value is not trusted across conversations.
- Legs INSIDE one turn share that turn's `requestId`: the Layer-2 decision call made while routing a chat request is one such leg and is distinguished by `purpose: l2-decision`, not by a second id. The standalone decision SURFACE is a client request of its own and therefore mints its own `requestId` like any other.
- Capture events carry `requestId`, `exchangeId`, `clientRequestId?`, `sessionId`, `upstreamRequestId?`; turn grouping and request/response pairing use `requestId` / `exchangeId` only.
- Archive files written before this decision are mapped ONCE in the archive reader (`normalizeArchivedEvent`): `spanId → exchangeId`, `traceId → clientRequestId`, and the caller value becomes the join key because no gateway id exists in those files. This is data migration at an ingestion boundary — no downstream code holds two spellings, and the function is deletable once retention passes the cutover.

### 4. Wire

- `X-OCR-Request-ID` (new) names the exact console row.
- `X-OCR-Session-ID` keeps naming the gateway session.
- The capture admin endpoints take the turn id: `GET /api/admin/capture/:date/:file/turn?id=<requestId>` resolves the turn (an `evt_…` event id is accepted too, since either names it).
- `X-OCR-Trace-ID` is removed. Echoing the caller's own trace id carries no information; the caller already holds it, and the gateway is not asserting a span relationship it does not propagate.

## Consequences

- A client reusing one `traceparent` for a whole conversation is harmless: each request is its own row, its own capture turn, and its own usage record.
- Token/cost aggregates can no longer be multiplied by a repeated caller id; `total` and per-row values describe distinct requests.
- Console deep links and copy targets are the gateway's `requestId`; a caller value is never resolved server-side (it may cover several rows, so resolving it would be a guess).
- The capture archive remains the only place the caller's correlation value is retained, which is exactly what a wire log should do.
- The schema switch is ONE-WAY. An older binary opening a v2 file still READS it (its replay is a plain `SELECT data`) but its writes target the removed `trace_id` column and fail open, so persistence silently degrades to memory-only. Take a copy (`VACUUM INTO traces.db.pre-v2`) before the first boot of this build if a rollback must stay possible.
- Renaming is breaking for anyone reading `X-OCR-Trace-ID`; the header is documented in `README.md` and the console fact chips as `X-OCR-Request-ID`.
- `TraceTracker` / `ExecutionTrace` / `/api/admin/traces` keep their names: "traces" is the OBSERVATION PLANE (the record panel), while `requestId` is the identity INSIDE it. Renaming the plane would touch public routes, deep links, navigation and every locale for zero correctness gain; the vocabulary that matters is the id set above.
- `upstreamRequestId` is captured from the provider's RESPONSE HEADER only (`x-request-id` / `request-id`). Body-derived ids are deliberately not parsed: streamed bodies are SSE, per-chunk parsing costs the hot path, and the places that omit the header do not expose a true request id on the wire anyway. Absent means the upstream does not name its calls — never invented.
