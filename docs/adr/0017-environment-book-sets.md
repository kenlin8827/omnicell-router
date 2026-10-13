# ADR-0017: Environment Book-Sets — Named Config/State Environments with Restart-Based Switching and Redacted Export

## Status

Proposed — 2026-10-12. Layer: system. Scope: config/state resolution. Domain: environments. All seven design decisions (D1–D7 of the approved design proposal) are locked at the recommended options by the user, 2026-10-12. Phases 1–3 (backend substrate, API+CLI, console UI) are approved for implementation; Phase 4 (test/sandbox adoption) is scheduled, NOT yet approved. (2026-10-12 amendment, same day and before this record's first commit: Decision 5's export container was switched from the single-file JSON envelope to a **zip archive** by user decision — the record has never been Accepted, so the Decision 5 text below is already the amended form; the Considered Options row records the superseded choice.) Amends nothing; independent surface. One boundary touches ADR-0011: the direct pool's credential source (`~/.config/opencode/opencode.jsonc` + `auth.json`, ADR-0011 Decision 2, `user-config.ts`) stays GLOBAL / installation-wide and never becomes per-environment. "Daemon" in this record always means OCR's own background gateway process (`ocr start`), not the OpenCode daemon ADR-0011 removed from the inference path.

(2026-10-12 amendment, see [ADR-0018](./0018-bootstrap-default-no-legacy-layout.md): Decision 1's VIRTUAL `default` and the `default` limb of Decision 2's `getConfigPath()` chain are SUPERSEDED — `default` is now a scaffolded directory environment and no code path reads the pre-environments locations. The dotenv/`.env` interaction line of this decision is SUPERSEDED too: `dotenv` is removed and `OCR_ENV`/`OCR_HOME` come from the real process environment only. Decisions 2 (chain shape), 3–7 and all phases stand.)

## Context and Problem Statement

OCR is a single-book-set system. One `config.yaml` resolved by `getConfigPath()` (`backend/src/config/index.ts:114-130`, cwd → repo-root fallback); every save (`saveConfig` :395-419, `saveRawConfig` :357-369) writes through to that same file. State scatters across roots, none of it switchable:

- Home-relative with NO override: `getOcrHomeDir()` (`cli/paths.ts:5-12`)
  hardcodes `~/.opencode-router`; `traces/traces.db` shared by the trace store and FinOps (`trace/tracker.ts:131-132` → `trace/persist.ts:36-37`, WAL; `index.ts:60`), `capture/<date>/*.jsonl` (`capture/recorder.ts:329`), `catalog/ocr.json` + `custom.json` (`opencode/catalog/ocr-store.ts:26-30`, `OCR_CATALOG_PATH` the sole override), `webauth-secret` (`auth/web-auth.ts:80-82`), forward-proxy CA (`forward-proxy/index.ts:18`), daemon artifacts `ocr.pid`/`ocr.log`/`ocr.info.json` (`cli/paths.ts:14-24`).
- cwd-relative derived state: `data/flywheel.jsonl`
  (`flywheel/collector.ts:35-36`), `data/layer2-decisions.jsonl` (`flywheel/decision-capture.ts:56,72`), `models/layer1-classifier.json` (`flywheel/trainer.ts:102`, `router/layer1-classifier.ts:108`).

Tests pollute the operator's real state: `scripts/test-isolated.ts:41-45` sandboxes only the cwd with a placeholder `config.yaml`; every home-relative write during a run lands in the real `~/.opencode-router` (`tracker.ts:131-132` opens the production `traces.db`). `applyTestEnvOverrides` (`config/index.ts:309-312`) force-disables only the flywheel under `NODE_ENV=test` — a symptom patch, not isolation.

The need: (1) operator-facing named environments ("book-sets") — set the CURRENT environment, CREATE new ones, EXPORT/IMPORT for backup & restore, all from the web console; (2) the same mechanism doubles as the e2e/sandbox isolation substrate with reset-after-run. Constraints: zero migration for existing single-config users; fit the Fastify registration pattern (`server.ts:103,110`) and the React console structure; the product already declares config hot-reload nonexistent (`YAML_FILE_HEADER`, `config/index.ts:428-432`).

## Decision Drivers

- Book-set integrity: one environment's data — session cookies included —
  must never leak into another.
- Zero migration: the existing layout keeps working byte-identically until
  the user creates the first environment.
- Root-cause isolation: ONE override point sandboxes every home-relative
  write, instead of per-consumer test patches.
- Reuse proven machinery: the existing restart flow, not a new hot-swap
  subsystem.
- Default-safe backup: exports never carry plaintext credentials by default.
- Honest switching: open SQLite/WAL handles and import-time path singletons
  make in-process book-set swaps untruthful; restart is the real boundary.

## Considered Options

| Axis | Options | Chosen | One-line rejection reason |
| --- | --- | --- | --- |
| Content scope (D1) | A config-only / B config+derived / C everything | C-lite runtime (per-env config + derived + traces/capture; identity split per Decision 4) with the B export boundary | A leaves traces.db pollution and derived-state cross-talk unsolved; C's export drags privacy-heavy binary traces into every backup |
| Switch semantics (D2) | in-process hot swap / controlled restart | restart | Hot swap fights open SQLite/WAL handles, module-level singletons (`catalogRepository`, `Layer1Classifier`) and the boot-captured config snapshot (`server.ts:81-87`) — blast radius is the whole boot sequence |
| Export container (D5) | JSON envelope / zip archive | zip archive `.orc_env.zip` v1 — envelope machinery preserved as `manifest.json` + real-path entries; optional password-encrypted variant under the SAME suffix (OCRENC1 container) | Amended 2026-10-12 by user decision: zip is the operator-native backup shape (openable with any archive tool, ready for future binary payloads) at the cost of one small dependency (`fflate`); the original JSON-envelope choice ("default payload is all text; zip adds a dependency for zero current gain") stands as the rejected record |
| Concurrency (D6) | multi-instance (daemon+port per env) / single active book-set | single active | pid/info files are singletons (`cli/paths.ts:14-24`) and client hooks target one port; multi-instance is an architecture rewrite nobody asked for |
| Legacy migration | big-bang move into `envs/` at first boot / virtual default | virtual default | Moving operator files at first boot trades the zero-break promise for Windows relocation risk |
| Current-env storage | field inside config.yaml / pointer file | pointer file `envs/current` | A per-env config cannot declare which config is active — chicken-and-egg |

## Decision Outcome

Chosen option: "C-lite runtime layout with the B export boundary, restart-based switching, single active book-set", because book-set integrity only holds when the runtime isolates everything per-env and because the restart boundary is the only one the process model can honestly enforce. (The `virtual default` and JSON-envelope-v1 fragments of the original sentence are superseded by [ADR-0018](./0018-bootstrap-default-no-legacy-layout.md) and the same-day zip amendment — `default` is a scaffolded directory env and the export container is a zip archive.)

### Decision 1 — Content scope & storage layout (D1, D6)

```
~/.opencode-router/                # overridable via OCR_HOME (Decision 2)
├── envs/
│   ├── current                    # pointer file: one line = active env name
│   ├── default/                   # bootstrap env — a scaffolded directory (ADR-0018)
│   │   └── …                      #   same shape as `work/` below
│   ├── work/
│   │   ├── env.json               # { name, type: regular|sandbox, createdAt, schemaVersion, description?, importedFrom? }
│   │   ├── config.yaml
│   │   ├── data/                  # flywheel.jsonl, layer2-decisions.jsonl
│   │   ├── models/                # layer1-classifier.json
│   │   ├── catalog/               # ocr.json, custom.json, overrides.json
│   │   ├── traces/                # traces.db (+WAL/SHM) — trace & FinOps store
│   │   ├── capture/
│   │   └── webauth-secret         # per-env (Decision 4), mode 0600
│   ├── e2e/                       # type: sandbox
│   └── .trash/                    # deleted environments (Decision 7)
├── forward-proxy/                 # CA — stays GLOBAL (OS trust-store anchor)
└── ocr.pid  ocr.log  ocr.info.json  # global daemon artifacts (info gains `env`)
```

- Paths derive from the env name by convention; `env.json` holds metadata
  only. Names match `/^[a-z0-9][a-z0-9_-]{0,31}$/i`, unique case-insensitively (Windows FS); `default` and `current` are reserved.
- ~~`default` is a VIRTUAL environment: no directory, no env.json — its paths
  bind in code to the legacy locations (repo/cwd `config.yaml`, `<cwd>/data`, `<cwd>/models`, `~/.opencode-router/{traces,capture,catalog,webauth-secret}`). Existing users migrate nothing; the console badges default with "legacy locations".~~ **Superseded by ADR-0018**: `default` is a scaffolded directory env (`envs/default/`), legacy locations are never read.**
- Global, never per-env: forward-proxy CA (its cert is anchored in the OS
  trust store; a per-env CA would force cert re-installation on every switch), pid/log/info artifacts (single daemon), `~/.cache/opencode-router`, and the opencode client config (ADR-0011 boundary, Status section).

### Decision 2 — Resolution precedence & the OCR_HOME lever (D7)

- `getOcrHomeDir()` (`cli/paths.ts:5-12`) gains `process.env.OCR_HOME ||`
  `~/.opencode-router` — the single sandbox lever for every home-relative consumer, CA and daemon files included.
- `resolveEnvName()`: `OCR_ENV` > `envs/current` pointer > implicit `default`.
- `getConfigPath(customPath?)`: the explicit `customPath` argument stays
  highest; a named env resolves to `envs/<env>/config.yaml`; `default` keeps the legacy cwd → repo-root chain byte-identical (:117-129) — **that limb is superseded by ADR-0018** (`customPath` > env config, for every env).
- Once any environment exists, the pointer outranks a repo-root
  `config.yaml` (D7) — a UI switch is an explicit intent. Compensation: boot banner `[OCR] env: <name> (config: <path>)`, an `env` field on `/api/admin/status` (`console.ts:342-374`) and in `ocr.info.json`, and a console-header env badge.
- `OCR_ENV` naming a nonexistent env fails the boot loudly — never a silent
  fallback to default.
- dotenv interaction (correcting the exploration note that claimed no `.env`
  loading): `config/index.ts:4,8` imports dotenv and calls `dotenv.config()`, which reads `.env` from the cwd and never overrides existing process env vars. Effective precedence: real process env `OCR_ENV` > `.env` `OCR_ENV` > pointer file.
- ONE new module `backend/src/config/env.ts` (resolve / pointer / CRUD /
  trash + `getEnvPaths()`) rewires every path consumer: `tracker.ts:131-132`, `index.ts:60`, `recorder.ts:329`, `ocr-store.ts:26-30` (its `OCR_CATALOG_PATH` override survives), `collector.ts:35-36`, `decision-capture.ts:56,72`, `trainer.ts:102`, `layer1-classifier.ts:108`, `web-auth.ts:80-82`. A relative `datasetPath` resolves against `envPaths.dataDir`; the default env's dataDir IS `<cwd>/data`, so behavior is unchanged.

### Decision 3 — Restart-based switch (D2)

- The current env is the pointer file `envs/current`, written atomically
  (tmp + rename); an unparseable pointer falls back to default with a loud boot warning.
- Switch = controlled restart reusing `handleRestart` (`console.ts:1601-1617`)
  + `spawnDetachedRestartChild` (`daemon.ts:159-200`) + `adoptRestartParent` (`daemon.ts:210-234`, 15s force-kill backstop included).
- Hard rule: the switch child must NOT inherit the `PORT`/`HOST` pinning the
  same-config restart applies (`daemon.ts:171,189-190`) — the target env's `config.yaml` owns port/host. The child is spawned with `OCR_ENV=<target>`.
- The switch response carries `{ status, env, newPort }`; the console replays
  the `handleRestartGateway` poll-`/health`-reload flow (`Layout.tsx:212-247`) and redirects to the new origin when the port changed.
- Spawn failure → pointer rollback, the gateway keeps serving,
  `status:"failed"` (the existing never-stop-without-a-replacement guarantee is preserved).
- In-process hot switching is explicitly unsupported: the environment must be
  resolved before module import (import-time path singletons); child-process runners satisfy this naturally.

### Decision 4 — Per-env webauth-secret (security fix)

Session tokens are stateless HMACs (`web-auth.ts:117-119`). One global signing key would let a cookie minted in env A verify in env B — a cross-book-set authentication bypass. The secret file therefore moves into `envPaths`: default keeps the existing `~/.opencode-router/webauth-secret`; new envs auto-generate theirs on first boot (existing creation logic `web-auth.ts:100-104`, mode 0600). Switching envs = switching keys = old cookies die naturally; re-login after a switch is the expected UX. The secret is never exported and never copied between envs.

### Decision 5 — Export/import: zip archive, redact-by-default (D3, D5)

- File `<name>-<yyyymmdd>.orc_env.zip` (`application/zip`) — a thin transport
  wrapper around the same ocr-env v1 envelope, so versioning, checksums and
  redaction machinery stay single-sourced (suffix amended 2026-10-12 from
  `.ocrenv.zip` — the underscore form mirrors the OCR_ENV/OCR_HOME naming
  the project already owns):

| zip entry | content |
| --- | --- |
| `manifest.json` | envelope metadata: `{ format: "ocr-env", version, exportedAt, source, secrets, redactedPaths, checksums }` |
| `config.yaml` | the (redacted) config text, verbatim bytes |
| `data/flywheel.jsonl`, `data/layer2-decisions.jsonl`, `models/layer1-classifier.json`, `catalog/custom.json`, `catalog/overrides.json` | payload files at their real env-relative paths (`PAYLOAD_KEYS`), present only when they exist on disk |

- Import unzips with hard guards (`fflate`, sync): entries outside the
  whitelist (`manifest.json`, `config.yaml`, `PAYLOAD_KEYS`) are never
  extracted and never written — unknown/OS-junk entries are skipped, which is
  safe because nothing outside the whitelist can reach disk; per-entry and
  total decompressed-size caps are enforced from the zip central directory
  BEFORE inflation (zip-bomb guard; a whitelisted entry over cap → explicit
  4xx, never a silent skip); `manifest.json` and `config.yaml` are REQUIRED.
  The extracted texts are reassembled into the envelope shape and pass
  through the UNCHANGED `parseAndValidateEnvelope` — checksum verification,
  sentinel stripping, name/type validation have exactly one implementation.
- No legacy import path: the JSON envelope NEVER shipped — this record is
  still uncommitted, so no `.ocrenv.json` file exists in the wild and a
  compatibility branch would be code for users who do not exist. The route
  accepts ONLY zip bodies; the envelope shape survives internally as the
  manifest + extracted-text object handed to `parseAndValidateEnvelope`.
- Included: config + derived text state (the B set). `catalog/ocr.json` is
  excluded — a rebuildable sync cache keyed by `sig`/`builtAt` (`ocr-store.ts:16-24`) that re-syncs after import; `custom.json` (credential-only
  providers' pulled models) and `overrides.json` (the viewer's field-level
  edits — hide/rename/cost/effort, `overrides-store.ts`) are user-authored
  and included. (Amended 2026-10-12: `overrides.json` was MISSING from the
  original payload list — the user caught that hide flags and manual edits
  would not survive an import.)
- Excluded: `traces/`, `capture/` (privacy + size), `ocr.log`. NEVER included:
  `webauth-secret`, the forward-proxy CA, daemon artifacts, and `webAuth.passwordHash` (hash reuse across installs is credential spread).
- Redaction: the secret fields — `adminApiKey` (`config/index.ts:13`),
  `providers[].apiKey` (`types.ts:5`), `apiKeys[].key` (`types.ts:334`), a
  `proxy.url` carrying inline credentials, and `opencode.password` — are
  replaced with the sentinel `"__REDACTED__"` and listed in `redactedPaths`.
  Plaintext export is opt-in only (`?secrets=include` behind an explicit red-styled console checkbox).
- Import: sentinel fields are stripped wholesale (a literal `"__REDACTED__"`
  is never imported as a key value); the config passes the existing parse-object validation (`saveRawConfig` pattern, `config/index.ts:360-363`) and `sanitizeWebAuthInput` (:137-142); the payload whitelist and `path.resolve` prefix check are unchanged; `version` above the supported ceiling → explicit 4xx; below current → sequential migration chain; a create-mode import ALWAYS creates a NEW env (name collision → 409 + a `<name>-imported` suggestion) and never overwrites an existing one. Name override travels as `?name=` (an archive cannot be renamed client-side).
- Payload selection: `?include=` on the export endpoint carries a
  comma-separated subset of `PAYLOAD_KEYS` (unknown keys ignored — the set is
  closed); absent = every payload file that exists. The console export dialog
  defaults the RAW TRAINING DATA off (`data/flywheel.jsonl`,
  `data/layer2-decisions.jsonl` — conversation-derived, potentially large)
  and the knowledge files on (`models/layer1-classifier.json`,
  `catalog/custom.json`); `config.yaml` is always included and not
  selectable. Import needs no counterpart: a payload key absent from the
  archive is already legal — its data starts empty in the new env.
- Optional encryption (amended 2026-10-12 twice): `?encrypt=1` + the
  `x-ocr-archive-password` request header produce a STANDARD zip whose
  entries are AES-256 encrypted in WinZip AE-2 format (`@zip.js/zip.js`),
  under the SAME `.orc_env.zip` name — 360 Zip / 7-Zip / WinRAR / WinZip
  open it with the password alone, no OCR required. The first amendment
  shipped a custom OCRENC1 container (scrypt + AES-256-GCM, full-header
  AAD) that generic tools could not open — the user hit exactly that wall
  with 360 Zip, and compatibility won. Honest costs of AE-2, recorded
  here on purpose: keys derive via PBKDF2-HMAC-SHA1 at the fixed 1000
  iterations (zip.js pins the WinZip value) — a weak KDF, mitigated only
  by password length (console advises 12+ chars); the CRC-32 is stored as
  0 (AE-2) so the archive leaks nothing about the content; and our
  manifest checksums (sha256 over the plaintexts) remain the strong
  integrity layer on import. Rejected on the way: legacy ZipCrypto
  (broken — Biham–Kocher known-plaintext; must never carry API keys).
  Inside the encrypted archive secrets are ALWAYS plaintext — that is the
  point (full backup, no redaction) — so `?encrypt=1` implies
  `secrets=include` and the console locks the plaintext switch on. The
  password travels ONLY in the header, never the query (access logs
  record URLs); the backend enforces non-empty.
  Import is SERVER-DRIVEN about the password: the console uploads blind,
  an encrypted body without the header answers 400 "Archive is encrypted
  — supply the x-ocr-archive-password header", and only then does the UI
  reveal the password field (no client-side magic sniffing); decryption
  failure answers a single 400 ("Archive decryption failed — wrong
  password or corrupted archive"). Unencrypted export keeps
  redact-by-default unchanged. Offline recovery: 360 Zip/7-Zip natively,
  or `scripts/decrypt-archive.ts` (plain-zip re-emit or unpack) on any
  machine with Bun. Library split: `fflate` writes/reads the plaintext
  archives, `@zip.js/zip.js` owns the encrypted path and the uniform read
  (its `filenameValidation: tolerant` keeps hostile NAMES listable — the
  entry whitelist still refuses to extract them).
- Import modes: `?mode=create` (default) ALWAYS creates a NEW env — a name
  collision answers 409 with a `<name>-imported` suggestion and overwrites
  nothing. `?mode=replace` is the RECOVERABLE overwrite for backup restore:
  the OLD book-set moves to `envs/.trash/<name>-<ts>` FIRST (the same
  mechanism as delete — nothing is destroyed), then the archive writes
  through the identical create → write → verify pipeline (via
  `recreateEnv`, the reserved-name-safe scaffold used instead of
  `createEnv`). The bootstrap `default` IS replaceable (amended
  2026-10-12: the original blanket refusal followed delete's rule by
  inertia, but replace's end state keeps `default` in existence —
  trash → scaffold → archive content — which the new-machine restore flow
  needs; `trashEnv` gained `allowBootstrap` for exactly this path, and
  `recreateEnv` scaffolds without the reserved-name check). What stays
  refused, and why: a RUNNING env of ANY name (409 — Windows file locks;
  trashing a directory with open handles fails, so `default`-is-running
  needs the switch-away-first dance; the 409 message spells the way out),
  and a nonexistent target (404 — replace imports INTO an existing env;
  use create). Delete's own refusal of `default` is untouched — a delete
  leaves it GONE, breaking the boot fallback; a replace never does. The
  console surfaces replace only AFTER a create-mode 409, behind an
  explicit confirm dialog that states the trash behavior; a failed replace
  leaves the old content in trash and a possible half-written env is
  trashed by the existing cleanup path (L3 P3-3).

### Decision 6 — Sandbox type & reset

`env.json.type: "regular" | "sandbox"`. Sandbox differs in exactly two ways: the console shows Reset (wipe data/traces/capture, keep config + env.json; refused for the running env — Windows file locks), and scripts treat it as burn-after-run. No automatic reset timer: the process boundary is the isolation.

### Decision 7 — API, CLI, console surface; trash-based delete (D4)

New `backend/src/routes/environments.ts` → `registerEnvironmentRoutes(app)`, registered beside `registerConsoleRoutes`/`registerFlywheelRoutes` (`server.ts:103,110`); every endpoint lands under `/api/admin/*` and is therefore behind the existing webAuth gate (`server.ts:136`):

| Endpoint | Semantics |
| --- | --- |
| `GET /api/admin/environments` | list — name, type, current, running, bootstrap badge, size, createdAt |
| `GET /api/admin/environments/current` | active env + resolved configPath |
| `POST /api/admin/environments` | create `{ name, template: blank/copy-current/copy-default, type }`; blank seeds from `defaultConfigYaml()` (`config/index.ts:320-322`); copy = config only |
| `PATCH /api/admin/environments/:name` | rename / describe (never default/running) |
| `DELETE /api/admin/environments/:name` | move to `envs/.trash/<name>-<ts>` (D4 — no physical delete); body `{confirm:true}`; refuses default/current |
| `POST /api/admin/environments/:name/switch` | pointer write + controlled restart (Decision 3) |
| `POST /api/admin/environments/:name/reset` | sandbox reset (Decision 6) |
| `GET .../:name/export` + `POST /api/admin/environments/import` | zip archive out / in (Decision 5) |

- CLI: `ocr start --env <name>` (flag parsing mirrors `--port`,
  `cli/index.ts:106-110`); `ocr env list|use|create [--sandbox]|reset`. `startDaemon`/`spawnDetachedRestartChild` pass `OCR_ENV` through (Windows inline-set branch `daemon.ts:169-171`); `writeDaemonFiles` records `env` in `ocr.info.json` (:126-145); `ocr status` shows the active book (:62-89).
- Console: `EnvironmentsPage` (`frontend/src/pages/`), route in `App.tsx`
  (:64-85), nav item under `grpSystem` (`Layout.tsx:121-126`) + `ROUTE_META_KEYS` (:131-150); api methods follow the `api.ts` fetch pattern (:568, :790-793); template/type dropdowns use `Combobox` (AGENTS.md rule); all copy via `t()` with paired zh-CN/en-US keys.
- Single active book-set (D6): one daemon, one pid file, one pointer.
  Concurrent multi-env gateways are a non-goal.

## Consequences

**Positive**

- Root-fix for test pollution: `OCR_HOME` + `OCR_ENV` on the
  `scripts/test-isolated.ts` children sandbox every home-relative write (traces.db, capture, catalog, secret); `applyTestEnvOverrides` survives as defense-in-depth.
- A security fix rides along: per-env HMAC secret ends cross-book-set session
  cookie acceptance.
- Real backup/restore story: redact-by-default exports are safe to store
  anywhere; the opt-in plaintext flag covers whole-machine migration.
- Zero-migration compatibility: the virtual default keeps existing installs
  byte-identical until the first env is created; rollback = delete `envs/`.
- Switching reuses battle-proven spawn/adopt/force-kill machinery, Windows
  path included.

**Negative / Risks**

- A switch costs a 2–5s outage plus re-login (the per-env secret invalidates
  old cookies); in-flight requests are cut — the confirm dialog must state both.
- The environment must be resolved before module import (path-caching
  singletons): in-process multi-env testing is structurally impossible, by design.
- Hot switching is explicitly unsupported; future pressure for it re-hits the
  same SQLite handles and boot snapshot.
- Pointer-over-repo-config precedence (D7) changes developer muscle memory;
  compensated by the boot banner + status `env` field + header badge.
- A port change on switch breaks the console origin — the `newPort` redirect
  is a required part of the flow, not a nicety.
- `envs/.trash` accumulates disk usage — the accepted price of recoverable
  deletes.

## Migration plan

| Phase | Content | Completion criterion | Status |
| --- | --- | --- | --- |
| P1 backend substrate | `OCR_HOME` override; `config/env.ts` (resolve/pointer/CRUD/trash); `getConfigPath` env chain; the 9 path consumers rewired; per-env webauth-secret; boot banner + status `env` field | New env-resolution unit tests (precedence chain incl. the fail-fast branch); typecheck clean; `scripts/test-isolated.ts` suite green (553-pass baseline, :13); a manual `OCR_HOME=<tmp> OCR_ENV=demo` boot grows the Decision-1 tree; default behavior byte-identical | Approved |
| P2 API + CLI | `environments.ts` 8 endpoints; switch-restart integration (no PORT/HOST inheritance, pointer rollback, `newPort`); envelope export/import; `ocr env` subcommands + `--env` flag; `ocr.info.json` env field | `app.inject()` tests per endpoint incl. 409/400/traversal-rejection/sentinel-strip branches; a full switch-restart-switchback on a dev machine incl. the port-change scenario | Approved |
| P3 console UI | `EnvironmentsPage` + route/nav/ROUTE_META; 8 `api.ts` methods; zh-CN/en-US key pairs; header env badge | typecheck + `build:frontend` clean; bilingual walkthrough with zero fallback keys; Combobox-only dropdowns; manual create→switch→export→import→reset→delete chain | Approved |
| P4 test/sandbox adoption | `test-isolated.ts` injects `OCR_HOME`/`OCR_ENV` + a real-home snapshot-diff assertion; `full-system-test.ts` runs in a burn-after-run `e2e` sandbox env | Zero diff on a `~/.opencode-router` snapshot across the full suite; the tmp home is deleted after full-system-test; suite green | Scheduled — NOT yet approved |

Rollback: with no pointer file and no `OCR_ENV`, the resolution chain is byte-equivalent to today's behavior at every phase boundary; deleting `envs/` returns the install to the single-book-set world.
