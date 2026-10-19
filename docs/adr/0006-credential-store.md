# ADR-0006: Credential Store — the OCR File Is the Single Truth; opencode v2 Is a Sync Client

## Status

Implemented — 2026-10-19 (credential-sync rewrite). Supersedes the "two adapters behind capability flags + push-only convergence" binding model (2026-10-15): the boot no longer SELECTS a store, opencode v2 is no longer an alternative credential truth, and the legacy reconcile/push single-truth semantics are retired. Scope: where credentials live, how the gateway reads/writes them, what identity state hangs on a key, and how credentials propagate to clients. Consumers: boot chain = ADR-0005; breaker/affinity anchoring = ADR-0004/0002; quota probing = ADR-0009.

## Decision

### 1. ONE bound store — always the OcrStore

`<ocrHome>/credentials.json` is the only credential truth. `bindCredentialStore` never selects: no CLI spawn, no version-evidence ladder, no last-known-good hysteresis, no lazy upgrade. The factory is a total function landing on OcrStore with `degradedCode: null`; the only badged landing is `bind_failed` (unexpected crash). `VersionEvidence` records `installed.version` content for diagnostics only (`cli` is always null; it selects nothing). `StoreKind` keeps `'opencode-v2' | 'opencode-v2-readonly' | 'ocr'` — those labels now describe the SYNC CLIENT's adapter, never the bound store. The capability-flag rule stands: callers branch on `capabilities`, never on `kind`; raw keys still exit only through `resolveKey/resolveKeyChain` (boot/pool/sync consumers), `revealKey` (password-gated route), and the sync engine's own HTTP writes.

### 2. auth.json — v1's credential file: import source, opt-in sync target, never a management sink

The standalone one-shot import (marker `standaloneImport` in `<ocrHome>/credential-store.json`, keyHash-dedup, oauth/wellknown listed-and-badged, auth.json untouched by the import) now runs on EVERY landing — v2 machines included. auth.json-era leftovers fold into the OCR file, which is the same data migration the retired reconcile performed, re-targeted at the new truth.

auth.json is still never a management sink (console credential writes never touch it). The ONLY writer is the opencode-v1 sync client under an operator-enabled toggle or an explicit manual run (§4) — and only on a v1-flavored machine.

### 3. One-time v2 migration — routing continuity for the flip

Machines whose keys lived ONLY in the opencode v2 db must not lose routing when the pool starts reading the OCR file exclusively. `maybeRunV2Migration` (boot, before `buildDirectPool`) pulls every routable api key from the v2 db into the OCR file once; the marker (`migration` in `credential-sync.json`) records `doneAt/pulled/deduped`. Any failed entry or an unreadable db withholds the marker → retried next boot (dedup makes reruns idempotent). A db-absent machine skips at zero cost and stays unmarked (a later opencode install gets migrated on a subsequent boot). The v1 direction needs no one-shot: the standalone import covers first boot and the continuous pull covers the rest.

### 4. Credential sync — per-client propagation (`credentials/sync.ts`)

Two clients ship in the table by default, both toggles OFF (manual-only until enabled):

- **opencode-v2**:
  - **Read (pull)**: the v2 db (readonly sqlite) → OCR file. Routable api rows only; oauth/wellknown never leave the client. keyHash dedup makes reruns no-ops.
  - **Write (push)**: OCR file → the v2 service through its HTTP management API (`connectKey`; service discovery + target policy `loopback | remote_tls | insecure_remote` refusal unchanged). Dedup is (provider case-insensitive × keyHash prefix) against the live db.
- **opencode-v1** (the legacy auth.json flavor):
  - **Read (pull)**: auth.json api-type entries → OCR file; oauth/wellknown never cross; malformed entries are loud failures. The client exists only on a v1-FLAVORED machine — auth.json present WITHOUT v2 evidence (no `opencode.db`, no v2 version pin): on a v2 machine auth.json is by definition a stale one-time migration snapshot and is never pulled or written.
  - **Write (push)**: merges the chain-head api key of every local provider into auth.json — ONE key per provider (the v1 file shape; the active head wins), api-shaped entries only (an existing oauth/wellknown entry is preserved untouched and reported as `skipped`), no delete propagation, and an unparsable auth.json is refused rather than clobbered. The file is never fabricated on machines without the client.

Write direction invariant for BOTH clients: **local OCR entries are ALWAYS kept** — the push converges the CLIENT toward the OCR file, never the reverse; the legacy "verified convergence removes the local copy" behavior is retired with the single-truth model it served.

### 5. Auto-sync — toggles, realtime push, polled pull, self-healing

State lives in `<ocrHome>/credential-sync.json` (`{version:1, clients:{<id>:{autoRead,autoWrite,lastReadAt,lastWriteAt,lastRead,lastWrite}}, migration}`). Display-safe only — timestamps, toggles, masked per-entry records; never key material.

- `autoWrite` ON: every successful OCR mutation (connect/activate/rename/disconnect, via the `OcrStore` mutation hook) schedules a debounced push (~1.5s) to EVERY enabled client. The 60s poll tick is the safety net: a failed or never-run write (service down at mutation time) is retried until a recorded-ok outcome exists.
- `autoRead` ON: the 60s poll pulls new client keys into the OCR file.
- Toggles are per client and checked at fire time (flipping off mid-debounce skips the push); both off = manual only. Manual runs (route `run`) execute either or both directions for one client and record outcomes like the auto paths.

### 6. Credential identity (unchanged)

sha256(rawKey) is the durable identity; UIs see the 12-char prefix only. Breaker pairs, SUSPECT/DISABLED flags, session affinity and quota snapshots anchor on `(provider × keyHashPrefix)`. Every write-sync-converged pair (pushed or deduped) is a reconnect gesture and lifts that credential's SUSPECT flag; DISABLED deliberately survives.

### 7. OAuth boundary (unchanged)

No store claims OAuth. oauth/wellknown rows are listed-and-badged, never routed, never imported, never pushed, never pulled; reveal refuses rows without raw api-key material.

### 8. Boot and console surface

Boot order: bind store (OcrStore) → `initCredentialSync` (migration one-shot + auto timers + mutation hook) → `buildDirectPool`. Console: `GET /credential-store` (status; `kind` always `'ocr'`; the `integrations` field is gone — the bound store is not integration-scoped); `POST /credential-store/push` is the per-provider write sync (local entries kept, outcome recorded); new `GET /credential-sync` (table data), `POST /credential-sync/toggle`, `POST /credential-sync/run`. Reveal keeps its four hard gates.

### 9. Retired

The reconcile gate (auth.json→v2 push + `authWriteDisabled` marker — superseded by §2's import + §4's write sync), the CLI version probe + hysteresis + lazy-upgrade loop, the `not_ocr_bound` push precondition, the readonly-variant route surface (a 409 `store_readonly` from the BOUND store is unreachable; the adapter's internal readonly variant remains for sync-side reads), and the boot CLI spawn entirely (zero opencode coupling at boot). Legacy `credential-store.json` reconcile blocks stay readable (additive tolerance) but are never written again.

## Consequences

- Management writes never depend on opencode: the console works with opencode absent, stopped, or broken.
- Keys added in the console reach opencode only through a write sync — automatic when enabled, explicit otherwise. The credential-sync table makes that propagation visible instead of implicit.
- `OpencodeV2Store` remains fully exercised as the sync engine's tool (reads for pull, verified HTTP writes for push, stage-2 service discovery unchanged); its route-level v2 behaviors (integration-unmatched 409, readonly refusal, view invalidation) are no longer reachable through the console and their route tests were retired with them.
- Tests: `credentials-sync` (engine), `credentials-factory` (single landing + totality), `credentials-console-routes` (routes × OCR file), `credentials-push-endpoint` (keep-local), `boot-direct-credential-store` (OCR-file boot), plus the unchanged `credentials-leak-surfaces` / `credentials-reveal-route` / `credentials-standalone-import` / `credentials-opencode-v2-*` adapter suites.
