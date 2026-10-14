# ADR-0019: OpenCode opencode v2 Credential Adapter Layer — Version-Gated Stores, Account Identity Anchoring, and Cell-Level Failover

## Status

Proposed — 2026-10-13. Layer: system. Scope: credential reads/writes and account-level resilience. Domain: opencode-integration.

**Amended 2026-10-13** — Decision 10 (controlled credential reveal) adds the single sanctioned raw-key exception to Decision 1's "no management route ever receives raw secrets" rule, and softens Decision 8's "cannot re-export" premise (disconnect keeps its double confirmation, whose copy now names the reveal escape).

**Amended 2026-10-14 (rules)** — Decision 6 gains the `scope`-override contract of the circuit-breaker rules config ([ADR-0008 amendment](./0008-industrial-grade-circuit-breaker-and-health-management.md)): a per-rule blast-radius override replaces the classifier's diagnosed scope **after** credential attribution, and can never fabricate a pair space for a chain-less or single-credential provider.

**Amends ADR-0011 Decision 2** ("Direct credential reads: opencode.jsonc provider nodes + auth.json — the same source and same files as the daemon"). That premise died with OpenCode opencode v2: live credentials moved into the service's SQLite database and `auth.json` became a one-time migration snapshot. Decisions 1, 3–6 of ADR-0011 survive unchanged, including the OAuth exclusion boundary (this ADR does not route OAuth credentials). ADR-0002's "credentials never proliferate" remains the north star and is operationalized here as the push-only convergence rule (Decision 5). This record extends ADR-0008 (breaker key space gains an account dimension) and reuses the ADR-0006 session state facility for affinity (Decision 8).

## Context and Problem Statement

OpenCode opencode v2 (verified against `v2.0.15` on the operator's machine, 2026-10-13) changed both credential storage and provider configuration:

- **Storage.** Credentials live in `~/.local/share/opencode/opencode.db`, table `credential` (`id`, `integration_id`, `label`, `value` JSON — key-type entries are `{type:'key', key}`, OAuth entries `{type:'oauth', access, refresh, expires, methodID, metadata}` — `active` flag, `time_created/updated`). Multiple accounts per integration are real (observed: 4 records for `opencode`). opencode v2 imports the legacy `auth.json` **once** during its database migration and never writes that file back. Official guidance: "Do not edit the database to manage credentials."
- **API surface (live-probed on 2.0.15).** `POST /api/integration/{id}/connect/key`, `PATCH /api/credential/{id}`, `DELETE /api/credential/{id}`, `POST /api/credential/{id}/activate` exist and respond. The `GET/POST /api/credential` collection routes documented in opencode v2's API reference **404** — docs run ahead of the build. `GET /api/integration` returns per-integration `connections` as masked metadata only (`id`, `label`, `method`). **Raw keys are not exportable through any HTTP surface** — by design.
- **Config schema.** The provider node shape moved from opencode v1 `npm`/`options` to opencode v2 `name`/`env`/`package`/`canonical`/`settings`/`headers`/`body`. `~/.config/opencode/installed.version` lags reality (file says `2.0.0`, CLI says `v2.0.15`) and cannot be the sole version evidence.
- **Cache economics.** Upstream prompt caches are isolation-scoped: Anthropic per workspace (since 2026-02-05; per org on Bedrock/Vertex), OpenAI per org. Different accounts never share a cached prefix; a cross-account switch re-bills the whole prefix (Anthropic write at 1.25×, reads at 0.1×, default TTL since 2026-03-06 is 5 minutes). Stateful wires (OpenAI Responses `previous_response_id`) break functionally, not just economically, when the account changes.

The drift is already live on opencode v2 machines in both directions:

1. **OCR→opencode v2 dead writes.** OCR's console key management writes `auth.json` (`user-config.ts:setAuthApiKey`, reached from the `console.ts` key routes). After the one-time migration those writes are invisible to v2.
2. **opencode v2→OCR blind reads.** OCR's boot path (`boot-direct.ts:98` → `readAuthEntries()`) reads the stale `auth.json` snapshot; keys added or rotated in opencode v2 after migration never reach the routing pool, and rotated keys serve stale secrets (401 incidents of exactly the kind ADR-0011 set out to eradicate).
3. **Multi-account blindness.** Multiple credentials per provider are invisible to OCR; selection and failover have no account dimension.

**Problem.** OCR must read, write, and fail over credentials correctly against OpenCode opencode v2, OpenCode opencode v1, and installs where OpenCode is absent — without proliferating a second credential truth and without any silent degradation (ADR-0011's core rule).

## Decision Drivers

- ADR-0011: explicit exclusion with visible reasons; never silently degrade supply.
- ADR-0002: one credential truth — OCR may read and push, never fork.
- cp-dataloss: `disconnect` against a store that cannot export raw keys is irreversible; confirmation must be honest.
- ADR-0018's spirit: every path a test touches must be injectable; `OCR_HOME` alone does not sandbox opencode paths.
- Cache economics: account switching is forced failover, never load balancing.
- Reuse over rebuild: one breaker state machine (ADR-0008 class) with a finer key space beats a second, parallel health mechanism.

## Considered Options

| Option | Summary | Verdict |
| --- | --- | --- |
| A. Keep writing `auth.json`, expect opencode v2 to re-import | status quo | Rejected: opencode v2 imports once; every write is dead. |
| B. Route inference through the opencode v2 service and let it hold keys | reintroduce daemon execution | Rejected: ADR-0011 removed daemon delegation (lossy generate endpoint, rewriting hooks, inverted egress); and the opencode v2 API cannot export raw keys anyway. |
| C. OCR-owned credential copy as primary truth, sync both ways | standalone-friendly | Rejected: bidirectional sync conflicts and credential proliferation violate ADR-0002. |
| D. Three-store adapter factory with version-gated sticky binding; SQLite readonly reads + HTTP writes for opencode v2; one-shot reconcile of `auth.json`-only keys; key-hash account identity; pair-scope breakers (model x credential); session-affinity failover | — | **Chosen.** |

## Decision Outcome

Chosen option D, because it keeps opencode the single credential truth on opencode v2 machines while degrading honestly (loud, badged, never silently stale) when opencode v2 storage is unreachable, and because its single-key degeneracy leaves opencode v1 behavior byte-identical.

### 1. One `CredentialStore` interface, two adapters *(amended by Decision 11)*

- `OpencodeV2Store` — reads via `bun:sqlite` readonly on `opencode.db`; writes via the opencode v2 managed-service HTTP API (service discovery reuses `connector.ts`, which already resolves `~/.config/opencode/service.json` for Basic auth).
- ~~`OpencodeV1Store` — wraps the existing `auth.json` code path (`readAuthEntries`/`setAuthApiKey`/`removeAuthEntry`) unchanged.~~ **Removed by Decision 11**; `auth.json` survives only as a read-once migration source (`auth-snapshot.ts`).
- `OcrStore` — local file `~/.opencode-router/credentials.json` (global, mirroring opencode's own global credential scope; not per-environment), best-effort mode `0600`, secrets masked in every management API (existing `maskSecret` rule).
- Capability flags per store drive all UI and pool behavior: `multiAccount`, `activate`, `rename`, `oauth` (connect-only), `envVisible`. Callers branch on capabilities, never on `kind`.
- Method surface: `probe`, `listAccounts` (masked metadata), `resolveKey` (active-first, raw), `resolveKeyChain` (ordered pool, raw — for failover), `connectKey`, `beginOAuth`/`completeOAuth` (capability-gated), `activate`, `rename`, `disconnect(accountId)`, `revealKey(accountId)` (raw — Decision 10 only). Provider-wide disconnect is a UI-level loop over `disconnect`, not an interface primitive.
- `resolveKey`/`resolveKeyChain` are callable only by boot/pool-rebuild code; no management route ever receives raw secrets (ADR-0011 risk limb preserved) — the sole exception is the `revealKey` route bound by Decision 10.
- Inline `{env:VAR}` / `options.apiKey` in `opencode.jsonc` keep their existing priority ABOVE the store; the adapters own only the "store" segment.

### 2. Factory binds one store per boot, gated by version evidence

- Binding predicate: `opencode --version` (CLI) is primary; `installed.version` file is fallback when the CLI is not on PATH. File existence NEVER selects a store.
- Edges: opencode v2 machine → `OpencodeV2Store`. **opencode v2→opencode v1 fallback is forbidden** — on an opencode v2 machine `auth.json` is by definition a stale snapshot, and binding to it would silently serve old keys. opencode v2 detected but db unreadable (after retry, Decision 3) → bind `OcrStore` with a loud console badge ("opencode credential source unavailable") and route providers whose keys exist only in the db into the existing `excluded[]` with an explicit reason. ~~opencode v1 machine with unreadable `auth.json` → `OcrStore` + badge.~~ **opencode v1 machines → `OcrStore` + `unsupported_version` badge, snapshot imported once (Decision 11).** CLI absent but db present → **`OpencodeV2Store-readonly`** (routing works from db reads, all write operations disabled with reason). No opencode at all → `OcrStore` as the normal (unbadged) standalone shape.
- Binding is sticky for the process lifetime; re-probe happens at next boot. Last-known-good binding is persisted with hysteresis so PATH jitter between boots cannot ping-pong the store.
- On recovery (opencode v2 db readable again at next boot) OCR rebinds `OpencodeV2Store`; leftover `OcrStore` entries are surfaced as "local, not in opencode" with a one-shot **Push to opencode** action. Convergence is push-only: credentials flow toward opencode, never fork from it.

### 3. OpencodeV2Store internals: readonly SQLite reads, HTTP writes, WAL discipline

- Open readonly with `busy_timeout` and bounded retry; `SQLITE_BUSY`/`-shm` contention is retried, not misclassified as "db unreadable" (a false red badge that would wrongly rebind `OcrStore`). "Cannot open" and "credential table empty" are distinct states with distinct fallback semantics.
- Key selection from `credential` rows: `active=1` first, sole row next, else newest `time_updated`; `{type:'key'}` maps to OCR's internal `api` shape; `oauth` rows are listed and badged but never routed (ADR-0011 P2 boundary intact).
- Column existence is capability-probed at construction; a missing/renamed column is a loud bind failure for `OpencodeV2Store`, never a partial read.
- Write path: `connectKey`→`POST …/connect/key`; `activate`→`POST /api/credential/{id}/activate`; `rename`→`PATCH`; `disconnect`→`DELETE`. On write failure: re-read `service.json` (password rotation / port drift) and retry once; on second failure surface the error to the UI. **A write NEVER falls back to `OcrStore`** — read-side degradation is allowed (with badge), write-side proliferation is not.
- Read freshness: the store view carries a 60 s TTL and is invalidated by any console credential action, so a key revoked in opencode v2 does not linger in OCR's pool as a zombie that earns SUSPECT badges after deletion.

### 4. One-shot reconcile precedes the read-path flip (the anti-regression gate)

OCR has been writing `auth.json` through its own console (key routes in `console.ts`). On opencode v2 machines, keys added post-migration exist ONLY in `auth.json`. Flipping reads to the db without reconcile would turn those working providers into `excluded[]` on upgrade — a user-visible key loss.

- At first v2-bound boot: diff `auth.json`-only entries against db credentials (dedup by integration + label + key-hash), push matches through `connect/key`, then disable the `auth.json` write path permanently on that machine. `auth.json` itself is left on disk untouched (opencode's territory; OCR never deletes upstream files).
- The reconcile is idempotent and logged entry-by-entry; failures land in `excluded[]` with a "push failed, key present locally" reason, never silently dropped.

### 5. Account identity anchored on the key material, not on opencode row ids

opencode v2 credential row `id`s churn on reconnect/rename/upgrade, and labels are user-editable. OCR anchors all durable per-account state on `keyHash = sha256(raw key)`:

- Breaker pairs, session-affinity bindings, and SUSPECT flags are keyed by `keyHash` (within their provider scope). An id or label change preserves state; a key-material change resets it — which is exactly the correct semantics.
- Hashes are display-safe (prefix only), so logs and traces can name an account without touching secrets.
- Zombie-state reclamation is explicit for now: SUSPECT/takedown clears anchor on the pre-delete keyHash (Decision 6). Snapshot-wide grace-period GC over the persisted state is **deferred follow-up work** — accumulation scales with key-rotation rate (memory hygiene, not correctness); a DISABLED takedown deliberately surviving its row is Decision 6 semantics, not a zombie.

### 6. Credential-scoped resilience reuses the ADR-0008 state machine

- The breaker space is a models × credentials matrix; the vocabulary in code, config and console is the domain axes themselves — **model** (one model, every credential), **account** (one credential, every model), **pair** (one model × one credential). Breaker instances keyed `(modelId × keyHash)` — the Cartesian product inside one provider only. There is deliberately NO second, parallel "account cooldown machine": one breaker implementation, one finer key space.
- The error classifier gains `tripScope` on its diagnosis:
  - per-model 429 (RPM/TPM semantics, `Retry-After` honored) → **pair**;
  - account-quota 429/402 (daily/weekly-limit semantics) → **account** (all pairs of that credential);
  - confirmed-bad auth 401/403 after refresh attempts → **account** + account-level **SUSPECT** flag (administrative state, not breaker state: never auto-returns, cleared only by manual reconnect or Push);
  - 5xx/timeout/connection failure (upstream down, key-independent) → **model**;
  - unclassified → conservative default **pair** (under-cool rather than over-cool; retry naturally validates siblings).
- **A rule's `scope` override replaces that diagnosed blast radius — after attribution, never instead of it** (amended 2026-10-14 by the circuit-breaker rules config, [ADR-0008](./0008-industrial-grade-circuit-breaker-and-health-management.md)): `circuitBreaker.rules.trip.<rule>.scope: auto | pair | account | model` is read by the manager gate that expands a failure over the credential matrix, downstream of the attribution that produced the `keyHashPrefix`. `auto` keeps the scope the classifier diagnosed above; an explicit value replaces it for that rule's error class. An override cannot invent an axis it has nothing to scope on: with no `keyHashPrefix` (chain-less or single-credential providers) the diagnosis goes to the bare-modelId breaker whatever the rule says, so **no override may fabricate a pair space that does not exist** — the single-account degeneracy closing this Decision stands untouched. Because only the account expansion raises SUSPECT, an override that routes a 401 to a `pair` or `model` breaker trips without flagging: the flag stays on the account, where this Decision put it. For the counted classes (5xx / unknown / counted 400) the two statistical detectors share one recording decision point, so when both rows override, `trip.consecutiveFailures.scope` wins over `trip.failureRate.scope`.
- Model availability is a derived aggregate: a model is available iff its model breaker is capable AND it has ≥1 non-OPEN pair on a non-SUSPECT credential. All `canExecute(modelId)` read sites switch to the aggregate; the old "pool exhaustion bubbles to model-level" edge is unnecessary — the model goes OPEN pair-wise.
- Manual trip (`server.ts` trip endpoint) gains a scope parameter (model / account / pair).
- Health prober (ADR-0008) probes HALF_OPEN pairs with a bounded budget: one model never issues more than `rules.recovery.halfOpen.maxProbes` trial calls per cycle however many of its credentials are tripped (default `halfOpenMaxProbes` = 1, i.e. today's one representative probe; amended 2026-10-14 — the budget now rides the HALF_OPEN trial batch of ADR-0008).
- Single-account providers degrade to exactly today's behavior (no pairs ever created, aggregate = direct model read). opencode v1 users see no state changes.

**Vocabulary (binding for code, wire, and UI — one referent, two roles):**
- **account** — the operator-manageable IDENTITY of one provider credential: anchored on `keyHash = sha256(raw key)`, owning the SUSPECT flag, session-affinity bindings, and console rows. The wire/`TripScope` value `'account'` scopes a trip to one account across every model.
- **credential** — the KEY MATERIAL and its runtime carrier (`CallCredential`, the registry's credential chains); also opencode's own word (the v2 SQLite table is literally `credential`) and the word the console UI shows operators (en-US "credential", mirrored in zh-CN). `CredentialStore` = the repository of credentials, keeping this prefix by doctrine.
- **pair** — the `(model × account)` circuit-breaker scope (code/wire spelling); the console renders it as "model × credential". Unrelated to the capture domain's request/response pairing.

### 7. Session affinity: switching is forced failover, never balancing

- First routing of a session binds it to one account (`session → keyHash`), stored in the existing ADR-0006 session state. The binding holds while its pair is available; selection NEVER re-balances healthy bindings ("pick the least-used key" is banned).
- **No switch-back**: after a forced move K1→K2, K2 stays even when K1 recovers (the prefix lives where the traffic went). A later move happens only on another forced failure.
- The binding's natural expiry is the provider cache-TTL window (Anthropic default 5 min, 2026-03-06; OpenAI load-dependent): a session idle past the window is re-selected as if new, because the cache is gone anyway.
- Load spreading is applied ONLY to new sessions: deterministic `hash(sessionId)` across healthy accounts (cold prefix = nothing to lose).
- Isolation-domain awareness: credentials carry an org/workspace fingerprint (probed at connect, operator-editable when unavailable). Switches inside one isolation domain are cache-cheap and unrestricted; cross-domain switches follow the stickiness rules above. Stateful wires (Responses `previous_response_id`) pin the account for the thread's life — switching is a hard functional break, not a cost trade.
- Where the wire supports it, OCR sends a stable `prompt_cache_key = sessionId` so intra-account routing hits the same upstream cache partition.

### 8. Destructive operations on the single truth

`disconnect` deletes the store's copy of a credential. Since Decision 10 the operator CAN export the key first (password-gated reveal), so the confirmation copy names that escape instead of claiming "cannot export"; the gesture itself remains irreversible from opencode's side. No "backup copy into OcrStore" mitigation is allowed — that would be proliferation dressed as safety (ADR-0002).

### 9. Provider-definition parsing follows the credential flip

The opencode v2 provider shape (`package`/`settings`/`env`/`canonical`) is **read**-normalized in the same phase as the credential source flip — otherwise db credentials resolve while v2-shaped provider defs fail parsing, reproducing `excluded[]` through the config door. Writing v2-shaped defs (for opencode v2 users) is deferred; OCR's own parser and `wireFor` accept both `@ai-sdk/*` (opencode v1) and `@opencode/ai/providers/*` (opencode v2) package forms.

### 10. Controlled credential reveal (operator re-auth) — amendment

**Requested and accepted by the operator, 2026-10-13.** Decision 1's blanket "no management route ever receives raw secrets" is relaxed to exactly one export path: `POST /api/admin/opencode/providers/:id/accounts/:accountId/reveal` returns the raw key of the addressed row to the console's copy action. The ADR Context fact it cuts against — "raw keys are not exportable through any HTTP surface" — describes opencode's own API; OCR's local readonly db/file reads CAN export, and this Decision governs whether they may reach the operator.

Gates (all four are part of the contract; dropping any one voids the amendment):

1. **Re-auth with the console login password** (`webAuth.passwordHash`, scrypt-verified). The password is a secret the browser does NOT hold after login — the session rides an HttpOnly cookie — so re-entry is a genuine second factor against a hijacked/unattended console session, unlike re-typing a token the page already carries. Operator-accepted relaxation (2026-10-13): the console may hold the FIRST deliberately-entered password in a page-memory ref for the page's lifetime — never storage, never the DOM, gone on reload — replaying it for later one-click reveals; a 401 takes the unlock away. Where webAuth is not active (loopback, no password configured) there is nothing to confirm against: the route refuses `409 webauth_required` and the UI keeps the copy affordance disabled with a visible reason.
2. **Shared login throttle.** A wrong reveal password calls `recordLoginFailure(ip)` on the same per-IP exponential lockout bucket as `/auth/login`; a correct one clears it. The reveal route is therefore never cheaper to guess through than the login itself.
3. **Password-first ordering, POST-only, no-store.** Verification happens before any store read (no pre-auth account enumeration); the key never enters URLs, GET surfaces, caches, or logs; the response is `Cache-Control: no-store` and the raw key is present in no list/status payload.
4. **Raw api-key rows only.** `revealKey(accountId)` throws `CapabilityUnsupportedError` for oauth/wellknown/empty-key rows — the ADR-0011 OAuth boundary survives the amendment untouched.

The interface gains `revealKey(accountId)` as a distinct method rather than an alias of `resolveKey`: it addresses the exact row the operator named (no active-first/sole-row/newest selection), keeping `resolveKey`'s boot/pool-rebuild-only rule intact for everything else. The frontend contract is equally narrow: the reveal response passes straight into the clipboard and exists in no component state, DOM text, or toast (the held unlock is a PASSWORD ref, not key material); the clipboard fallback (`execCommand`) stays reachable on LAN http binds, which are precisely the ones that force webAuth on.

Accepted cost: the clipboard is outside every gate above — once copied, the key proliferates as far as the operator's OS carries it. This is re-framed from "system exposure" to "informed operator action" by the password ritual and the dialog's warning copy; it is the residual risk the amendment knowingly accepts. `AGENTS.md`'s credential paragraph (resolveKey/resolveKeyChain = boot/pool callers) reads with this Decision as its one exception.

### 11. opencode v1 support removed; one def shape, one slot — amendment

**Requested and accepted by the operator, 2026-10-13 (pre-release, v0.0.1).** The v1
store, the v1 write shape, and every "legacy compatibility" branch are deleted rather
than maintained. Rationale: OCR is pre-1.0 with no install base to protect, and the
dual shape/slot system had already produced a silent-failure class (below) that costs
more to maintain than the compatibility it bought.

Removed:

- `OpencodeV1Store` (and `StoreKind`/`StoreDegradedCode` values `opencode-v1` / `auth_unreadable`). `auth.json` is now read ONCE as a migration source (`auth-snapshot.ts`, readonly) and never written by OCR — closing Decision 4's drift #1 by deleting the writer instead of gating it.
- `CustomProviderDef.generation`, `OpencodeDefGeneration`, and the per-binding shape selector in `console.ts`.
- Reads of the retired singular `provider` slot in `opencode.jsonc`, including the CLI hook (`cli/clients/opencode.ts`), which now writes `providers` with the v2 node shape and retires any old-slot twin it finds during setup/teardown.
- Read tolerance for the retired node shape (`npm`/`options`) inside `providers` — see the symmetric refusal below.

The rule that replaced them, and the failure it prevents: opencode's normalizer picks the provider decoder **by slot**, not by version — `providers` is validated against the v2 schema, the retired `provider` against the v1 schema (upstream `ConfigNormalize.migrateProviders`). OCR was writing **v2-shaped content into the v1 slot**, where one type-enforced key (`models.<id>.variants` as an array) failed the v1 decode and the whole provider node was dropped — while the credential rows imported from `auth.json` kept routing. Net symptom: a provider that tests green, appears healthy, and silently refuses every credential write because upstream no longer registers it as an integration.

- Write side: one shape, one home — v2 node into `providers`. `upsertCustomProvider` refuses a legacy-shaped node (`legacyShapedProviderPaths`) rather than writing content upstream would drop. The guard is NODE-level (`npm`/`options`) only: model defs keep the models.dev file spelling in both generations — verified against the config decoder embedded in v2.0.15, keyed `variants`, flat `cost.cache_read/cache_write`, and model-level `provider.npm` are current FILE keys (the nested/array forms are opencode's internal domain shape, produced by its own read-time conversion) — and `upsertProviderModel` passes them through verbatim. An earlier revision of this guard refused those model keys as "legacy-shaped"; that was a mis-refusal which broke every cache-priced model on pull and editor save, and it is removed.
- Write ordering on the provider-create route: the **def lands first**, then the key is pushed, then the store view is invalidated. The integration registry answers from the def node, so key-first ordering made first-time creation of any new custom id unconditionally 409 (and the old test hid it by pre-seeding the id under creation into the mock registry). On key-push failure the node written by that same request is rolled back; a pre-existing node is kept, because its def is valid and the operator can add the key afterwards.
- Read side: `{env:VAR}` credentials are stored as v2's `env: ["NAME"]` name list; `normalizeProviderDef` now materializes the first resolving name back into the `{env:X}` template, so inline precedence (Decision 1's last bullet) survives the shape change instead of silently reading as "no credential".
- Read side, symmetric refusal: a **retired-shape node inside `providers` is dropped rather than normalized**, using the same guard the writer refuses with (`legacyShapedProviderPaths`) — reader and writer accept exactly one shape, so no node can be "OCR-routable but upstream-invalid", which is the same divergence class in its other half (opencode decodes `providers` against the v2 schema and discards the whole node on `kind=invalid`). The drop is reported, never silent: `legacyShapedSlotEntries()` names each refused id with its offending paths and `buildDirectPool` emits it into `excluded[]` with a migrate-hint reason. A refused node can still be deleted (`deleteCustomProvider` checks the raw slot) and re-created in the v2 shape, which is the intended migration.
- opencode v1 detected at bind → `OcrStore` + `unsupported_version` badge, with the `auth.json` snapshot imported once so nothing that previously routed goes silent (ADR-0011).

Accepted cost: an operator on opencode 1.x gets a loud badge and an OCR-owned credential store rather than shared truth; files holding the retired `provider` slot must be moved to `providers` (one-time, manual at this stage). Tests that asserted v1 byte-identity are deleted, not ported.

**Degradation contract on an opencode v1 machine** (what "unsupported" concretely means — documented in `README.md` / `README.zh-CN.md` Requirements and surfaced as `degradedCode: 'unsupported_version'`):

| Concern | Behavior |
| --- | --- |
| Boot / gateway routing | Unaffected. OCR serves its own pool from `OcrStore`. |
| Credential writes | Land in `~/.opencode-router/credentials.json`. **opencode v1 reads only `auth.json`, so it never sees them** — the keys serve OCR, not the local opencode session. |
| Provider defs | Written to `providers` (v2 slot). opencode v1 reads `provider` (singular), so a provider OCR defines is invisible to that opencode. Deliberate: no v1 write shape is maintained. |
| `auth.json` | Never read after the one-shot import at the bind that first lands on `OcrStore`; never written, ever. |
| Remedy | Upgrade opencode to v2 → the bind picks `OpencodeV2Store`, defs and keys become shared truth (with **Push to opencode** converging the local store). |

### Delivery phases

| Phase | Content | Gate |
| --- | --- | --- |
| P0 | This ADR accepted; `AGENTS.md` opencode-config line and the two stale `.ocp/memory` entries (auth.json-as-truth) updated in the P1 commit; zh-CN mirror optional backlog | human accept |
| P1 | Adapter layer: interface, three stores, factory + binding states, WAL discipline, reconcile, v2-schema provider parsing (read side), consumer switch (`boot-direct.ts`, `auto-pull.ts`, `probe.ts`, `console.ts`), path injection for tests, fixtures (fake sqlite db + HTTP mock), i18n strings | release gate: P1+P2 together |
| P2 | Write path via HTTP sinks (`connectKey`/`activate`/`rename`/`disconnect` + confirmations), console status badge for bound store | stop-the-bleed loop ships here |
| P3 | Account UI (multi-account list with keyHash short-id + cooldown state), pair breakers + `tripScope`, SUSPECT lifecycle, session affinity + TTL expiry, new-session spreading; guardrails grid renders the full (model × credential) matrix via the additive `circuitBreakers.pairs` + `credentialHashes` blocks on `/api/admin/status` (model-only counts stay as every existing consumer reads them) | ~independent follow-up |
| P4 | Write v2-shaped provider defs; retire opencode v1 write shape for opencode v2 machines | **CLOSED by Decision 11** — one shape AND one slot for every binding |

Effort: P1+P2 ≈ 5 person-days (release gate), P3 ≈ 3, P4 ≈ 1 — 8–10 days total including fixtures, i18n and doc tails (re-estimated upward from the first-draft 5–6 after red-team review; see Consequences).

## Consequences

Positive:

- Both live drift directions close: OCR console writes become visible to opencode v2 (HTTP), v2-managed keys become visible to OCR (db reads), stale-key 401s die with the auth.json snapshot dependency.
- Multi-account becomes a first-class OCR feature with correct economics: availability failover without cache self-harm.
- The no-pair degeneracy keeps opencode v1 machines byte-identical to today — zero-risk path for existing users.
- One breaker implementation, one identity anchor, one store seam: no parallel state machines to reconcile.
- Tests become honest: injected db/config paths + fixture dbs replace accidental operator-home access.

Negative / accepted:

- OCR now depends on an **undocumented, version-unstable** SQLite schema (readonly). Mitigated by column capability-probing and loud fallback — but upstream can still break reads with an opencode v2 point release; the OcrStore-with-badge degradation is the designed landing.
- The write path depends on routes the opencode v2 docs label *Experimental*; the 2.0.15 build already lacks the documented credential-collection routes. Mitigated by binding every write to live-probed routes only.
- Breaker state space is a matrix (models × credentials) — the console breaker view grows; probe budget bounded per model.
- Reconcile pushes keys that opencode will now hold — after the one-shot, removing a key means using opencode v2 (or OCR's disconnect with its honest confirmation), not deleting a line in `auth.json`.
- A maintenance tail for `OpencodeV1Store` persists until the installed base moves off opencode v1.
- First-draft effort (5–6 d) was ~40% low: reconcile, fixture matrix, WAL handling, idempotent push and i18n are real work (red-team #1/#2/#10).
- Decision 10's reveal route is the single raw-key egress in the management surface — password-gated, throttled, never a list field, but clipboard proliferation after a deliberate copy is outside the gateway's control (knowingly accepted).

## Design provenance

A red-team review (`@advisor`, 2026-10-13, verdict HOLDS WITH CAVEATS) shaped the final clauses: auth.json write-side regression → Decision 4's reconcile gate; unsandboxable homedir paths → injected paths; credentialId drift across id/label churn → Decision 5's keyHash anchor; WAL false-unreadable → Decision 3's busy_timeout/retry split; write fallback = proliferation → Decision 3's "read degrades, write refuses"; post-boot key revocation → Decision 3's TTL+invalidation; version-evidence flip-flop → Decision 2's persisted last-known-good + `OpencodeV2Store-readonly`; provider-schema sequencing (P4→P1) → Decision 9; irreversible disconnect → Decision 8; non-idempotent push → Decision 4's dedup. Session affinity (Decision 7) came from the operator's cache-economics challenge; the credential-scoped (cell) breaker (Decision 6) replaced this record's first two-layer design on the operator's objection — the finer ground truth is per (account, model) limit scope.

## Migration plan

Nothing is asked of operators. Upgrading OCR on an opencode v2 machine: first boot probes version → binds `OpencodeV2Store` → runs the idempotent reconcile (auth.json-only keys pushed to opencode, dedup-checked) → shows the bound-store badge. On an opencode v1 machine: binding is `OpencodeV1Store`, code paths are the current ones, no user-visible change until the multi-account UI appears. Operators without opencode installed land on `OcrStore` and see it named plainly in the console.
