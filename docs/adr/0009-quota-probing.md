# ADR-0009: Quota Tracking — Layered Knowledge, Declarative Probing with Banned Classes, Credential-Anchored Activation

## Status

Implemented — 2026-10-15. Scope: how the gateway learns and displays the remaining allowance of every (providerId × keyHashPrefix) pair, what a probe may look like, where probe knowledge lives, what a probe failure may and may not do, and which surfaces consume it. Credential identity / key-exit discipline = ADR-0006; breaker vocabulary = ADR-0004; environment layout = ADR-0007; trace attribution = ADR-0005/0008.

## Decision

### 1. The principle: coverage follows the release, activation follows the credentials

Quota state is tracked per **(providerId, keyHashPrefix)** pair — the same display-safe credential identity pair breakers and account flags anchor on (ADR-0006 §6). Two decoupled axes:

- **Coverage** — which providers *can* be probed — ships with the release (built-in table §3 + built-in code adapters §4) or with the operator's config (§5). It never snapshots the current account pool: account sets churn daily; the knowledge of a provider's quota endpoint does not.
- **Activation** — whether a probe is actually scheduled — follows credentials: a covered provider whose credential appears anywhere in the bound store (or the config-baked inference key, chain-less degeneracy) is armed automatically on the next scheduler pass. No account-pool enumeration ever gates coverage.

The quota plane is **display-only**: a declared or probed cap never gates routing. Configuration staleness must not evict a healthy pair; takedowns stay owned by the breaker plane (below), which acts on *inference-side* evidence, not on probe-side aggregates.

### 2. Data model

```
QuotaSnapshot { providerId, keyHashPrefix, windows[], plan?, source, verifiedAt, entryId, lastFailureAt? }
QuotaWindow   { name, used, total, remainingPct, resetAt, unlimited }
source ∈ probed | measured | declared | forked
badge  ∈ probed | declared | unverified | stale        (console-visible four states)
```

Known lossy by design in v1 (accepted, recorded here rather than modeled): per-window `currency` / `isCreditBalance` (multi-currency prepaid balances flatten to a credit-pool window: `used 0 / total = live balance`), and recurring-window metadata. `measured` is the reserved provenance of the phase-2 header-harvest layer (L-a below); `declared` is reserved for static plan-cap knowledge. Badge mapping: no snapshot → `unverified`; `declared` source → `declared`; last attempt failed or older than the entry cacheTtl → `stale`; else `probed`.

Storage discipline: snapshots are credential-anchored display-safe aggregates, so they live at the **GLOBAL** state root (`<OCR_HOME>/quota-snapshots.json`, atomic temp+rename 0600, load-once, debounced save — the suspect/disabled flags precedent, ADR-0006 §7), *not* the per-env book-set: an account's quota belongs to the account wherever it is used. Key material never enters the file (prefixes and numbers only). The **last raw probe exchange** (url/status/parsed body — never response headers, oversized or non-JSON bodies truncated to text) is a MEMORY-ONLY side table on the same store and is never serialized: it feeds the console's per-pair "inspect last probe" dialog and starts empty after a restart.

### 3. L-b: the built-in declaration table (DSL-driven, ships with the release)

Provider endpoints differ along at least six axes (auth header form, error semantics, value types, currency source, window granularity, naming) — there is no standard. A per-provider if-chain would rot; the table is **declarative**, interpreted by one engine (`quota/dsl.ts`). Every entry: one provider (OCR **catalog** provider id — keys were cross-checked against `catalog/ocr.json`; foreign id namespaces are not adopted), one URL, GET, static headers, a window-extraction table.

Host + auth disclosure (the table is trusted release code; absolute URLs and non-inference headers are permitted for built-ins — each choice named here):

| Entry (providerId) | Probe URL | Auth header | Inference origin (catalog) |
| :--- | :--- | :--- | :--- |
| deepseek | `https://api.deepseek.com/user/balance` | `Bearer` (inference) | api.deepseek.com ✓ |
| openrouter | `https://openrouter.ai/api/v1/key` | `Bearer` (inference) | openrouter.ai/api/v1 ✓ |
| vercel | `https://ai-gateway.vercel.sh/v1/credits` | `Bearer` (inference) | gateway vercel.sh origin (catalog `vercel` carries no api field; endpoint per official REST docs) |
| zhipuai | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `Bearer` (inference) | open.bigmodel.cn ✓ (dual-domain provider; the international api.z.ai mirror deliberately NOT used — the catalog pins open.bigmodel.cn) |
| zhipuai-coding-plan | same monitor endpoint | `Bearer` (inference) | open.bigmodel.cn ✓ |
| kimi-code-plan-cn | `https://api.kimi.com/coding/v1/usages` | **`x-api-key`** — the endpoint's documented key header; differs from the inference `Bearer` form, disclosed here as required | api.kimi.com ✓ |
| opencode | `https://opencode.ai/zen/v1/usage` (Zen face) | `Bearer` (inference) | opencode.ai ✓ (inference base `/inference/v1`; the usage face lives under `/zen/v1` on the same host) |
| opencode-go | `https://opencode.ai/zen/go/v1/usage` | `Bearer` (inference) | opencode.ai ✓ |
| moonshotai | `https://api.moonshot.ai/v1/users/me/balance` | `Bearer` (inference) | api.moonshot.ai ✓ (credit-pool balance flattened per §2: `used 0 / total = live balance`; cash/voucher split not modeled in v1; raw name, no nameCode — the static form carries no nameArg) |
| moonshotai-cn | `https://api.moonshot.cn/v1/users/me/balance` | `Bearer` (inference) | api.moonshot.cn ✓ (same flattening and naming notes as `moonshotai`) |

Cross-check rule (applied before an entry ships): find the provider in `catalog/ocr.json` → verify the quota endpoint's origin belongs to the same provider's own domain → only then table it. Providers failing the check (e.g. `qoder` — not in the OCR catalog at all) are excluded.

### 4. L-c: built-in code adapters (one file per provider)

Providers whose semantics cannot be expressed declaratively land as code adapters (`quota/adapters/`, mirroring `providers/`). v1 ships exactly one: **MiniMax** (`minimax`, `minimax-cn`, `minimax-coding-plan`, `minimax-cn-coding-plan`). Reason: a two-URL fallback chain whose members carry **inverted count semantics** (counts on a `/coding_plan/` endpoint read as REMAINING, on `/token_plan/` as USED) plus relative-vs-absolute reset fields and percent-only shared buckets — "per-URL inverted mapping" is a banned table class (§6), and an entry is one URL by iron rule. Adapter facts (URL order per region, envelope `base_resp.status_code`, snake/camel field pairs, fallback triggers 404/405/5xx, key-invalid verdicts 401/403/1004) were **self-recorded into the adapter's header fact sheet before implementation**; the code follows the sheet, not the reference project. Backlog (named, deferred): Copilot / Zed / Kimi-OAuth channels — their auth requires minting or device flows (not an inference-shaped header), so they can never enter the config table either; adapters only, when demanded.

### 5. L-a and L-d: the reserved harvest layer and the operator table

- **L-a (phase 2, data plane reserved only):** `x-ratelimit-*` headers harvested from inference responses (the capture plane preserves response-header NAMES and redacts only credential-shaped values, so the `x-ratelimit-*` trio survives capture — ADR-0008 §5) ride the per-turn attribution that landed in `ExecutionTrace.execution.accountKeyHashPrefix` (step-1 foundation: orchestrator stamps the SERVED credential — the same chain-head degeneracy as the ratelimit account subject; SQLite needs no DDL because trace rows are JSON blobs and old rows replay the field as `undefined`, the `clientHeaders` forward-compat precedent). Nothing writes `source: measured` yet.
- **L-d (`quotaProbes:` in config.yaml):** long-tail and self-hosted gateways (and explicit forks of built-ins). Operator entries are constrained by the iron rules below — they are the ONLY layer they bind (built-in code and the release table are trusted, with §3/§4 disclosure instead).

### 6. The DSL: twelve constructs, five banned classes

Constructs (each resolvable without computation): windows in three forms (static named / `each` over an array / `eachObject` over a keyed map); `firstOf` candidate paths; the **2-of-3 derivation** (any two of used/total/remaining imply the third); `invert` against a constant; `scale` (ratio → percent); `where` gates (**presence / equality / membership only**); name resolution by pure `{field}` interpolation + literal `enumMap` (+ fallback), carrying an optional opaque i18n identity (`enumCode`/`code`/`argPath` and window-level `nameCode` → snapshot `nameCode`/`nameArg` — codes the console's translation table maps to localized labels, never computation); a static headers block; `successIf` (single equality against a body field); `unlimited` (literal or boolean path); `source: headers`; time parsing (epoch seconds/millis by magnitude, ISO, date-only). Absent-total degeneracy ("no stated cap") is a PRESENCE rule, not a value predicate.

**Banned classes** (rejection is structural — the schema has no way to spell them — and the loader additionally rejects unknown keys so nothing smuggles in; a violating entry is dropped WHOLE, loudly):

1. arithmetic expressions (no `+ - * /`, no computed fields — literals and paths only);
2. cross-call data injection (stateless per-response resolution; no inputs from previous calls or other pairs);
3. value comparison / regex / time-delta predicates (`where` accepts `exists` / `eq` / `in` — nothing else; "exists may be selected, value conditions may not" is the control line);
4. per-URL inverted semantics (one entry, one URL; inverted families go to code adapters);
5. header value interpolation (headers are static strings; `{...}` in a header value is refused at load).

**Iron rules (L-d only):** a) relative-path sanitization — `..`, `//`, `@`, schemes rejected, and post-resolution the URL must sit inside the provider's inference baseURL origin; b) auth is inference-reuse `Bearer` — a provider whose quota call needs assembled/scheme-swapped/derived headers is disqualified from the table (built-in adapter only); c) GET-only, one URL per entry, cacheTtl clamped [60 s, 24 h] (429 backoff is engine-level global, §7); d) a config entry must NEVER silently shadow a built-in — replacing one requires `override: <builtinId>`, and a fork carries lineage (`forkedFrom`, `verifiedAt`); e) the banned-class validation runs at load; failures are surfaced on the console (`/api/admin/quota.rejected`), never swallowed. Prototype-shaped provider ids and `__proto__/constructor/prototype` path hops are rejected on sight (ADR-0006 pollution discipline).

### 7. Scheduling

Due-based, shaped after the active health prober (idea, not code): a fixed tick (default 60 s, `quota.intervalMs` clamped [10 s, 1 h]) plans this cycle's probes WITHOUT side effects (pure plan, assertable), then runs them sequentially; each pair's next due date = verifiedAt + entry cacheTtl with ±15 % jitter; ≤ 6 probes per tick. First sighting of a covered credential schedules immediately (that IS activation-follows-credentials). **Any 429 from any probe arms an engine-level GLOBAL backoff** (exponential, 5 min base, 3 h ceiling) that pauses the entire scheduler — quota endpoints are shared infrastructure; one capped response means everyone slows down. The kill switch `quota.enabled: false` stops all outbound probing; snapshots on disk still display (staleness logic unchanged).

### 8. Failure semantics and the routing-plane firewall

**Probe failure ≠ quota failure.** A failed attempt never reaches the circuit breaker, never marks SUSPECT, never disables, never enters the trace table: the previous snapshot is kept and `lastFailureAt` flips the badge to `stale`. Conversely the quota plane consumes inference-side evidence in exactly one direction: every `QUOTA_EXHAUSTED` diagnosis recorded at the breaker manager's single failure join point (`recordFailureScoped`) lands one row in the **`quota_events`** ledger BEFORE rule gating (observability is not policy — turning quota *tripping* off must not blind the ledger). The ledger mirrors the ratelimit ledger discipline: ring 500, durable mirror in `traces.db` (`quota_events` table, independent WAL handle, fail-open, boot replay). The classifier gained the CN ceiling markers (quota wording + rolling-session-cap wording in the match literals) so Chinese-provider ceiling burns fold into QUOTA_EXHAUSTED (account-scoped, 12 h floor, no SUSPECT — ADR-0004 vocabulary unchanged). Vocabulary firewall holds: `CLOSED/HALF_OPEN/OPEN` remain CircuitBreaker-only words; the quota badge states (`probed/declared/unverified/stale`) are a separate axis and are never reused as health terms. Ceiling takedowns continue to run through the existing pair-breaker trip semantics; `resetAt`-aligned cooldown shaping is phase 2.

### 9. Surfaces

Console: the `AccountHealth` overlay (every account-returning response, ADR-0006 §9 contract) gained an additive `quota?: AccountQuotaView` — four-state badge, per-window bars with reset countdowns, provenance (`entryId`, `source`, `plan`, staleness) in the tooltip. Absence of the key means *not covered* — deliberately distinct from the `unverified` badge. A dedicated **Quota page** (`/admin/quota`) renders the cross-provider directory: every CONNECTED pair whose provider is covered (pair enumeration as the status credentialHashes — chains + config-baked keys, display-safe prefixes only; uncovered providers render no rows) with its badge, window bars, plan, provenance and its attributed served-usage join (`getAccountPairUsageStats` over the trace ring). The release coverage list (covered provider with no credential yet stays inspectable), the rejected `quotaProbes:` entries (validation failures are surfaced, never swallowed) and the recent burn-event ledger are served by `GET /api/admin/quota` as the diagnostics contract (`coverage / rejected / pairs / events`) — the page itself stays a single directory surface and does not embed those three lists. `GET /api/admin/quota` serves this contract (`coverage / rejected / pairs / events`); `POST /api/admin/quota/refresh` re-arms a pair or the whole schedule (invalidation only — probing stays on the scheduler, never synchronous in the request path). `frontend/src/lib/api.ts` mirrors these wire names 1:1 (`AccountQuotaView`, `QuotaPairRow`, `QuotaWindow`, `QuotaBadgeState`, `QuotaSource`). Raw keys never appear on any surface (display-safe prefixes only); UI strings are all `t()`-fed.

## IP discipline (acknowledged constraint)

Endpoint facts, response shapes and window semantics for all table/adapter entries were verified against the providers' public API documentation and cross-checked against a public MIT-licensed reference implementation (deliberately unnamed in repo-visible text). From it, only *facts* (URLs, header forms, field structures, unit codes such as GLM's session/weekly codes) and *architecture ideas* (declaration table + adapter registry, multi-window model, due-based scheduling) were taken — API contract facts are not copyrightable and ideas are not code. All OCR implementation, fixtures (synthetic, self-authored), comments and documentation are original English-language OCR text; no statement copied or line-ported from the reference project (red line: six-word contiguous matches against its source in a functional diff). Borrowed as facts, never as code.

## Consequences

- Adding a covered provider is a table row (with the §3 catalog cross-check + auth disclosure) when its semantics are declarative, a one-file adapter otherwise, an operator `quotaProbes:` entry for the long tail — the release grows, the runtime never needs to know the account pool.
- The ban list is enforceable at load because it is structural: what cannot be spelled cannot run; bad operator entries fail loudly into `/api/admin/quota.rejected` instead of half-working.
- Quota visibility can never strand traffic: probe outcomes are display evidence only, and inference-side quota burns keep their existing breaker semantics with an added durable event ledger.
- Tests: `quota-dsl` (constructs, banned classes, per-entry fixtures), `quota-engine` (iron rules, plan merge, probe execution, MiniMax semantics, scheduler, events linkage, trace pairing).
