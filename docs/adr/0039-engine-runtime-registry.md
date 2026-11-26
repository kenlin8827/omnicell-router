# ADR-0039 — Engines Register A Runtime, The Gateway Names None

- Status: Accepted (implemented)
- Date: 2026-11-26
- Amends: ADR-0038 §4 (the Strata profile is one instance of a general profile), ADR-0037 §6 (the run target set is open)

## Context

ADR-0038 made Strata a second run target. It did so the way a second case is
usually added: with the engine's name in every layer that had to behave
differently.

| Layer | The Strata branch it grew |
| --- | --- |
| `gguf.ts` | `engineSupportFor` hardcoded `['llamacpp']` for any GGUF, then appended `'strata'` when a private arch set matched **and** `opts.strataProfile` was true |
| `runner.ts` | `const isStrata = engine.id === 'strata'`, a profile preflight, a placement bypass, `launchLegs` returning a Strata argv, `visionPort` reserved up front, `servedNameFor` reading `model.strata.modelName` |
| `routes/local-models.ts` | `/plan` had an `if (engineId === 'strata')` branch with a `strata:` payload shaped by that engine's flags |
| `model-store.ts` | `InstalledModel.strata`, `setStrataProfile` |
| console | `StrataLaunchFields` with 15 hardcoded inputs, `choice.engine === 'strata'` in five places, a `strataFamily`-keyed badge |

Every one of those is correct for two engines and wrong for three. The next
engine — vLLM, SGLang, MLX, a second llama.cpp derivative — would have had to be
threaded through all five layers, and each branch would have to be found by
grepping a name. The `strataFamily` badge was already drifting: it encoded an
architecture list in the GGUF *parser*, a module whose only job is reading a
header.

There is a second, quieter problem. `InstalledModel` could hold exactly one
engine's launch profile. A model a release can be served by two engines needs
two, and "one field per engine" is the same mistake as "one branch per engine".

## Decision

### 1. An engine ships an `EngineRuntime`

`backend/src/local/engine-runtime.ts` is the contract. It asks four questions
and nothing else:

```ts
interface EngineRuntime {
  placement: 'gateway' | 'engine';       // who owns ctx / layer split
  accepts: { ngl; threads; flashAttn; kv; reasoning };  // which shared controls apply
  serves(input): EngineServeVerdict;     // can you load THIS file, and if not why
  resolveCtx?(input): number;            // engine-owned placement only
  legs(facts, services): Promise<EngineLeg[] | { error }>;  // what we spawn
  profile?: EngineProfileSpec;           // what the operator must supply
}
```

`EngineLeg` is `{ key, cmd, args, cwd, aux, name?, port? }`. The engine leg is
`aux: false`; a sidecar is `aux: true`, gets its own allocated port through
`services.allocatePort()`, and its death is reported rather than fatal. That
mechanism is general, but it is not a licence to invent a sidecar: an engine
whose images go through a stdin worker has no port to allocate (§7). The run
record stores `aux: Array<{ name, pid, port? }>` instead of
`visionPid`/`visionPort`.

`EngineProfileSpec` carries the schema the console renders (`groups` →
`fields` with i18n keys, kinds, bounds, `required`), the validator the routes
call, the path list the runner preflights, the `describe()` summary the plan
panel prints, and an optional `servedName()`.

Nothing in this module imports the runner, the routes or the model store. A
runtime is data in / data out and is unit-testable alone.

### 2. The gateway asks, never names

- `engineSupportFor(file, meta, profiles)` folds `runtime.serves()` over the
  registry. It holds no engine names. Its result carries a per-engine verdict
  (`serves`, `family`, `needsSetup`, `reason`), so the console explains a
  blocked engine with the engine's own words instead of a translated guess.
- `startLocalRun` gates on that verdict, preflights `profile.paths()`, resolves
  ctx/ngl through `placement` (gateway → `plan.ts`; engine → `resolveCtx`), and
  spawns `legs()`. `launchLegs` is async because a runtime may allocate ports.
- `/plan` answers `mode: 'declared'` with a generic `declaration: { argv,
  features }` — the engine's own summary — so no route knows what `--pack` is.
  The declaration may also carry the engine's own ESTIMATES
  (`estTokPerSec`, `firstLoadBytes` — Strata's load model: the dense half
  resident at VRAM bandwidth, `expertsUsed / experts` of the expert mass
  streamed per token): the console shows them on the same estimate cards as
  the planner's numbers, and `firstLoadBytes` is a FACT (eager bytes), never a
  display number — the console applies its own first-load rate.
- `/engines` returns `runtime: { placement, accepts, profile }` per row. The
  run console renders its controls and its whole profile form from that block;
  `accepts.ngl: false` hides the layer picker, `profile: null` hides the drawer
  section.
- Target recommendation moved onto `EngineDef.recommendTarget(detectSummary)`,
  so `detect.ts` only reports machine facts and the recommended map is keyed by
  whatever engines exist.

### 3. Profiles are keyed by engine, and migrate forward

`InstalledModel.profiles: Record<engineId, unknown>`. Reads go through
`profilesOf()`/`profileFor()`, which fold the legacy `strata` field in; the first
write moves the value into `profiles` and drops the legacy key. One model can
carry a profile per engine, which is what "served by two engines" actually
means. `setEngineProfile(id, engine, raw)` takes its validator from
`engine.runtime.profile.normalize` — the store never learns a field name.

### 4. Registration is the extension point

`registerEngine(def)` / `unregisterEngine(id)` mutate the live registry; every
consumer reads it. A third engine is therefore: one module exporting an
`EngineRuntime`, one catalog entry, nothing else. `engine-registry.test.ts`
registers a `.stub` engine at runtime and asserts gating, catalog exposure and a
real launch through `startLocalRun` — the regression guard for this ADR.

### 5. The adapter is the whole product surface, not just the runner

An engine reaches the operator through six seams, and every one of them is the
engine's own declared data. A name check left in ANY of them is a bug, because
that is where "flexible in theory, hardcoded in practice" hides:

| Seam | Who answers | Gateway codes |
|---|---|---|
| Catalog (name, repo, `descriptionKey`, binary names, build targets) | `EngineDef` | `/engines` maps it verbatim |
| Version tags | `resolveRelease` (one channel) or `listTags` (a stream) | one route, no id check |
| Download + unpack | `matchAssets` + `binaryNames` | `install.ts` walks the def |
| Launch gate | `runtime.serves()` | `engineSupportFor` folds the registry |
| argv + sidecars | `runtime.legs()` | `startLocalRun` spawns what it gets |
| Operator form | `runtime.profile` (`groups`/`fields`/`normalize`/`paths`/`describe`) | the console renders it |

The console is an adapter of the same kind: it names no engine either. Its run
form iterates `runtime.accepts` for the shared controls and
`runtime.profile.groups` for the engine's own inputs, and it takes card text from
`descriptionKey` and block reasons from the verdict. `EngineFieldSpec.kind`
therefore spans the wire shapes a profile can hold — `text`, `number`, `select`
(with literal option values), `boolean` and `list` (`string[]`) — so an engine
whose profile needs an enum, a toggle or an argv list ships the form as data.

Legacy compatibility is confined to two places and both are read paths:
`InstalledModel.profiles` folds the pre-ADR `strata` field in on read (and
migrates on first write), and the old `/models/:id/strata` routes remain as
aliases. No branch anywhere says "if this engine is X".

### 6. A family list is a HINT; a profile is an ASSERTION

The field case that forced this rule: `Swift-Qwen3.8-Flash-Next-…-00001-of-00002.gguf`
reports `general.architecture = qwen4exp` with 512 routed experts. Strata runs it —
the operator had been launching it by hand for weeks — but the curated arch list
did not contain `qwen4exp`, so the verdict said "not this family", the console
dropped Strata from the picker entirely, and a supported model looked unsupported.

An arch whitelist is always behind the vendor. It must therefore gate the
MESSAGE, never the existence of an option:

| File | Verdict |
|---|---|
| Not a GGUF | refuse (the engine loads GGUF shards) |
| Dense checkpoint (no routed experts) | refuse, and SAY it is dense — Strata is a MoE engine |
| MoE, workspace NOT resolvable on disk | `family: true` (documented arch) — still offered, reason names the missing artefact |
| MoE, undocumented arch, workspace resolvable | `serves: true` — the layout is the assertion, and the arch list only colours the badge |

The last row is the important one, and §8 moved it from the profile to the disk.
A complete run config cannot be guessed: it names a pack built for ONE model, so
its existence means someone already ran this model on this engine. What the
verdict asks is therefore "do the artefacts exist", not "did someone type a
path" — refusing on an arch string would be the gateway overriding the operator
with a worse-informed guess.

Because the answer now depends on the code rather than only on the file,
`InstalledModelMeta.scanVersion` (`META_SCAN_VERSION`) records the generation a
cached verdict was computed under; a bump re-derives cached rows once, so an
upgrade never leaves the console showing a verdict this build would no longer give.

### 7. The HTTP surface is not always the engine (field correction)

The first Strata profile modelled the engine's command line as gateway fields and
spawned `strata.exe … --port N`, then polled `N`. Both halves were wrong, and the
launch could never have worked:

- `strata.exe` parses argv itself and treats **any** unknown flag as fatal
  (`unknown argument: --port` → `usage()`, exit 2). It is a resident **stdin**
  worker: `--serve` makes it read `GEN <max_new> <ids>` / `GENI …` lines and
  stream `T <id>` back. There is no socket in it.
- The OpenAI/HTTP surface is `serve/server.py`, which owns `--port`/`--host`,
  spawns `strata … --serve` itself, and spawns the `strata-vision` encoder when
  its config has a `vision` block. `strata-vision.exe` is likewise not a server:
  it reads `ENC <image> <out>` lines from stdin.

The general rule this yields: **`legs()` spawns whatever exposes the endpoint the
gateway will talk to — which may be a launcher, not the model process.** For
Strata that is the vendor front-end, and its `strata-*.json` run config (pack,
native shard, PLE table, expert binary, MTP head, ctx, kv, pool workers, the CUDA
DLL dirs) is the engine command line. Re-typing those as gateway fields duplicated
the vendor's file and got `--port` and `--prefill` wrong, so the profile carries
only what the config does not — and §8 then removed even that by generating the
config itself.

Consequences visible in the console, all of them "no dead control":

| Knob | Why it is hidden for Strata |
|---|---|
| `-ngl` / layer bars | the engine's `--expert-cache` owns placement; `ngl` is `-1` |
| Flash Attention / KV Q8 | both live in the config's `args`; the front-end takes neither flag |
| ctx ladder | still offered: the picked ctx IS the config's `--max-context`, because the config is generated per launch (§8) |
| threaded/ngl preview | `/plan` answers `mode: 'declared'` with the front-end argv |

The declaration is not a re-statement of the profile: `describe()` and
`servedName()` answer from the same layout the launch uses, so the MTP / PLE /
Vision rows and the served `model_name` are what the engine will actually use.

### 8. Nobody types a directory: the config is generated (field correction)

The §7 profile still asked the operator for `root` and `config`. That was the
wrong ask, for a reason the operator put plainly: *the engine is ours, we know
Strata, we build the config*. Both halves are true, and neither needs a form.

- **The layout is discoverable.** A Strata workspace is
  `<ws>/Strata-main/serve/server.py` beside `<ws>/Strata-data/{packs,models,mtp}`,
  and a registry path already points inside it
  (`…/Strata-data/models/<MODEL>/shard-00001-of-00002.gguf`). The model file is
  the anchor: walk up for `serve/server.py`, find the sibling data root by the
  presence of `packs/` and `models/`, match the pack by the model's own folder
  name. Every step is a stat that must succeed.
- **The config is ours to write.** `strataEngineArgs` builds the engine command
  line from the resolved layout plus the run's resolved ctx, and
  `writeStrataConfig` puts it under `<home>/strata/configs/<pack>-ctx<N>.json`.
  `exe` is the INSTALLED binary from the engine record — the engine we installed
  is the engine that runs.

What the layout refuses to guess:

| Situation | Behaviour |
|---|---|
| two packs match equally | refuse, naming both — the wrong pack runs the wrong weights |
| no `serve/server.py` | refuse, naming the tree it looked for and where |
| no `.venv` interpreter | refuse, naming the interpreter |
| dense checkpoint | refuse (unchanged, inherited from the engine's own nature) |

The profile survives as OPTIONAL overrides for artefacts discovery cannot see
(`mtp`, `mmproj` — the installation facts moved to engine setup in §10, and
the pack override was dropped in §11) plus the two knobs that are genuinely
per-launch (`kv`, `maxContext`). An empty record is the normal
case, `needsSetup` is never set by this engine, and `serves()` no longer gates
on anything the operator must supply.

Two consequences elsewhere:

- `EngineProfileSpec.describe()` / `servedName()` take the model path
  (`EngineProfileWhere`) because an empty profile is a valid answer and the
  layout needs the anchor. A profile-shaped summary would have to invent it.
- `META_SCAN_VERSION` went to 3: a generation-2 row was cached under "no
  profile, no launch", a question this build no longer asks.

### 9. The pack is ours to BUILD too (2026-11-26)

§8 removed the config form; one refusal remained — "a built pack for this
model". That ask was wrong for the same reason §8's was: the packer is the
workspace's own tooling (`tools/iq_pack.py`), the gateway already resolves the
workspace, and the pack's output name is the vendor's own convention (the
model's folder, lowercased — the exact-name candidate `matchPack` tries
first). The operator never runs the packer by hand.

- **`EngineRuntime.build?` is the capability**, registry-native like
  everything else here: it returns legs exactly as `legs()` does, minus ports
  — a build serves nothing. Strata's build is ONE leg:
  `python tools/iq_pack.py --gguf <shard 1> --out packs/<model-folder-lower>`.
- **A build is NOT a run** (`local/build-jobs.ts`): no port, no health probe,
  no adoption, no restart budget. Legs spawn in order, output streams into a
  per-job log ring, and the job ends `done` / `failed`. One active build per
  (model, engine) — two packers on one pack dir would interleave writes into a
  single weight set. Build and run logs share the runner's line sanitizer and
  pipe draining, so both drawers read identically.
- **Interruption safety is the packer's own contract, enforced on our side.**
  `iq_pack.py` publishes `native_experts.txt` LAST ("a pack without it is not
  finished"), and `looksLikePack` now REQUIRES it: a half-built pack — an
  interrupted build's residue — never matches and can never be served.
- **The verdict carries the offer.** `EngineServeVerdict.buildable` is set
  when the ONLY missing artefact is the pack (the workspace, the interpreter
  and the packer all resolve). A pack tie stays an operator decision, never a
  build trigger: building publishes under the exact-match name and would
  silently pick a winner. The console renders its build actions from the
  flag — a Pack button on the model row (import → pack → run), build-and-run
  on the run page — and names no engine.
- **Completion flips the gate.** A finished build rescans the model's meta
  (`rescanModelMeta`) — the verdicts are a function of the disk, and the pack
  is new disk state — so the console's next poll makes the engine launchable
  with no restart and no profile.

### 10. Installation facts are ENGINE setup, not per-model runtime (2026-11-26)

§8 left three overrides in the per-model profile that were never model facts:
`workspace`, `dataRoot`, `python` describe the INSTALLATION — one set per
machine, shared by every model. Kept per model, a discovery failure had to be
re-typed for every model; that is the wrong layer.

- **`EngineRuntime.setup?` is the contract** (`EngineSetupSpec`: intro +
  `EngineFieldSpec[]` + `normalize`), serialized on `/engines` rows like the
  profile spec, rendered generically on the engines page, stored under
  `engineSetup[engineId]` in `local-settings.json`. The settings route
  validates through the owning engine's `normalize` and knows no field names.
- **Resolution chain: setup → env (`STRATA_HOME`/`STRATA_DATA`) → discovery
  from the model path → binary anchor.** An explicit install path is operator
  intent, so it precedes discovery; a model inside another tree still resolves
  against its own tree when no setup names one.
- **The form pre-fills what discovery found (2026-11-26, amended).** A setup
  field may declare `picker: 'directory' | 'file'` (rendered with the
  server-side `FilePickerModal`) and the spec may ship
  `resolve(ctx): Record<string, string>` — the SAME discovery chain minus the
  model path and minus the stored overrides (a stale pin must not echo back
  as the discovered answer). The settings route exposes the result as
  `engineSetupResolved`; the console displays stored ?? resolved and saving
  pins the DISPLAYED values, so the path the operator sees is the path that
  runs. Emptying a field hands it back to discovery. A field whose resolved
  value FOLLOWS another setting (Strata's `python` ← the workspace's `.venv`)
  declares `derived: true`: its resolved value rides the placeholder as a
  ghost and is never pinned unedited — pinning a derived value only makes it
  stale when the field it follows moves.
- **The per-model profile drops the three keys.** `normalize` already drops
  unknown keys, so a stored `workspace`/`root` from an older build is ignored,
  not fatal. What stays per model is what is genuinely per model: the
  `mtp`/`mmproj` escape hatches and the launch tuning (`kv`, `maxContext`).
  The pack directory itself stays UNCONFIGURABLE (§9, hardened in §11): it is
  derived from the model's folder name under the data root, and the build
  publishes there.

### 11. The pack override is gone too (2026-11-26)

§8 left `pack` in the profile as the tie-breaker for two equally matching
packs. Rendered as a form field, it read as "configure your pack" to every
operator who would never see a tie — the one case it served is the once-ever
collision, and a field that exists for it makes the normal case look
incomplete. `StrataProfile.pack` is dropped:

- **Matching is the matcher's, building is the builder's, and that is all.**
  `resolveStrataLayout` calls `matchPack` unconditionally; a stored `pack` key
  from an older build is ignored by `normalize` like every other retired key.
- **A tie is broken on disk, not in a form.** The refusal still names both
  candidates and now also names the fix — rename or remove all but the pack
  built from this model. A pack path typed into a form was never a safe way to
  arbitrate provenance anyway: the choice belongs where the evidence is, in
  the packs directory itself.

### 12. The server.py contract, verified against its source (2026-11-26)

A review of the vendor front-end (`serve/server.py`, ~5000 lines) settled how
deep the integration may go. The findings, each with its consequence:

- **server.py is a SUPERVISOR, not a shim.** It owns the tokenizer, the chat
  template, request admission (FIFO + batch slots), the vision encoder, an
  engine restart budget (3 tries), and an engine-silence watchdog (300 s).
  Spawning `strata.exe` directly would mean reimplementing all of it — the
  exe is a stdin worker with no tokenizer and a zero-tolerance argv parser
  (any unknown flag exits 2). The gateway's own `autoRestart` stacks on top:
  server.py restarts the ENGINE, the runner restarts server.py.
- **The readiness contract holds by construction.** `StrataEngine.__init__`
  blocks until the engine prints `READY`, and only then does server.py bind
  its port. The runner's connect-based probe therefore reads a multi-minute
  cold load as connection-refused = `starting`, flipping to `ready` exactly
  when the server can answer; `LOCAL_RUN_READY_TIMEOUT_MS` (10 min) guards
  the window. **`--lazy` / `lazy_load` / `idle_unload_s` must never appear in
  a generated config**: they invert the contract (port before weights — a
  200 `/health` with `loaded:false` would mark the run ready while the first
  request blocks for minutes). The generator writes none of them.
- **`parallel` is the one concurrency knob, and it is a config key, not an
  engine flag.** `"parallel": N` (2-8) becomes the engine's `--batch N` inside
  server.py (`parallel_args()`); writing `--batch` into `args` would bypass
  the server's bookkeeping. It is exposed as an optional per-model profile
  field. The gateway deliberately computes NO recommended value: the vendor's
  rule (expert cache must hold ≥ half the experts beside the slots; slots ≤ a
  fifth of it; ≤ 4 slots — each ~0.56 GiB VRAM at 32K, 10-25% per-request
  cost when experts mostly stream from RAM) lives in the vendor's setup and
  evolves with it; the engine clamps any ask to what fits, so the field is
  safe at any value and empty (one at a time) stays the right default for
  single-card machines.
- **The launch drawer's `extraArgs` land on the ENGINE** (the config's
  `args`): they are for engine flags (`--pool-workers`, `--adapt-async`, …).
  A server-level flag typed there (`--gpu`, `--lazy`) reaches an exe that
  exits 2 on unknown arguments — the same footgun every engine's raw-argv
  field carries, documented rather than papered over.
- **`--gpu` / multi-GPU layer split stays unwired on purpose.** server.py
  accepts `gpu` (one card or a split list) and computes `layer_split`, but
  the right default for the machines this gateway sees is the one-card
  launch; a multi-GPU picker needs the detection plumbing first, and a
  half-fed `gpu` value is worse than none.

### 13. The layout is the gateway's, not a checkout beside the model (2026-11-27)

§8 walked up from the model file to a vendor tree
(`Strata-main/serve/server.py` beside `Strata-data`). That tree is a developer
checkout. A machine that only installed the engine has `strata.exe` and
`strata-vision.exe` under `<ocrHome>/engines/strata/<version>-<target>`, and
nothing else. The exe is still not an HTTP server (§7), so the install also
takes the release's control bundle.

- **Two directories, both under the gateway home.** `<ocrHome>/strata/runtime`
  is the control bundle (`serve/server.py` and the Python it ships).
  `<ocrHome>/strata/data` holds `packs/`, `models/` and `mtp/`, and is created
  when a launch needs it. Generated configs stay in `<ocrHome>/strata/configs`.
  The model file stays wherever the registry put it. Pack matching is by the
  model's folder name, under our data directory.
- **The exe is the one this gateway installed.** A binary sitting inside the
  runtime tree is not a second engine and is never preferred.
- **Cached verdicts rescan.** `META_SCAN_VERSION` is 5. A generation-4 row
  could say `serves: true` off a checkout beside the model file, and it never
  carried `buildable` for a pack that now lives under the gateway data
  directory. The models page reads `family` for compatibility, `buildable`
  for the Pack button, and `reason` for why a compatible model is not
  runnable yet.
- **The engines page shows those paths.** `setup.resolve` returns
  `runtime`, `data` and the interpreter (`runtime/python/python.exe`, else the
  directory's `.venv`) whether or not the files exist yet. An empty box that
  says "auto" hides the directory the install uses. A pin still overrides, and
  a pin that does not look like the thing it names is ignored. Clearing a
  field returns it to these directories.
- **The control bundle is a companion asset**, not part of the engine
  archive: `strata-control-<engineVer>-<os>-<arch>.zip` (Windows) or `.tar.gz`,
  unpacked into `strata/runtime`. The engine archive still installs on its
  own; a release without the bundle leaves launch naming the missing
  front-end.

## Consequences

- Adding an engine touches: its own runtime module, its catalog entry, its i18n
  labels, its profile field descriptor. It does **not** touch the runner, the
  routes, the model store, `gguf.ts` or the console.
- The console's run form is now data-driven. A profile field that is not in a
  descriptor cannot be typed in; a field an operator hand-wrote and the console
  does not render survives a save untouched (the form clones the stored object
  and overlays only its own keys).
- Blocked engines speak for themselves. Their refusal is English text from the
  runtime, not a localized string — the trade is deliberate: a precise reason
  beats a wrong translation, and the same text lands in the run log.
- No shared shape names an engine. `strataFamily` was the last one: it is gone
  from `EngineSupport` and from newly written meta (the field survives as an
  optional, deprecated read for records cached before this ADR). Every family
  claim now lives in the per-engine verdict (`engines[id].family`), which is what
  the console reads.
- The layer planner is untouched and remains the only placement estimator; an
  `EngineRuntime` that declares `placement: 'engine'` is never given layer bars.
- A runtime may spawn a launcher rather than the model binary (§7). What it must
  never do is assume the two are the same process, or that an engine wants the
  gateway's `--port`.

## Amendment — 2026-11-26: capability switches and dropdown profile fields

- `EngineRunControls` gains `spec` and `vision`. They name CAPABILITIES (a
  speculative draft head, a vision leg), never mechanisms: the run console
  renders an auto/off switch for each, and the engine's profile owns how "off"
  is expressed. Strata's expression is the `'off'` sentinel on its `mtp` /
  `mmproj` profile keys — discovery is skipped, the launch runs text-only or
  draft-free, and the declaration chips follow. A console that writes the
  sentinel still names no engine: it writes the key the engine's own field
  descriptor declares.
- Profile fields render as dropdowns, never native `<select>`: a `select`
  field's options may carry `labelKey` (i18n) beside the literal label, and
  `customizable: true` appends a "custom…" entry that swaps the dropdown for
  the typed path input — the common case is a pick, the rare path override
  stays possible. Strata's `maxContext` is a select over `CTX_LADDER` (the
  same ladder the run page's ctx picker shows — one source, one climb).
