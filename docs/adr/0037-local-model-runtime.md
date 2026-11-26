# ADR-0037 — Local Model Runtime: Download Integrity, Layered Planning, Run Ownership

- Status: Accepted (implemented)
- Date: 2026-11-26

## Context

The Local Models console could already install engines and download or import
GGUF files, but the loop stopped there: nothing could RUN a model, and three
latent defects sat under the part that existed.

- **Gated downloads silently failed.** The HuggingFace token the operator saves
  in Local Settings never reached the download path, so a gated repo answered
  401 no matter what was configured. The download also carried no integrity
  check — a truncated file looked installed until something tried to read it.
- **An engine was one install.** llama.cpp ships per-accelerator builds (CPU /
  Vulkan / CUDA), and the store kept a single record per engine id, so
  installing the Vulkan build evicted the CPU build. The run page asks the
  operator to pick the engine at launch time, which is meaningless when only
  one build can exist at a time.
- **Nothing knew what a file was.** The registry stored name/size/repo only, so
  no layer planning, no engine-support badge and no context ladder were
  possible — everything llama.cpp needs (`-ngl`, `-c`) would have been a guess.

This record closes the loop (download → import → plan → run) and fixes the
three defects underneath it.

## Decision

### 1. Downloads authenticate through the settings chain and verify integrity

Every HuggingFace request — search, file listing, and the model download
itself — resolves its token through `resolveHfToken()` (console setting →
environment → none), the same chain the settings page tests. A gated repo
therefore works exactly when the operator saved a working token; there is no
second credential surface.

The download route takes `size` + `sha256` (hex-64 validated) from the caller —
the marketplace page passes the values the HF API declared for the file — and
verifies the staged bytes before the model is registered. A mismatch fails the
transfer and keeps the partial file out of the registry; import of a local file
is byte-neutral and skips the check (the operator IS the source).

### 2. One engine, many build targets — the state key is `engine:target`

Engine install state is keyed by `engineInstallKey(engineId, target)` and the
install dir is `engines/<id>/<version>-<target>`, so the CPU and Vulkan builds
of llama.cpp coexist and are uninstalled independently (DELETE carries a
mandatory `?target=`). A transfer leg is `engine:<id>:<target|auto>` — `auto`
only while the resolver has not picked a concrete target yet. A legacy
single-target record normalizes on READ (its target is inferred from the
layout); no write path emits the old shape again.

The run page's engine picker lists one row per installed `(engine, target)`
pair — runtime engine selection is the pair, never the bare engine id.

Which targets a release ACTUALLY ships is a runtime fact, not catalog
knowledge: `GET /engines/availability` resolves each engine's current release
(cached 10 min) and answers per-target availability through the same
`matchAssets` the installer uses, so the console disables a chip whose asset
the release does not carry instead of failing the install click. The probe
fails soft — an offline machine keeps every chip enabled. (This is where the
Strata CUDA tail `cuda-<variant>` lives: asset `…-cuda-cuda13.tar.gz` answers
target `cuda13`; hip/sycl/metal tails equal the target id.)

llama.cpp's release walk counts a release only when it ships a
`llama-<tag>-bin-*` asset: the stable `v*` tags carry ONLY a
`nightly-tag.txt` pointer file and sit at the TOP of the release list the day
they ship, so an "any asset at all" rule resolves to the pointer release and
reports every build target unavailable (the v1.1.0 incident, 2026-11-26).
`listTags` applies the same filter, so the version picker never offers a tag
no target could install from.

### 2a. Updating is reinstalling, and an upgrade reclaims what it replaces

There is no separate update endpoint and no version pin to move: an update is
the SAME install call for an existing `(engine, target)`, which resolves the
current release and unpacks into the version-scoped directory.

That makes upgrade detection a pure comparison of two values the console
already receives — the version on the install record, and the version the
current release would install for that target
(`availability.targets[target].version`, falling back to the release tag). The
comparison MUST read the per-target version and never the tag alone: for
llama.cpp they coincide, but for Strata the tag (`v0.2.22`) and the engine
version parsed out of the asset name (`0.1.69`) are different strings, and
comparing a record against the tag would report every Strata install as
outdated forever. Updates are offered per INSTALL, not per card — one target can
be current while another lags behind.

Because the state key is `engine:target`, the record is the only pointer to a
version directory: overwriting it makes the outgoing directory unreachable.
`installEngine` therefore reports `supersededDir` (present only when the
directory still exists) and the install ROUTE deletes it — after the new record
is durable, and only when no run pins a binary inside it (`runs.json` records
the absolute binary path; a live engine's binary must not vanish under it).
The installer stays run-agnostic; a directory kept because of a live run is
only wasted disk, never a broken install, since the record already points at the
new build. The sweep runs before the install result is emitted, so the refresh
that result triggers can never render a row for a version already gone.

### 3. Model identity is the GGUF header, cached on the registry row

`readGgufMeta` (`backend/src/local/gguf.ts`) scans at most 16 MB of the file
head, collects scalar metadata kv pairs (arrays are skipped, values are never
materialized), and stops early at the first `tokenizer.*` key — everything the
planner needs sits before it. v2 and v3 headers both parse.

`listInstalledModels` lazily scans each un-annotated file once and writes the
result back onto the registry row (`InstalledModelMeta`: arch / layers / maxCtx
/ experts / heads / kvHeads / headDim / embedding). From the arch,
`engineSupportFor` derives the two badge axes the console renders:

- `runnable` — the engines that can serve this file (a GGUF → `['llamacpp']`).
- informational `moe` / `strataFamily` — MoE architectures, and within them the
  curated families Strata's own control plane serves (see §6).

The badge is a READ of the file, never a guess from the filename.

### 4. The placement plan is the launch truth

`planPlacement` (`backend/src/local/plan.ts`) is consulted by BOTH the `/plan`
preview route and `startLocalRun` — the numbers the console shows are the
numbers the runner passes, because they come from the same call:

- `ctx 0` in the run options resolves to `autoCtx` (the largest lossless rung
  of the 8K–131072 ladder that fits the memory budget);
- `ngl -1` resolves to `nglForPlan` — every layer when the plan fits VRAM
  (llama.cpp's `999` spelling), otherwise the planner's layer count.

Layered execution IS llama.cpp's `-ngl N`: N layers in VRAM, the rest carried
by RAM, and whatever exceeds the RAM budget streams from disk (mmap). The
planner budgets VRAM at 92% of the detected total minus a 400 MB runtime
reserve, keeps 4 GB of RAM for the system, and estimates KV-cache geometry
from the GGUF header (`heads`/`kvHeads`/`headDim`, F16 = 2 bytes/elem, Q8_0 =
1.125). The speed estimate is a bandwidth model (VRAM ≈ 250, RAM ≈ 110, disk ≈
50 GB/s) — a display figure, never a gate.

The same `/plan` response carries a machine snapshot (GPU names, total and free
VRAM, total and free RAM) for the run console's "this computer" card. It rides
the 60-second detect cache (§7) and does not enter `planPlacement`. Free memory
below the estimate is a warning on the start button, never a new `-ngl` or `ctx`.

### 5. Run ownership mirrors the mihomo sidecar doctrine (ADR-0022)

A RUN is one launched `llama-server` process serving one registry model over
its OpenAI-compatible API. Runs persist as `<ocrHome>/engines/runs.json`, so a
restart never loses sight of a live server:

- A run THIS gateway spawned is bound to the gateway's lifetime —
  `stopSpawnedLocalRunsSync` kills it on `process.on('exit')`, the same
  doctrine as `stopSpawnedMihomoSync`.
- On boot, `restoreLocalRuns` ADOPTS a survivor whose pid still answers its
  health endpoint (the record keeps serving; its log ring starts empty) and
  closes every record whose process is gone.
- `starting` → `ready` migrates on the first healthy poll (`/health`, 503 =
  still loading, `/v1/models` as fallback); a run still loading after
  `LOCAL_RUN_READY_TIMEOUT_MS` (10 min) is killed and marked failed — a wedged
  load is not a server.
- Crash auto-restart is bounded (`LOCAL_RUN_MAX_RESTARTS` = 3 per
  `LOCAL_RUN_RESTART_WINDOW_MS` = 5 min, the counter resets after stable
  serving), and only when the run asked for it.

Ports allocate from `DEFAULT_LOCAL_RUN_PORT` (4800) upward through a
`net.createServer` probe — never a fixed port, never a random one the console
cannot predict. Process output lands in a per-run in-memory ring
(`MIHOMO_LOG_RING_CAPACITY`) the run-log drawer polls; NOTHING is written to
disk. Launches pass `-lv 4`: recent llama.cpp builds print the device
enumeration and the per-device memory breakdown only at that verbosity, and
those lines are how the log drawer proves the layers actually landed on the
GPU the plan chose.

### 6. llama.cpp is the only *unconditional* run target; Strata needs a profile

> **AMENDED by ADR-0038 §4.** The rule below is preserved for every engine whose
> launch spec the gateway can derive from the file alone. Strata's launch inputs
> (pack / PLE table / MTP draft head / expert profile) cannot be derived from a
> GGUF header, so Strata became a real run target the moment the operator could
> supply them as a profile on the model record. The invariant that survives
> verbatim: **a badge is never a launch path** — `strataFamily` alone still
> launches nothing, and `engine-cannot-serve` still refuses when the profile is
> missing, naming that as the missing piece.

Strata's control plane serves only its own curated MoE families — it cannot
load an arbitrary GGUF — so `startLocalRun` originally answered
`engine-cannot-serve` for the `strata` engine with that explanation, and the
console greyed it out of the engine picker. Strata stays installable (the
operator may want the app itself) and the informational `strataFamily` badge
tells the operator when a downloaded MoE model ALSO fits the Strata app. A badge
is never a launch path.

### 7. Detection is cached; planning never re-probes the hardware

The `/plan` route caches the dependency-detect report (GPU/VRAM enumeration)
for 60 seconds — the panel re-asks on every option change, and a PCIe probe
per keystroke-debounce is waste. `startLocalRun` detects fresh: the launch is
the moment the numbers must be true.

## Consequences

- The loop closes: market download (gated included) / file import → badge →
  automatic-layer-plan preview → launch → endpoint → logs, all against one
  registry.
- CPU-only and GPU-backed installs coexist, and the operator picks the build
  per launch — the same model can run on either without reinstalling anything.
- An installed build never silently goes stale: the console compares it against
  what the current release ships for that same target and offers the update in
  place, and taking it reclaims the replaced version instead of leaving an
  unreachable directory behind.
- The plan the operator reads IS the launch configuration; a discrepancy
  between preview and process arguments is a bug by definition.
- A gateway restart never orphans a server it started, and never kills a
  server it merely adopted.
- Strata can never half-work: it is either the Strata app serving its own
  families, or it is not a run target.

## Amendment — 2026-11-26: resource mode and the machine panel

- The planner takes one more input, `headroom` (default true): the run
  console's resource switch ("leave room" vs "full performance") picks between
  two budget constant pairs declared once in `plan.ts` (VRAM ratio 0.92/0.97,
  RAM reserve 4/2 GiB). The launch path threads the same value, so the preview
  bars and the spawned `-ngl` never disagree. An engine-owned placement ignores
  it — the console offers no resource switch there.
- The plan response also carries the machine facts the console's "this
  computer" card reads (`gpus`, `vramFreeMb`, `ramFreeBytes`), the
  backend-owned `ctxLadder` the ctx picker renders (no frontend twin), and the
  plan's `ramReserveBytes`, so no detail string hardcodes the reserve figure.
