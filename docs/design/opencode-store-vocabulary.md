# Refactor Plan — Retire Bare `v1`/`v2` from the Credential Vocabulary

> Status: PROPOSAL (no code changed yet). Scope: the uncommitted ADR-0019 working set.
> Companion rename already landed: breaker scopes `pair / account / model` (2026-10-13).

## 1. Problem

`V1Store` / `V2Store` / `StoreKind = 'v1' | 'v2'` never say **whose** version. The
first-time reader must guess "OCR v1/v2?" — it is OpenCode's storage generation, and
nothing in the name says so. The UI already papers over the ambiguity (the badge reads
`opencode v2 store` but its i18n key is `storeKindV2`), and the same bare-v shape
repeats across four more layers: provider-def schema (`'v1' | 'v2'`), package naming
(`isV2Package`, `V1_TO_V2_PACKAGE`), REST reason codes (`v2_service_unreachable`), and
test file names (`credentials-v2-reads`). The real domain axes are **substance**
(auth.json vs opencode.db; ai-sdk packages vs @opencode/ai packages), not ordinal
numbers borrowed from an external product's versioning.

**Rule adopted:** version numbers survive when — and only when — they carry an explicit
subject (`OpencodeV1Store`, `'opencode-v2'`): the binding evidence IS `opencode
--version`, so the name maps 1:1 to real data. Medium words (auth.json / db / service)
describe concrete failure modes and reason codes, not class identities.

## 2. Audit — every bare-v token, by layer

| Layer | Current tokens | Files |
|---|---|---|
| G1 stores | `V1Store`, `V2Store`, `V2Store-readonly` (badge), `V1StoreDeps`, `V2StoreDeps`, `V2ServiceConfig`, `V2Row`, `V2Database`, `V1_CAPABILITIES`, `V2_CAPABILITIES`, `StoreKind`, `StoreDegradedCode`, files `opencode-v1-store.ts` / `opencode-v2-store.ts` | `backend/src/opencode/credentials/*` |
| G2 def schema | `ProviderDefSchema = 'v1' \| 'v2'`, `isV2ShapedDef`, `v2ModelDefs`, `isV2Package`, `v2PackageFor`, `v2Segment`, `V2_PACKAGE_RE`, `V2_SEGMENT_WIRES`, `V1_TO_V2_PACKAGE` | `user-config.ts`, `providers/wire.ts`, `boot-direct.ts`, `console.ts` |
| G3 wire | `'v2' \| 'v2-readonly' \| 'v1' \| 'ocr'` (REST `kind`), `v2_service_unreachable`, `v2_db_unreadable` | `routes/console.ts`, `push.ts`, `frontend/src/lib/api.ts` (`CredentialStoreKind`, `CredentialStoreDegradedCode`, `CredentialPushReasonCode`) |
| G4 UI | i18n keys `storeKindV2`, `storeKindV2Readonly`, `storeKindV1`, `storeDegradedCli` + copy | `i18n/{types,en-US,zh-CN}.ts`, `KeysPage.tsx` |
| G5 tests | `credentials-v1-ocr`, `credentials-v2-reads`, `credentials-v2-writes`, `boot-direct-v2-defs`, `provider-def-v2-write-routes`, `user-config-v2-read`, `user-config-v2-write` + string assertions inside ~10 files | `backend/tests/` |
| G6 docs | AGENTS.md credentials section (`V2Store`/`V1Store` prose, uncommitted), ADR-0019 body (untracked), `scripts/test-isolated.ts` comment | repo root |
| G7 persisted | `credential-store.json → { bound: StoreKind, ... }` stores the wire value itself | `factory.ts` |

### Explicit non-goals (do NOT rename)

- `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`, `OCR_DEFAULT_V1_URL` — OpenAI-compatible industry path surface.
- `flywheel/schema.ts` dataset **v1/v2** — local on-disk format versioning, context-qualified in-file.
- `env-archive` format `'ocr-env' v1` — already namespaced by the format id.
- `installed.version` and `opencode.db` — external OpenCode artifacts; their content/format is ground truth, not ours to rename.
- Prose "OpenCode v2 / ≥ 2" — external product version with explicit subject; this is what correct usage looks like.
- `OcrStore` / `'ocr'` — already self-describing.
- `v2ray` mentions (proxy tool name).

## 3. Target vocabulary (DECIDED 2026-10-13 — owner + public product version)

The discriminator IS the public OpenCode generation — `opencode --version` evidence
binds the store, so the name maps 1:1 to real data. Version numbers stay ONLY with an
explicit subject (the bare `V1/V2` was the bug, not the ordinal). Substance words
(`auth.json`, `db`, `service`) describe concrete failure modes and reason codes, never
class identities — they are internal classifications a reader would have to learn.

| # | From | To |
|---|---|---|
| 1 | `V2Store` / `'v2'` | `OpencodeV2Store` / kind `'opencode-v2'` |
| 2 | `V2Store-readonly` / `'v2-readonly'` | `OpencodeV2Store-readonly` / kind `'opencode-v2-readonly'` (badge keeps explaining *why*: "read-only: CLI not found") |
| 3 | `V1Store` / `'v1'` | `OpencodeV1Store` / kind `'opencode-v1'` |
| 4 | `OcrStore` / `'ocr'` | unchanged (already owner-prefixed; it is ours) |
| 5 | `V2StoreDeps` / `V2ServiceConfig` / `V2Row` / `V2Database` / `V2_CAPABILITIES` | `OpencodeV2StoreDeps` / `OpencodeV2ServiceConfig` / `OpencodeV2CredentialRow` / `OpencodeV2Database` / `OPENCODE_V2_CAPABILITIES` |
| 6 | `V1StoreDeps` / `V1Helpers` / `V1_CAPABILITIES` | `OpencodeV1StoreDeps` / `OpencodeV1Bridge` / `OPENCODE_V1_CAPABILITIES` |
| 7 | `ProviderDefSchema = 'v1' \| 'v2'` | `OpencodeDefGeneration = 'opencode-v1' \| 'opencode-v2'` |
| 8 | `isV2Package` / `v2PackageFor` / `v2Segment` / `V2_PACKAGE_RE` / `V2_SEGMENT_WIRES` / `V1_TO_V2_PACKAGE` / `isV2ShapedDef` / `v2ModelDefs` | `isOpencodeV2Package` / `opencodeV2PackageFor` / `opencodeV2Segment` / `OPENCODE_V2_PACKAGE_RE` / `OPENCODE_V2_SEGMENT_WIRES` / `V1_TO_V2` retained only inside those compound names where `OPENCODE` prefix already qualifies, e.g. `AI_SDK_TO_OPENCODE_V2_PACKAGE`, `isOpencodeV2ShapedDef`, `opencodeV2ModelDefs` |
| 9 | `v2_service_unreachable` / `v2_db_unreadable` | `opencode_v2_service_unreachable` / `opencode_v2_db_unreadable` (here `service`/`db` are the right words: they name the concrete failing dependency, not a class identity) |
| 10 | i18n `storeKindV2` / `storeKindV2Readonly` / `storeKindV1` | `storeKindOpencodeV2` / `storeKindOpencodeV2Readonly` / `storeKindOpencodeV1` |
| 11 | badge copy `opencode v2 store` / `opencode v1 (auth.json)` | `opencode v2 (opencode.db)` / `opencode v2 · read-only` / `opencode v1 (auth.json)` — version primary, medium parenthetically explanatory |
| 12 | test files | `credentials-opencode-v1-ocr`, `credentials-opencode-v2-reads`, `credentials-opencode-v2-writes`, `boot-direct-opencode-v2-defs`, `provider-def-opencode-v2-write-routes`, `user-config-opencode-v2-{read,write}` |
| 13 | prose tokens `v2-shaped` / `v2-family` / `v2-only` / `v1-sink` in comments | `opencode-v2 shaped` etc. — hand-edited, subject always attached |
| — | Module-internal file names `opencode-v1-store.ts` / `opencode-v2-store.ts` | **kept as-is** — the import context is already `opencode/credentials/`; the directory carries the subject (see D3) |

## 4. Persistence vocabulary (no legacy compat — pre-release)

`credential-store.json` persists `bound: StoreKind`. The whole ADR-0019 surface is
uncommitted and the file exists only on dev boxes, so old dev-build spellings are
NOT translated (operator decision 2026-10-13: "in development, no legacy"). Instead
the read path validates the domain: `isStoreKind(parsed.bound)` — an unknown `bound`
(including the retired bare `v1`/`v2`) reads as **no state** and the store re-binds
from live evidence next boot, then rewrites the file in the qualified vocabulary.
This is the correct hardening the old `typeof === 'string'` check always wanted:
fail-closed at the file boundary instead of leaking a garbage kind into
`switch (kind)` sites. One assertion pair in `credentials-factory.test.ts` pins
accept(4 kinds) / reject(unknown, bare-v2).

## 5. Execution batches (each verifiable, no batch crosses unresolved failures)

| Batch | Work | Verification |
|---|---|---|
| B0 | Freeze baseline: `grep -rcE` occurrence counts per token (guards against sed overreach, see R1) | recorded numbers |
| B1 | G1 store module: symbol renames (module file names per D3/D4) + import fixups (`probe.ts`, `boot-direct.ts`, factory) | `tsc -p backend` + `credentials-factory`, `credentials-*` unit files |
| B2 | G2 def-schema/package family (`wire.ts`, `user-config.ts`, `boot-direct.ts` call sites) | `tsc -p backend` + `boot-direct-*`, `user-config-*`, `provider-def-*` tests |
| B3 + B4 | G3 wire values **and** frontend types/i18n/pages — same batch (no intermediate window where REST speaks two dialects; lesson from Standards review S1) | `tsc` both ends + `credentials-console-routes`, `store-endpoint`, `push-endpoint`, `leak-surfaces` + `bun run build:frontend` |
| B5 | G5 test file renames + in-test vocabulary + new legacy-`bound` assertion (§4) | isolated runner on touched files |
| B6 | G6 docs: AGENTS.md credentials section, ADR-0019 body token pass (class-name occurrences only; "OpenCode v2" prose stays), `scripts/test-isolated.ts` comment | manual + §2 non-goal list as checklist |
| B7 | Final gate | `bun run typecheck`; `bun run test` (expect 0 fail); `build:frontend`; sweep below | 

Final sweep (expected: zero hits outside non-goal contexts):

```bash
grep -rnE "\bV1Store\b|\bV2Store\b|StoreKind = 'v2'|'v2-readonly'|\bv2_service_unreachable\b|\bv2_db_unreadable\b|ProviderDefSchema|isV2Package|v2PackageFor|V2_PACKAGE_RE|V2_SEGMENT_WIRES|V1_TO_V2_PACKAGE|isV2ShapedDef|v2ModelDefs|storeKindV[12]" backend/src frontend/src backend/tests docs AGENTS.md scripts
```

(The pattern intentionally targets `backend/src` — bare `V1/V2` symbols there are ALL
the credential-generation meaning; `frontend/src` is enumerated per-token instead of
bulk-sed'd, per the CSS-collision lesson.)

## 6. Risk register (SEV × PROB; top items)

| ID | Failure mode | S | P | Mitigation |
|---|---|---|---|---|
| R1 | Sed overreach renames a token that is legitimately version-numbered (this exact class of accident already happened twice in the pairs rename: the real `RawCred.keyHash`, and guard tests that intentionally send old words to assert 400) | 3 | 4 | B0 baseline counts; per-token enumeration before replacing; quoted-literal seds only; §2 non-goals as the reviewer checklist; full suite after every batch |
| R2 | Dev-box `credential-store.json` keeps retired bare-v spellings | 2 | 3 | RESOLVED by §4: strict `isStoreKind` read-guard — unknown bound = no state, re-binds from live evidence and rewrites qualified. Downgraded from SEV4 (hysteresis loss) because losing LKG on a dev box is self-healing, and the guard also closes the pre-existing garbage-kind hole |
| R3 | B3/B4 split across commits leaves REST `kind` and `CredentialStoreKind` speaking different dialects → badges silently blank | 2 | 4 | merged batch (adopted from Standards review S1 precedent) |
| R4 | ADR/AGENTS prose over-erased: "OpenCode v2 managed service" (external fact) gets renamed too | 2 | 3 | B6 is hand-edited with the non-goal list; never sed docs |
| R5 | i18n key renamed in one locale only | 1 | 2 | `i18n/types.ts` is compile-enforced; `tsc -p frontend` catches |

## 7. Decision log & remaining calls

| # | Question | Outcome |
|---|---|---|
| D1 | Naming axis | **DECIDED (operator, 2026-10-13): owner + public product version** — `OpencodeV1Store` / `OpencodeV2Store`. Rejected alternatives: bare `V1/V2` (no subject), `AuthJsonStore`/`OpencodeDbStore` (medium words are an internal taxonomy readers must learn; `auth` also reads as OCR's own auth in this codebase), `File/ServiceStore` (private abstraction, worse). Key argument: `opencode --version` is the actual binding evidence — the version number is public ground truth, not indirection |
| D2 | `ProviderDefSchema` values | **DECIDED: same axis** — `'opencode-v1' | 'opencode-v2'` (the def schema generations ARE opencode product generations) |
| D3 | Module-internal file names `opencode-v1-store.ts` / `opencode-v2-store.ts` | **DECIDED: keep** — `backend/src/opencode/credentials/` carries the subject; renaming adds churn without clarity |
| D4 | Test file names | **DECIDED: full qualification** — `backend/tests/` is a FLAT directory with no subject context, so bare-v2 names there violate the subject rule; D3 survives on the directory-context exemption, which tests/ does not have (symmetry of reasoning, not of action) |
| D5 | Where the vocabulary is recorded | **DECIDED: this design doc** (ADR-0019 body gets the renamed symbols + a pointer line; naming is not an architecture decision) |

Remaining work before B1: only D3/D4 (a yes/no + a two-way pick). Everything else is executable as specified.

## 8. Effort estimate

B1–B2 ≈ 0.5d, B3–B5 ≈ 0.5d, B6–B7 ≈ 0.25d (mechanical but guard-heavy; the pairs
rename ran 1167 tests green as the precedent for the per-batch verification cadence).
