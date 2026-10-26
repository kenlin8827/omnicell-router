# AGENTS.md

Guidance for AI coding agents. Repo conventions only — architecture decisions live in `docs/adr/` and are **never mirrored here**.

## Project

OmniCellRouter (OCR) — a local LLM gateway / cascaded router. Bun workspaces: `backend/` (Fastify + pino) and `frontend/` (React + Vite).

Before touching environments/bootstrap, credentials, or provider definitions, query the current ADRs (`docs/adr/`): ADR-0007 (environment book-sets, bootstrap, controlled-restart switching, export/import), ADR-0006 (the OCR file as the single credential truth, credential sync clients, key-hash identity), ADR-0005 (direct execution, execution topology, credential chains), and ADR-0010 (provider-def ownership — `<ocrHome>/providers.json` is the single def truth; `opencode.jsonc` is a sync-client materialization target). Before touching model-addressing vocabulary — the `modelRef` wording (gateway-visible id namespace, four kinds: auto alias / combo id / registered id / variant sibling id — tagged `kind` by the console catalog), `ModelRegistration` as the resolved physical record, tier-membership or combo types, or the request `model` field resolution — query ADR-0003 (model addressing and tier membership). The historical `ModelRef`/`ModelIdentity` TYPE NAMES never shipped in code — do not reintroduce them. Before touching tier/effort escalation, the `@ocr-*` directive surface, or the route-entry experience table, query ADR-0011 (scrub-everywhere / apply-last-user-message, per-turn overlays that never touch the ratchet, automatic machinery never steps down, directives never write back) and the syntax reference in `docs/design/directives.md`. Before touching quota tracking — the (provider × keyHashPrefix) pair model, the built-in declaration table / code adapters / the `quotaProbes:` config section, the probe DSL constructs and banned classes, the iron rules (they bind ONLY operator config), or the quota_events ledger — query ADR-0009 (layered quota knowledge, declarative probing, credential-anchored activation). Health vocabulary is layer-disciplined: `CLOSED/HALF_OPEN/OPEN` belong to the CircuitBreaker; model-level aggregation reads `available/recovering/unavailable` (ADR-0004; eviction fires only on `unavailable`, ADR-0002).

## Common commands

- `bun run typecheck` — **run this after any code change** (backend + frontend; exit 0 = clean).
- `bun run build` — full build (`tsc -p backend && vite build frontend`); `bun run build:frontend` for frontend only.
- `bun run test` — backend suite via the isolated runner (each file runs as its own process with `OCR_HOME` pointed at a sandbox). Never run `bun test backend/tests` directly — the single-process built-in runner produces ~26 phantom failures from shared-config contamination.

## Language — code comments are always English

Source comments (`//`, `/* */`, JSDoc), identifiers, log messages: English only. Chinese is correct **only** in product content:

- `frontend/src/i18n/locales/zh-CN.ts` (translation table), `docs/adr/zh-CN/**` / `*.zh-CN.md` mirrors. The English doc tree (`docs/adr/*.md`, `docs/design/*.md`, `docs/reviews/*.md`, `README.md`, `DEVELOPMENT.md`) is English-only, including comments inside fenced code blocks — quoted product strings (e.g. `YAML_FIELD_COMMENTS` values) get an English gloss in docs; the CJK originals live only in their sanctioned source files.
- `backend/src/config/index.ts` `YAML_FIELD_COMMENTS` / `YAML_FILE_HEADER` (Chinese docs written into the user's `config.yaml`).
- `backend/src/compression/caveman-prompts.ts` (the Chinese prompts are the feature).
- Copy-paste console snippets (e.g. cURL samples in `pages/ApiKeysPage.tsx`) and test fixture strings.

**User-facing UI text is never hardcoded** — it must go through `t('i18n.key')`. A hardcoded Chinese string in a `.tsx` is a bug; fix it.

Verify (expected hits: `config/index.ts` `*` globs and `ApiKeysPage.tsx` snippet only):

```bash
rg -n '//.*[\x{4e00}-\x{9fff}]|\*.*[\x{4e00}-\x{9fff}]' backend/src frontend/src -g '!zh-CN.ts'
rg -n '[\x{4e00}-\x{9fff}]' docs/adr/*.md docs/design/*.md docs/reviews/*.md README.md DEVELOPMENT.md AGENTS.md
```

## Frontend conventions

- `frontend/src/lib/api.ts` mirrors backend response types 1:1 **by the backend contract name** (`CredentialMeta`, `CredentialHealth`, …). Never weld a consuming page/panel prefix onto the wire type; module prefixes are reserved for genuinely different entities (`CredentialStore*` = the key repository).
- **Dropdowns: always `Combobox`, never native `<select>`** (native popups can't be themed). Use `frontend/src/components/Combobox.tsx`: `value: string`, `onChange: (v: string) => void`, `options: { value, label, meta?, swatch? }[]`, optional `placeholder` / `clearable`; filter input only appears when `options.length > 8`.

## Single-source constants — no drift twins

A runtime default or cross-cutting magic number is declared **exactly once** and imported
everywhere else. Re-declaring the same literal locally (config fallback + runtime fallback,
backend + frontend mirror, provider × provider) is a drift twin: identical today, silently
divergent after the next edit.

- Backend defaults live in `backend/src/config/defaults.ts` (provider timeout, forward-proxy
  port, headroom port/timeout, maxBodyBytes, layer2 timeout, route-entries cap, forward-proxy
  hang guard). Config defaults, runtime fallbacks and CLI fallbacks all import from there.
- Frontend mirrors of backend defaults live in `frontend/src/lib/defaults.ts`; when a backend
  default changes, update the mirror in the **same** commit (header of that file says so).
- The three observation ledgers (failure / ratelimit / quota events) share the ring skeleton
  in `backend/src/utils/event-ring.ts` (capacity, coalesce window, message bound, id scheme,
  upsert-then-trim order) — never re-declare `MAX_EVENTS`-style constants per module.
- Shared wire/payload helpers (e.g. `DATA_URL_RE`) live in `backend/src/providers/wire.ts`.
- The release version is declared once, in the root `package.json`; `scripts/version-sync.ts`
  (wired as the `npm version` lifecycle hook) mirrors it into the workspace subpackages,
  `tauri.conf.json`, `Cargo.toml`, the self-crate entry in `Cargo.lock` and the two workspace
  entries in `bun.lock`. Never hand-edit those copies; CI drift-guards with
  `bun scripts/version-sync.ts --check`.
- Exception: defaults baked into prose (`YAML_FIELD_COMMENTS`, i18n strings) are sanctioned
  copy — changing a constant means sweeping those strings in the same pass (cleanup contract
  below).

Spot-check for regressions:

```bash
rg -n '\|\| *300000|\|\| *4555|\|\| *8787|\?\? *16777216|setTimeout\(60000' backend/src -g '*.ts'
```

## Cleanup contract — code, comments and ADRs move together

Deleting or renaming a symbol is **not finished** until every reference to the removed
behavior is gone: source comments, docstrings, test titles/describe blocks, README and ADR
prose. A comment that describes deleted code is residue — it teaches the next reader a
contract that no longer exists. Sweep it in the same pass:

```bash
rg -n "(//|\*).*\b<DeletedSymbol>\b" backend/src frontend/src backend/tests   # must be empty
```

Behavior changes update the governing ADR under `docs/adr/` in the **same** commit — code
and doc together, never a later "docs follow-up".

`bun run typecheck` does **not** detect dead code: `backend/tsconfig.json` omits
`noUnusedLocals` / `noUnusedParameters`. Audit before claiming any cleanup is complete:

```bash
npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters   # 0 hits as of 2026-12
npx tsc -p frontend --noEmit --noUnusedLocals                       # 0 hits
```

Treat a green typecheck as necessary, not sufficient. Any new hit is a review finding.
