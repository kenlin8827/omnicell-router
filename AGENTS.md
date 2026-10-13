# AGENTS.md

Guidance for AI coding agents. Repo conventions only — architecture decisions live in `docs/adr/` and are **never mirrored here**.

## Project

OpenCode Router (OCR) — a local LLM gateway / cascaded router. Bun workspaces: `backend/` (Fastify + pino) and `frontend/` (React + Vite).

Before touching environments/bootstrap, credentials, or `opencode.jsonc` provider defs, query the current ADRs (`adr_context`, or `docs/adr/`): ADR-0017/0018 (environment book-sets, bootstrap levers) and ADR-0019 (CredentialStore adapter, provider shape/slot).

## Common commands

- `bun run typecheck` — **run this after any code change** (backend + frontend; exit 0 = clean).
- `bun run build` — full build (`tsc -p backend && vite build frontend`); `bun run build:frontend` for frontend only.
- `bun run test` — backend suite via the isolated runner (each file runs as its own process with `OCR_HOME` pointed at a sandbox). Never run `bun test backend/tests` directly — the single-process built-in runner produces ~26 phantom failures from shared-config contamination.

## Language — code comments are always English

Source comments (`//`, `/* */`, JSDoc), identifiers, log messages: English only. Chinese is correct **only** in product content:

- `frontend/src/i18n/locales/zh-CN.ts` (translation table), `docs/adr/zh-CN/**` / `*.zh-CN.md` mirrors. The English doc tree (`docs/adr/*.md`, `README.md`, `DEVELOPMENT.md`) is English-only, including comments inside fenced code blocks.
- `backend/src/config/index.ts` `YAML_FIELD_COMMENTS` / `YAML_FILE_HEADER` (Chinese docs written into the user's `config.yaml`).
- `backend/src/compression/caveman-prompts.ts` (the Chinese prompts are the feature).
- Copy-paste console snippets (e.g. cURL samples in `pages/ApiKeysPage.tsx`) and test fixture strings.

**User-facing UI text is never hardcoded** — it must go through `t('i18n.key')`. A hardcoded Chinese string in a `.tsx` is a bug; fix it.

Verify (expected hits: `config/index.ts` `*` globs and `ApiKeysPage.tsx` snippet only):

```bash
rg -n '//.*[\x{4e00}-\x{9fff}]|\*.*[\x{4e00}-\x{9fff}]' backend/src frontend/src -g '!zh-CN.ts'
rg -n '[\x{4e00}-\x{9fff}]' docs/adr/*.md README.md DEVELOPMENT.md AGENTS.md
```

## Frontend conventions

- `frontend/src/lib/api.ts` mirrors backend response types 1:1 **by the backend contract name** (`AccountMeta`, `AccountHealth`, …). Never weld a consuming page/panel prefix onto the wire type; module prefixes are reserved for genuinely different entities (`CredentialStore*` = the key repository).
- **Dropdowns: always `Combobox`, never native `<select>`** (native popups can't be themed). Use `frontend/src/components/Combobox.tsx`: `value: string`, `onChange: (v: string) => void`, `options: { value, label, meta?, swatch? }[]`, optional `placeholder` / `clearable`; filter input only appears when `options.length > 8`.

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
npx tsc -p backend --noEmit --noUnusedLocals --noUnusedParameters   # 19 hits as of 2026-10-13
npx tsc -p frontend --noEmit --noUnusedLocals                       # 9 hits
```

Treat a green typecheck as necessary, not sufficient. The listed hits are pre-existing and
out of scope for unrelated tasks — but a PR that adds a new one is a review finding.
