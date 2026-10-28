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

Boot order: bind store (OcrStore) → `initCredentialSync` (migration one-shot + auto timers + mutation hook) → `buildDirectPool`. Console: `GET /credential-store` (status; `kind` always `'ocr'`; the `integrations` field is gone — the bound store is not integration-scoped); keys are handled as ONE book, so there is no per-provider push endpoint: the only write entry is `POST /credential-sync/run` with `direction: write` (optional `provider` narrows it; local entries kept, outcome recorded); plus `GET /credential-sync` (table data) and `POST /credential-sync/toggle`. Reveal keeps its four hard gates. The operator credential-chain seam is `POST /opencode/providers/:id/credentials/reorder` (see the amendment below); `store.activate` survives only as the internal head primitive.

### 9. Retired

The reconcile gate (auth.json→v2 push + `authWriteDisabled` marker — superseded by §2's import + §4's write sync), the CLI version probe + hysteresis + lazy-upgrade loop, the `not_ocr_bound` push precondition, the readonly-variant route surface (a 409 `store_readonly` from the BOUND store is unreachable; the adapter's internal readonly variant remains for sync-side reads), and the boot CLI spawn entirely (zero opencode coupling at boot). Legacy `credential-store.json` reconcile blocks stay readable (additive tolerance) but are never written again.

## Consequences

- Management writes never depend on opencode: the console works with opencode absent, stopped, or broken.
- Keys added in the console reach opencode only through a write sync — automatic when enabled, explicit otherwise. The credential-sync table makes that propagation visible instead of implicit.
- `OpencodeV2Store` remains fully exercised as the sync engine's tool (reads for pull, verified HTTP writes for push, stage-2 service discovery unchanged); its route-level v2 behaviors (integration-unmatched 409, readonly refusal, view invalidation) are no longer reachable through the console and their route tests were retired with them.
- Tests: `credentials-sync` (engine + the keep-local push contract), `credentials-factory` (single landing + totality), `credentials-console-routes` (routes × OCR file), `boot-direct-credential-store` (OCR-file boot), plus the unchanged `credentials-leak-surfaces` / `credentials-reveal-route` / `credentials-standalone-import` / `credentials-opencode-v2-*` adapter suites.

## Amendment — key deletions never propagate (so a pull re-imports them)

The write direction is ADD/ROTATE-ONLY for both clients: v2 pushes `connectKey` per credential and never calls the delete route; v1 merges the chain-head api key per provider and never removes a provider node. Consequence, stated plainly: a credential deleted only in the OCR file is re-imported by the next read sync (manual or the auto-read tick) for as long as the client still holds it. That is the read direction's contract — pull imports what the client holds, and the store keeps no memory of a deliberate deletion, so "client has a key OCR lacks" and "operator just removed that key" are the same observation. Operational rule: **to make a removal stick, delete on the client side too** (the console sync panel states this on the pull control).

**The console DELETE is a REVOCATION, not a local cleanup**, and it uses the machinery above instead of inventing a second ledger:

- the OCR row is deleted (the store's `disconnect`);
- the key MATERIAL is anchored as DISABLED in the existing keyHash-anchored takedown ledger (`reason: 'deleted'`), so a pull-back re-imports the row **parked** — never routable, badge + one-click restore. An ALREADY-parked key material keeps its own note: the flag's other half (`disabledAt`) is preserved by design, and the delete must not launder the operator's audit text into `'deleted'`; This is the pull-side tombstone; a separate `(provider × keyHashPrefix)` file would duplicate a ledger whose lifecycle already matches ("survives every reconnect until the operator lifts it");
- the client copy is deleted too (v2 `DELETE /api/credential/:id`, matched by `keyHashPrefix` — ONE row, never a set diff), because opencode routes from its own db and an OCR-only delete cannot stop it. v1 has no id-addressed delete (one key per provider in a plain file) and answers `unsupported`; the response reports the client half per target and the console says so instead of claiming a clean revocation. `?clientRevoke=0` opts out (retire the OCR row only).

Constraint for future work: a book-wide "mirror deletions into the client" reconciliation is still forbidden — an unreadable or degraded OCR book would read as "delete everything on the client". Deletions stay operator-initiated, one key material at a time.

### v1 client — verified scope

The v1 adapter is **fixture-verified, not binary-verified**: no opencode v1 install exists on the reference machine (only v2). What the test suite pins down deterministically:

- the written file keeps the v1 shape (one `api` entry per provider, `<dataDir>/auth.json`, 0600 best-effort) and **preserves everything we do not own** — other providers' entries byte-for-byte, unknown fields on the entry we rewrite (`account_id`, plus any future field), `oauth`/`wellknown` entries untouched and reported as `skipped`;
- the pre-write file is preserved as `auth.json.bak.ocr` before every converging write (no write ⇒ no backup), and the rename goes through `atomicWriteWithRetry` (Windows EPERM/EBUSY from a holding process retries instead of failing the push);
- presence: v1 evidence is an existing `auth.json` OR a v1 `installed.version` pin, and never on a machine with v2 evidence.

What remains **unverifiable without a v1 binary**, and must not be asserted as proven: that a real v1 runtime accepts the merged file; that Windows honors/ignores the 0600 intent; that v1 actually routes from `auth.json` (the premise of both directions); that `installed.version` exists on a pure-v1 install (an install with neither pin nor `auth.json` reads as absent — the adapter stays inert rather than guessing). Field vocabulary was cross-checked against the v1-importer strings embedded in the installed v2 binary (`account_id`, `methodID`, `wellknown`, `integration_id`) — evidence, not proof.

## Amendment — chain-head authority across the credential sync

The write direction already pushes the WHOLE chain per provider (v1 stays head-only by file shape). What was unhandled is which credential the client ROUTES with: opencode v2 makes a freshly connected credential the ACTIVE one (live-verified on 2.0.15 — adding a second key demotes the working row) and has no credential ordering beyond `active`. Three rules now govern the boundary:

- **Push restores the OCR head.** After a provider's keys have landed, the write path re-activates the credential whose `keyHashPrefix` matches the OCR chain head whenever the client's active row differs. This runs on every push, dedup-only sweeps included, so a client whose active row drifted self-heals; an already-correct head costs one view read and no HTTP call. It is the sync-path mirror of the console connect route's `headPreserved` defense — without it, pushing a newly added FALLBACK key silently re-points opencode at that key while OCR keeps routing the head.
- **Pull never overrides the OCR head.** The OCR file is the single truth and the pull is add-only, so a client-side activation cannot demote it; otherwise a pull would undo the operator's "set as chain head" whenever auto-write is off (the two-directions-fight this ADR refuses elsewhere). The client head only fills a VOID: a provider whose OCR rows all lost their active flag (the head row was disconnected) adopts the client's head instead of leaving routing on recency alone.
- **Relative order among non-active fallbacks is NOT synced, deliberately.** v2 exposes no order field (rows read `active DESC, time_updated DESC`) and the pull stamps imported rows with the pull's own timestamps, so the client's fallback sequence is not reproduced in the OCR file, nor the reverse. Only the ACTIVE head is authoritative across the boundary; standby order is a client-local read order, not a routing contract. Anyone changing that needs a real order representation on the OCR side (schema version bump), not more timestamp gaming.

Tests: `credentials-sync` pins both directions — a pushed fallback does not steal the head, a drifted head is healed on a dedup-only push, a pull keeps an existing OCR head, and a pull adopts the client head only when the OCR chain has no active row.

## Amendment — hot credential-chain refresh (2026-10-28)

The routing chain (`registry.credentialChains`) used to be a BOOT-ONLY snapshot: `buildDirectPool` → `registerProvider` was the single write point, so a credential added through the console (connect / activate / disconnect) or landed by a credential sync stayed invisible to `pipeline/credential-selection.ts` until the next gateway restart. With a multi-credential provider the new-session spread kept collapsing onto the boot-time chain — operationally: "every request uses the first credential" — because the selector saw `chain.length === 1` and degenerated to the head.

The chain is now HOT: `registry.refreshCredentialChain(name, chain)` swaps the entry wholesale (atomic Map put under Bun's single thread; in-flight requests keep serving on the old array reference) and is invoked at every store-mutation seam:

- console **connect** (`connectKeyIdempotent` — covers the create/setKey/connect routes),
- console **reorder** (the chain REORDERS — head = `ids[0]` via the store's `reorder`),
- console **disconnect** (the removed key leaves the live chain immediately),
- **credential sync run** (a pull can land keys on many providers; every connected provider's chain is refreshed).

Operator disable/enable is deliberately NOT a rebuild trigger: the disabled row stays in the chain and is filtered at selection time by `isPairOut` (takedown outranks every runtime signal; chain membership is orthogonal). An EMPTY chain deletes the entry — the provider degenerates to the head-baked path (`config.apiKey`), preserving the head === baked-key invariant.

RAW keys remain registry-only (never serialized). A store read failure during a rebuild is swallowed — the previous chain keeps serving (fail-open). The stale prose claiming "repeated connect grows the chain" in `console.ts` described a mechanism that no longer existed; the dedup there protects the store's keyHash identity, not a chain length.

Tests: `credentials-console-routes` pins the hot path — connect grows the live chain, reorder moves the head, disconnect removes the row, all without a restart.

## Amendment — operator surface: reorder replaces activate (2026-10-28)

The operator-facing mutation seam was a per-credential `POST …/credentials/:credentialId/activate` ("make active"). It is replaced by a whole-chain `POST …/providers/:id/credentials/reorder` with body `{ ids: string[] }` — `ids` MUST be a permutation of the provider's credential ids, and the chain head becomes `ids[0]`. `store.activate(credentialId)` remains on the `CredentialStore` interface (capability `activate` stays `true`) as the INTERNAL head primitive used by the credential-sync push (head restore) and the console connect route's `headPreserved` defense — it just no longer has a route.

OCR file schema version 2: the credentials.json ROW-ARRAY ORDER is now the authoritative chain order (index 0 = head). Version 1 files encoded order only as a derivation (active rows first, then `!active` by `timeUpdated` DESC); on read they are normalized IN MEMORY to that legacy derived order — never written back just for reading — and every mutation saves the file as version 2 with array order authoritative. `active` FOLLOWS POSITION 0 (`rows[0].active === true`, head's `timeUpdated` bumped), which keeps both prior invariants intact: Push/Pull head-authority semantics (§ "chain-head authority across the credential sync") and the opencode CLI pointer (opencode routes with its active row; the sync restores the OCR head by keyHash exactly as before). Standby ordering is now durable locally — the thing the earlier amendment said "needs a real order representation on the OCR side"; that representation is the v2 array.

`OpencodeV2Store` maps `reorder` to a HEAD-SET ONLY: the v2 service exposes no order field (its rows read `active DESC, time_updated DESC`), so reorder validates the id permutation and activates `ids[0]` (skipping the POST when that row is already active); standby order stays the service's local read order, per the existing amendment. `capabilities.reorder` is `writable` on the v2 store and `true` on the OCR store; the console route refuses with 400 `capability_unsupported` when the bound store cannot reorder.

Tests: `credentials-console-routes` pins the reorder route (head flip, refreshed inline list, capability/invalid-body refusals, unknown id 404); `credentials-ocr-store` pins the store primitive (permutation validation, `active` follows position 0, v1 normalization on read, version 2 on write); `credentials-opencode-v2-writes` pins the head-set degradation.

## Amendment — per-credential spread weight (2026-10-29)

The deterministic new-session spread (ADR-0002 §4) used to give every healthy row an equal hash slot. Operators with unequal per-key quotas (one key carries 5× the daily budget of another) had no lever: the split was always 1/N. Credentials now carry an optional integer `weight` (>= 1, absent = 1, ceiling `CREDENTIAL_WEIGHT_MAX` = 100 — single-sourced in `backend/src/config/defaults.ts`, mirrored in `frontend/src/lib/defaults.ts`).

- **Home**: the weight lives in the OCR file only (`OcrCredential.weight`, saved with schema version 2). The opencode v2 service exposes no weight/order field beyond `active`, so v2-bound rows always weigh 1: `capabilities.weight` is `true` on the OCR store and `false` on `OpencodeV2Store`, and the console route refuses with 400 `capability_unsupported` on a store without the capability (the reorder gate pattern). Weights never cross the sync boundary in either direction — the push/pull head-authority rules are untouched.
- **Operator surface**: `POST …/providers/:id/credentials/:credentialId/weight` with body `{ weight }`; the route validates an integer in `[1, CREDENTIAL_WEIGHT_MAX]` (400 `invalid_weight` otherwise), the store re-clamps on write, and the read path sanitizes hand-edited files (0/negative/fractional/non-numeric degrade to absent or floor/clamp — a bad file value can never poison the spread). The console Keys page edits the weight in the per-provider credential zoom dialog; the card rows show a read-only `×N` badge.
- **Placement semantics**: `weightedSpreadIndex` draws the SAME sha256(sessionId) slot, now in `[0, Σweights)`, and walks the weight prefix sums — a row weighing w occupies w consecutive slots. Uniform weights reproduce the pre-weight landing exactly (total === count), so existing sessions keep their slots. The weight shapes ONLY the new-session spread: the forced-failover landing stays chain-order priority, the keep/affinity rules never read it, and the ratchet is untouched (ADR-0011 overlay discipline).
- **Hot chain**: the weight rides `CallCredential.weight` end-to-end (`resolveKeyChain` → boot/`refreshProviderCredentialChain`), so a set-weight takes effect on the very next placement without a restart.

Tests: `credential-selection.test.ts` pins the weighted spread (uniform back-compat, slot mapping, proportionality smoke, failover-order precedence); `credentials-ocr-store.test.ts` pins set/clamp/sanitize and the chain/meta passthrough; `credentials-console-routes.test.ts` pins the route (200 shape, invalid-body 400s, unknown-id 404, masked-only wire).
