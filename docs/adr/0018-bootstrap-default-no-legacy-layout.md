# ADR-0018: Bootstrap `default` Environment — Legacy Layout Support Removed

## Status

Accepted — 2026-10-12. Layer: system. Scope: config/state resolution. Domain: environments.

**Supersedes one limb of ADR-0017**: Decision 1's virtual `default` ("no directory, no
env.json — paths bind in code to the legacy locations") and, with it, the `default` branch of
Decision 2's `getConfigPath()` chain. Every other ADR-0017 decision survives unchanged:
directory-per-env isolation, restart-based switching, per-env `webauth-secret`, the redacted
`.ocrenv.json` envelope, trash-based delete, the sandbox type, and the 8-endpoint API/CLI/console
surface. ADR-0017's Phase-4 test-adoption work is folded into this record (the isolation lever
became `OCR_HOME`, not the process cwd).

## Context and Problem Statement

ADR-0017 kept the pre-environments layout alive as a *virtual* environment so that existing
installs would need zero migration. In practice that decision made OCR a two-layout system
forever: `config/env.ts` carried a `legacyConfigPath()` chain (cwd → repo-root → cwd) plus a
second branch of `computeEnvPaths()` binding `<cwd>/data`, `<cwd>/models`, and
`~/.opencode-router/{catalog,traces,capture,webauth-secret}`; the console had to label the row
"legacy locations"; the CLI annotated `(legacy layout)`; five test suites isolated themselves by
`chdir`-ing to a sandbox cwd holding a placeholder `config.yaml`, because that was the only path
`getConfigPath()` consulted.

OCR is version `0.0.1`, untagged, unreleased: the population "protected" by zero migration is
developer machines, whose pre-environments state is disposable. Meanwhile the dual-mode branch
stays in the resolution hot path of every future path consumer, and the cwd dependency makes test
isolation implicit and fragile (`scripts/test-isolated.ts` had to fake a cwd config to keep the
operator's real `webAuth` gate out of console tests).

## Decision Drivers

- One runtime layout: path resolution must not branch on "is this the old installation?".
- Explicit isolation: tests sandbox through `OCR_HOME` (the ADR-0017 Decision 2 lever), never
  through the process cwd, which several consumers still reached for relative paths.
- No silent file relocation: moving an operator's data behind their back was rejected by
  ADR-0017 and stays rejected.
- Honest fail-fast: an environment that does not exist is an error, except the bootstrap tier
  which the code creates.

## Considered Options

| Option | Summary | Verdict |
| --- | --- | --- |
| A. Keep the virtual `default` | status quo of ADR-0017 | Rejected: permanent dual-mode path code, legacy vocabulary in console/CLI/tests, for an unreleased product |
| B. Auto-migrate legacy files into `envs/default/` at first boot | one-time move, operator unaware | Rejected (same reason ADR-0017 rejected it): relocation of live files, Windows rename risk across WAL handles |
| C. One-shot `ocr env adopt` migration command | explicit copy of legacy files into a named env | Rejected by the user: keeps `legacyConfigPath()` knowledge alive in production code — the residue this change exists to remove |
| D. Bootstrap `default` as a real directory environment | every env is `envs/<name>/`; `default` is scaffolded on first boot; legacy locations are simply not read | **Chosen** — "treat it as a fresh environment" (user decision, 2026-10-12) |

## Decision Outcome

Chosen option D, because a single-directory layout is the smallest honest model: the resolution
chain keeps its shape (`OCR_ENV` > `envs/current` pointer > `default`) while losing its only
branch, and isolation becomes one environment variable.

- `computeEnvPaths(name)` has ONE body: `envDir(name)` plus the five state dirs and
  `webauth-secret`. `legacyConfigPath()` is deleted; `getConfigPath(customPath?)` is
  `customPath ?? getEnvPaths().configPath`.
- `default` is a **reserved, scaffolded** name: `ensureEnvScaffold(name)` (idempotent mkdir of
  `envs/<name>/` + state dirs + `env.json` when absent) runs at boot inside
  `ensureDefaultConfigFile()`, so a fresh install resolves `default` and materializes it. It stays
  non-renameable, non-trashable and non-resettable — trashing the tier every resolution falls back
  to would leave the gateway with no bootable book-set.
- `envExists('default')` becomes an ordinary stat of a real directory; the listing keeps
  `default` as the first row and `EnvInfo.virtual` disappears.
- **Repository tree carries no state.** The pre-environments locations were also repository
  locations: a gitignored root `config.yaml`, a tracked `data/.gitkeep`, and a tracked
  `models/layer1-classifier.json` scaffold. All three are gone — the classifier scaffold is
  auto-created inside each environment at boot, and `.gitignore` keeps only `node_modules/`,
  `dist/`, `.env`, `*.log`. The project root is source only; if a rule for a repo-root state
  directory ever reappears, the layout has regressed.
- CLI scripts share the base: `scripts/{flywheel-stats,flywheel-prune,train-layer1-classifier}.ts`
  resolve a relative `datasetPath`/`modelPath` against `getEnvRootDir()`, exactly as
  `flywheel/collector.ts` and `router/layer1-classifier.ts` do. They previously resolved against
  `process.cwd()`, which after this change would have made the CLI read and rewrite a different
  file than the gateway writes.
- `Layer1Classifier` no longer pre-seeds `modelFilePath` with `'./models/layer1-classifier.json'`;
  the path comes from `init()`, and `saveModel()`/`reload()` without it fail fast instead of
  writing to the shell's cwd.
- **No env file.** `dotenv` is dropped from the dependencies and its `dotenv.config()` call is gone,
  because a cwd-adjacent `.env` was the last input source inherited from the legacy layout: it
  would have been a second, file-based answer to "which book-set" outranking `envs/current`. Since
  the Bun runtime auto-loads a cwd `.env` on its own, every bun entry point — root and backend
  `package.json` scripts, `scripts/dev.ts`, `scripts/test-isolated.ts`, and the daemon's
  `resolveRuntimeBinary()` — passes `--no-env-file`, so a stray file cannot decide the boot target.
  `OCR_ENV`/`OCR_HOME` come from the real process environment only; `.env.example` is deleted and
  `.gitignore` keeps `.env` purely to stop an accidental commit.
- UI/CLI vocabulary: the `legacy` badge and `default (legacy layout)` location string are deleted;
  the bootstrap env is marked `bootstrap` (console chip, `ocr env list`), which says what it is
  rather than what it used to be.
- **No migration tool ships.** Files an operator left at the pre-environments locations become
  inert data, reachable only by hand.

## Consequences

Positive:

- Path resolution is one function with no mode flag; adding a state file means adding one path
  under the env directory, with no "what about old installs?" question.
- Test isolation is declarative: `OCR_HOME=<tmp> OCR_ENV=default` (adopted by
  `scripts/test-isolated.ts`, and by the `systemone`/`layer2-systemone`/`decision-capture`/
  `flywheel-prune` suites, which previously swapped configs with `process.chdir`).
- The console page now describes one layout; nothing in the product can present a "legacy" row.

Negative / accepted:

- Existing pre-environments data is orphaned in place: no code path reads `<cwd>/config.yaml`,
  `<cwd>/{data,models}` or `~/.opencode-router/{catalog,traces,capture,webauth-secret}` any more.
  A machine upgrading from that layout starts with an empty flywheel/traces and a freshly generated
  per-env session secret (console re-login expected, ADR-0017 Decision 4 already defined it).
- Windows move risk is gone precisely because nothing moves.
- Anyone who wants the old history back must copy it by hand (see Migration plan).

## Migration plan

None shipped, by design. An operator who wants pre-environments state inside an environment does it
explicitly, with the gateway stopped:

```bash
ENV=~/.opencode-router/envs/default         # or any env they select
cp config.yaml "$ENV/config.yaml"           # repo/cwd config
cp -r data models "$ENV/"                   # flywheel + layer2 datasets, trained weights
cp -r ~/.opencode-router/{catalog,traces,capture} "$ENV/"
rm ~/.opencode-router/webauth-secret        # optional; per-env secret is now authoritative
```

Copy rather than move, so the originals stay as the backup until the boot is verified.
