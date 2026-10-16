# ADR-0006: Credential Store — Two Adapters behind Capability Flags, Identity Anchored on the Key Hash, Push-Only Convergence

## Status

Implemented — 2026-10-15 (facts-side corpus rewrite). Scope: where credentials live, how the gateway reads/writes them, what identity state hangs on a key, and which write paths are refused. Consumers: boot chains = ADR-0005; breaker/affinity anchoring = ADR-0004/0002.

Fact correction up front: the historical corpus described three stores including an "OpencodeV1Store". That shape no longer exists: `StoreKind = 'opencode-v2' | 'opencode-v2-readonly' | 'ocr'` (`credentials/types.ts:23`) — **two adapters plus a readonly variant of one**; `auth.json` is a read-only migration/import source and never a live store.

## Decision

### 1. One capability-flagged interface; branch on capability, never on kind

`CredentialStore`: `probe / listAccounts / resolveKey / resolveKeyChain / revealKey / connectKey / activate / rename / disconnect / beginOAuth / completeOAuth / listIntegrationIds? / invalidate? / accountsOverview?` (`types.ts:164-219`) behind `StoreCapabilities = {multiAccount, activate, rename, oauth, envVisible, integrationScoped}` (`:30-55`). Hard rule: callers branch on `capabilities`, NEVER on `kind` (`:10-11,22-23`). Typed failure vocabulary (`StoreUnreadable / EmptyCredentialTable / CapabilityUnsupported / WriteFailed / IntegrationUnmatched / AccountNotFound`), prototype-pollution provider ids rejected (`RESERVED_PROVIDER_IDS`). Raw keys leave the store through exactly four doors: `resolveKey/resolveKeyChain` (boot/pool consumers only), `revealKey` (password-gated console route), the store's own HTTP writes, and nothing else.

### 2. OpencodeV2Store — readonly SQLite reads, HTTP-only writes, strict target policy

- Reads: `bun:sqlite` **readonly** on `<dataDir>/opencode.db`, table `credential`, required-column check (missing column = loud `schema_mismatch`); NEVER a DB write — managing credentials by editing the database is explicitly the upstream's rule, violated never (`opencode-v2-store.ts:30-31,49-73`). View cache 60 s + `invalidate()`; empty table = typed `EmptyCredentialTableError`.
- Writes: pure HTTP against the hosted management service — `POST /api/integration/{id}/connect/key`, `POST /api/credential/{id}/activate`, `PATCH /api/credential/{id}`, `DELETE /api/credential/{id}`, `GET /api/integration`, plus `POST /api/location/reload` as the unknown-integration-id SELF-HEAL. Collection-style `GET/POST /api/credential` deliberately unused (404 on real builds — empirical, documented at the API table `:82-84`). `connectKey` VERIFIES landing (polls sqlite for the row, one retry; never fabricates a synthetic-id success).
- Service discovery: `OPENCODE_SERVER_URL`/`OPENCODE_SERVER_PASSWORD` env or `service.json`; Basic auth; **target policy `loopback | remote_tls | insecure_remote`** — non-loopback plaintext HTTP refused BEFORE the fetch, no opt-in knob (`:169-177,827-831`).
- The readonly variant (`db-present` evidence but no CLI to write through): same reads incl. local `revealKey`; every write throws `CapabilityUnsupportedError('…','cli-absent-db-present')` → console maps 409 `store_readonly`.

### 3. OcrStore — the standalone/degraded local store

`<ocrHome>/credentials.json` — deliberately GLOBAL (survives environment churn; contrast breaker memory per-env, ADR-0004). `{version:1, providers:{id:[{label,keyHash?,active,…}]}}`, atomic temp+rename 0600, first key active, empty providers pruned. Legitimate PRIMARY store on machines without opencode (normal, NO degraded badge — the factory no-ops there) and the loud fallback store otherwise (`degradedCode: db_unreadable | unsupported_version`). It has no auth.json write path, ever.

### 4. auth.json — import source, never a sink

`AuthSnapshot.read()` only (`auth-snapshot.ts`): opencode v2 imports the file once during its own db migration and never writes it back ⇒ on a v2 machine auth.json is BY DEFINITION a stale one-time snapshot. Consequence chain: v2 store unreadable ⇒ degrade to OcrStore with badge + per-provider exclusion report — falling back to auth.json would silently route old credentials (forbidden); OCR never writes auth.json; standalone import (below) leaves the file byte-identical.

### 5. Factory — evidence ladder, per-boot sticky binding, never rejects boot

`bindCredentialStoreOnce` evidence priority (`factory.ts:500-541`): ① CLI `opencode --version` ② `installed.version` CONTENT parse (file presence alone NEVER selects a store) ③ `last-known-good` hysteresis (PATH jitter must not ping-pong stores mid-life) ④ `db-present` (CLI absent + db present IS opencode evidence) ⑤ none. `isV2 = db-present ∨ major ≥ 2`; `writable = CLI evidence` (db-present ⇒ readonly variant). v1 detected ⇒ NOT SUPPORTED ⇒ OcrStore + badge + one-time **standalone auth.json import** (type:api keys only, oauth/wellknown listed-not-imported, source untouched, failed entries re-attempted next boot via withheld marker). No opencode at all ⇒ OcrStore silently. Any bind crash ⇒ OcrStore + `bind_failed` badge — `bindCredentialStore` never rejects. Binding is STICKY per boot (in-process cache; re-probe happens at next boot). Durable state: `<ocrHome>/credential-store.json` `{bound, version, evidence, degradedCode, reconcile?, standaloneImport?}` (atomic, Windows-EPERM backoff).

### 6. Push-only convergence — the single-truth operationalized

- **Reconcile** (before the store-backed read flip): first writable-v2 bind without a completion marker ⇒ push auth.json-only `type:api` keys into the v2 db via `connectKey` — case-insensitive provider × keyHash dedup, **hash primary / label advisory**, oauth-shaped rows never pushed; gate checks capabilities (`envVisible ∧ activate` is the writable-v2 signature — readonly cannot push and the gate WAITS for a writable bind); auth.json is never modified/deleted (`reconcile.ts`). Completion writes the marker AND `authWriteDisabled:true` — set even when some pushes failed (anti-regression: "no future auth.json writes on this machine"; in-process override covers marker-write failure).
- **Push** (recovery convergence, `push.ts`, route `POST /api/admin/credential-store/push`): OcrStore-bound machine with opencode recovered ⇒ one-way copy of local keys into v2; a local row is deleted ONLY after verified convergence (failure keeps the local copy); converged `(provider, keyHashPrefix)` accounts get SUSPECT cleared (DISABLED deliberately persists).
- **Write discipline**: "read-side degradation is allowed with a badge; write-side proliferation is refused" — no fallback branch anywhere: `WriteFailedError`→502 `write_failed`, `CapabilityUnsupportedError`→409 `store_readonly` (`console.ts:408-434`). Console add-key is idempotent (same keyHash ⇒ `deduped:true`, old head position kept unless suspect/disabled).

### 7. Account identity — sha256(rawKey), display-safe prefix

`sha256KeyHash` + `keyHashPrefix(rawKey, 12)` (`types.ts:287-295`): the key HASH IS the durable account identity — survives label edits, credential-row id churn, provider renames; console/UIs see only the 12-char prefix, never key material. State anchored on it: pair breakers `(model × prefix)`, SUSPECT/DISABLED flags `(provider × prefix)` (opposite lifecycles per ADR-0004), session affinity binds (ADR-0002), per-account health/rate-limit subjects. `disconnect` honors an explicit DELETE (the irreversible double-confirm lives in the console UI, not the backend); the anchor captured pre-delete clears SUSPECT for that account, while its DISABLED flag intentionally survives — a takedown stays taken down if the same key returns.

### 8. OAuth boundary

No store claims OAuth (`oauth:false`, `begin/completeOAuth` throw); oauth/wellknown rows are listed-and-badged, never routed, never reconciled/imported/pushed; reveal refuses rows without raw api-key material. OAuth credential lifecycle stays with the upstream service — OCR routes around it, never through it.

### 9. Boot and console surface

Boot order: bind store → status → `ensureReconciled` → `buildDirectPool` (chains registered in-process, ADR-0005). Console: masked `AccountMeta` views + `AccountHealth` overlay (suspect / openPairs / cooldown / disabled+reason / limits / `quota` — the quota-plane view, ADR-0009 §9) attached to EVERY account-returning response; store status route returns capabilities, degraded code, reconcile audit, integrations (when scoped). Reveal route = four hard gates: webAuth active, shared brute-force bucket, password verified BEFORE store touch, api-key rows only. Frontend `api.ts` mirrors these wire names 1:1 (repo convention).

## Consequences

- Credential state machines are readable without any writable path; every convergence direction is push-only and verified, so keys cannot proliferate across stores silently.
- Identity anchored on key material (not ids/labels) makes breaker/suspect/affinity history survive upstream churn.
- Tests: `credentials*`, `user-config*`, `factory/reconcile/push` suites, `guardrails*`.
