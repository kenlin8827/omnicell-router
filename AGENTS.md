# AGENTS.md

Guidance for AI coding agents working on this repository. Keep entries short, concrete, and verifiable.

## Project

OpenCode Router (OCR) — a local LLM gateway / cascaded router. Bun workspaces: `backend/` (Fastify + pino) and `frontend/` (React + Vite).

## Common commands

- `bun run typecheck` — **run this after any code change** (typechecks both backend and frontend; exit 0 = clean).
- `bun run build` — full build (`tsc -p backend && vite build frontend`).
- `bun run build:frontend` — frontend only (writes to `frontend/dist/`).
- `bun run test` — backend test suite (isolated runner: each file runs from a sandbox cwd with a placeholder config, so the operator's real config.yaml never leaks in; `bun test backend/tests` directly is NOT reliable — `bun test` is bun's built-in runner and a single-process whole-suite run produces ~26 phantom failures from cwd/webAuth contamination).

## Code conventions

### All code comments must be English

OCR is an internationalized product (`zh-CN` / `en-US` locale pair, English ADRs). **Source-code comments — `//`, `/* */`, JSDoc, trailing comments — are always written in English.** Never write Chinese in a comment; English is the source language for every identifier, log message and comment.

Chinese *is* correct in these places, which are product content rather than code:

- `frontend/src/i18n/locales/zh-CN.ts` — the translation table itself.
- `docs/adr/zh-CN/**` and `*.zh-CN.md` — the translated doc mirrors. The English tree (`docs/adr/*.md`, `README.md`, `DEVELOPMENT.md`) is English-only, including inline comments inside fenced code blocks.
- `backend/src/config/index.ts` `YAML_FIELD_COMMENTS` / `YAML_FILE_HEADER` — Chinese docs written into the user's `config.yaml`.
- `backend/src/compression/caveman-prompts.ts` — the Chinese output-style prompts are the feature.
- Copy-paste config snippets in the console (e.g. the cURL samples in `pages/ApiKeysPage.tsx`) — these are pasted into the user's terminal.
- Test fixture strings (e.g. a mock user prompt).

**User-facing UI text is never hardcoded** — it must go through `t('i18n.key')`. If you find a hardcoded Chinese string in a `.tsx` file, that is a bug; fix it rather than copying the pattern.

Verify (code + English doc tree; hits should be `config/index.ts` `*` globs and `ApiKeysPage.tsx:996` only):

```bash
rg -n '//.*[\x{4e00}-\x{9fff}]|\*.*[\x{4e00}-\x{9fff}]' backend/src frontend/src -g '!zh-CN.ts'
rg -n '[\x{4e00}-\x{9fff}]' docs/adr/*.md README.md DEVELOPMENT.md AGENTS.md
```

## Frontend conventions

### Dropdowns: always use `Combobox`, never native `<select>`

The native `<select>` popup cannot be themed (it ignores the custom CSS themes), so **every** dropdown in the app must render through `frontend/src/components/Combobox.tsx` for visual consistency. This rule is also documented in that file's header comment.

```tsx
import { Combobox } from '../components/Combobox';

<Combobox
  value={level}
  onChange={setLevel}
  options={[
    { value: '', label: t('logs.levelAll') },
    { value: 'info', label: 'INFO+' },
  ]}
  style={{ fontSize: '12px', padding: '5px 10px', width: '140px' }}
/>
```

API: `value: string`, `onChange: (v: string) => void`, `options: { value, label, meta? }[]`, optional `placeholder`, `clearable`. The filter input only appears when `options.length > 8`.
