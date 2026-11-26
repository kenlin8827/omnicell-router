# ADR-0038 — Local Models As One Routable Provider, Strata As A Second Run Target

- Status: Accepted (implemented)
- Date: 2026-11-26
- Amends: ADR-0037 §6 (llama.cpp is no longer the *only* run target)
- Amended by: ADR-0039 (its Strata-specific profile and run branches become one `EngineRuntime` contract)

## Context

ADR-0037 §6 closed the local runtime at "installable, never serves": `Strata`'s
control plane was read as unable to load an arbitrary GGUF, so `startLocalRun`
answered `engine-cannot-serve` unconditionally and the console dropped the engine
from the picker. Two facts make that rule wrong in practice:

- **The refusal fired on the models the rule was written FOR.** The curated MoE
  families Strata targets (`qwen3next`, `qwen3moe`, `deepseek2`, `glm4moe`,
  `gpt-oss`) are exactly what operators download here. A rule that exists to
  protect "Strata's own families" refused every one of them, and its message
  ("Strata serves only its own curated MoE families") read as a contradiction to
  anyone holding such a file.
- **Operators were already serving them.** `strata.exe --pack … --native …`
  works today; the model was a *build artifact* (a pack directory) plus an
  optional PLE table, MTP draft head and expert profile. None of those are
  derivable from the GGUF header — which is why a generic runner could not invent
  the command line, and why the honest conclusion was "no launch path", not
  "unsupported model".

Separately, a run dead-ended at the console: `startLocalRun` returned a port and
a log ring, but nothing routable existed. Clients had to be pointed at
`127.0.0.1:<port>/v1` directly, which abandoned OCR's routing, capture, protocol
conversion and key discipline for exactly the traffic an operator runs locally.

The conceptual error underneath both was treating "provider" as one thing. It is
two: a client-addressable **namespace**, and a **static upstream record**. The
namespace should be flat and stable; the record cannot be, because a local
endpoint is a port that changes on every launch.

## Decision

### 1. One `local` provider — the endpoint belongs to the MODEL, not the provider

`local` is a **core-owned** provider: synthesized by the direct-pool builder and
reconciled by `applyDirectPool` like any other, but never written to
`providers.json`, never part of a credential chain, never a quota subject, never
a sync-client materialization target. ADR-0010 is untouched: the defs file stays
the single truth for *operator-defined* providers, and `local` is not one.

Every installed model registers as `local/<registry id>` with
`provider: 'local'`, `upstreamModel` = the name the local server answers, and
`tier: undefined` — it joins no pool unless a member list claims it, so a local
run never silently enters `auto`'s candidate set.

The provider's `baseUrl` is a SENTINEL that is never dialed. The real base is
resolved per model at call time, through the seam that already existed:
`LLMProvider.dialBaseFor(model)` — it has always taken the model and three of the
four executors ignored it. The local executor is therefore a **decorator**: it
resolves the base for the model, caches one inner `OpenAIChatProvider` per base,
and delegates. No executor rewrite, and no function smuggled into `ProviderConfig`
(a serializable record must stay serializable).

Why not one provider instance per model (or per run)? Because the client contract
would then encode infrastructure: `local/run-8f3a`, or a port. Ports are
allocated from 4800 upward per launch and are explicitly not a contract
(ADR-0037). The flat namespace `local/<model>` is the only spelling that survives
a restart.

### 2. Three constraints the single-provider shape must not break

- **Breakers stay per model.** The key is `modelId::keyHashPrefix` (ADR-0004's
  pair model), so N local models under ONE provider row carry N independent
  breakers. A shared provider does not mean a shared trip.
- **Quota is skipped entirely.** The provider is keyless — no credential, no
  prefix, no probe, no `quota_events` row. Local compute consumes no vendor
  quota; synthesizing a bucket for it would put a fiction in a ledger that exists
  to record facts.
- **Cost is DECLARED zero, not derived zero.** ADR-0035 forbids fabricating a
  price where the vendor published none. Local inference's marginal cost is
  genuinely zero, so the registration states `pricing: 0` and every cost surface
  reads a true number. The distinction that matters is "known zero" vs "unknown",
  and here it is known.

### 3. A stopped run is a STATE, not a connection failure

Resolution fails **before** any dial with `local_run_inactive`, answered 503 with
a message naming the model and the page that starts it. The error carries
`breakerExempt`, so the breaker never records it: an operator stop is not
upstream flakiness, and letting it trip a breaker would turn a deliberate action
into a cooldown.

A local model stays **registered while stopped**. Ids therefore never flap in
client configs, and a tier member list or combo can reference a local model that
is currently off. Health reads `unavailable` (ADR-0004's vocabulary), which is
what eviction keys on (ADR-0002) — a stopped run is not a routing candidate, but
it is still an address.

### 4. Strata is a real run target; its launch inputs are GENERATED, not typed

*The first version of this section made a hand-filled profile the launch gate
("pack / mtp / pleGguf / expertProfile are mandatory", with a `vision` aux leg
the gateway spawned). ADR-0039 §7–§8 reversed both: the workspace layout is
discoverable from the model's own registry path, `writeStrataConfig` generates
the run config under `<home>/strata/configs/`, the vision encoder is
`server.py`'s own child, and the profile survives only as OPTIONAL overrides —
an empty record is the normal case and `needsSetup` is never set.
`strataFamily` no longer exists either: family claims live in the per-engine
verdict (`engines[id].family`). What survives here is the console contract:*

- **The gateway owns port allocation**; a profile never carries a fixed port,
  because a fixed port is the one thing two concurrent runs cannot share.
- **The host is `127.0.0.1`, with no override.** A local engine is an upstream
  of the gateway, never a second public face. The retired `lan` run option let
  a launch bind `0.0.0.0`, which would have published a second API surface with
  no routing, no cascade, no quota, no breaker, no capture and no protocol
  conversion — the exact guarantees that make the gateway worth running — and
  it bought nothing a client cannot get from the gateway port, because the
  gateway keeps dialing loopback either way (`localBaseFor`). Diagnosing a
  engine belongs to the console's own API testing, not to a bypass listener. So
  the console shows the loopback endpoint as debug info only and points external
  callers at the gateway identity (`local/<name ?? installedId>`, §7). Nothing about local
  models depends on `host` reaching `EngineLegFacts` with any other value.
  Loopback stays direct in the egress policy (ADR-0018), so a local leg never
  crosses a proxy.
- **One parameter drawer, nothing mirrored.** A knob that already exists as a
  run option is NOT repeated in a profile form, because two controls for one
  value is how a console starts lying about what it launches: ctx belongs to
  the page's context ladder, KV precision to the acceleration panel
  (llama.cpp's `kvCacheQ8`) or the engine profile override (Strata's generated
  `--kv`), extra argv to the drawer's extra-arguments field. The drawer is
  data-driven from the engine's `EngineProfileSpec` (ADR-0039) — the console
  names no engine and no field.

**Run navigates, the launch is an explicit click (2026-11-26, amended
2026-12).** The installed-models page's Run button links to
`/local-run?model=<id>` — it preselects the model and stops there. The launch
itself is the run page's Start button: arriving on the page never spawns a
process, because loading weights is expensive, holds VRAM and is not always
what the operator came for (they may want to inspect the plan or tune a knob
first). The automatic parameter set is still the DEFAULT the page computes
(the planner's auto ctx/layer split for gateway-placed engines, the generated
config for Strata), so "automatic by default, tunable after" remains one
surface — the `autostart` URL flag and its one-shot consumer are retired.

**A ready run advertises the GATEWAY, not the engine.** The ready block leads
with the model's gateway id (`local/<name ?? installedId>`, §7), the gateway base URL and
a copyable cURL quick call — the registration rides every pool rebuild (§1),
so the id is callable the moment the run reports ready, with routing, capture
and protocol conversion applied. The raw engine endpoint is demoted to a debug
line: pointing a client at `127.0.0.1:<port>/v1` is exactly the bypass this
ADR exists to retire.

### 5. The planner does not plan Strata

Strata has no `-ngl`. Placement is owned by `--expert-cache auto`, and the
operator's levers are `--max-context`, `--kv` and `--pool-workers`.
`planPlacement` / `nglForPlan` are therefore **bypassed** for a Strata launch:
the run record's `ngl` stays `-1` (not applicable) and the console shows the
declared profile instead of the layer bars.

This follows ADR-0037's own rule — *the plan the operator reads IS the launch
configuration; a discrepancy is a bug*. A Strata "plan" would be an estimate of a
decision the engine makes internally, so there is no preview to contradict, and
the console must say so rather than draw bars it cannot honor.

### 6. One refresh path

Local registrations ride the existing `buildDirectPool` → `applyDirectPool`
reconciliation. A provider-def save, a catalog auto-pull, a model install and a
run start all land through the SAME builder, so there is no second registry
surface to keep in sync and no "local models went stale after a config save"
class of bug.

### 7. Operator-chosen names (2026-11-26)

A registry record may carry an optional `name`: a short operator-chosen token
(`MODEL_NAME_RE` — 1–64 chars of letters, digits, `.`, `_`, `-`, starting with
a letter or digit), unique case-insensitively across the registry. The name is
a gateway-facing alias ONLY:

- **The registry key never moves.** `installed.json` stays keyed by
  `<repo>/<filename>`; runs, profiles, build jobs and the file on disk stay
  anchored to it. A rename touches exactly one field on the record.
- **The registration id follows the name.** `localModelId(record)` is
  `local/<name>` when set, else `local/<repo>/<filename>`. Reverse resolution
  (`installedIdFromLocal`) matches an operator name against the registry FIRST,
  then falls back to the literal slice — so `local/<name>` routes to the record
  and the unnamed spelling keeps working for records without a name.
- **The engine answers as the name.** The served alias rides the launch facts
  (`servedName`): llama.cpp gets `--alias <name>`, Strata's generated config
  gets `model_name: <name>`, so the upstream `model` the gateway sends matches
  what the server advertises. `servedNameFor` reads the operator name before
  any engine-profile spelling and before the file stem.
- **A rename is loud, never silent-rewriting.** The rename route scans the
  config for references to the OLD gateway id (tier members and excludes,
  combos, API-key model access, classifier and default-model settings) and
  returns them as `references[]` in the response; the operator rewrites them
  deliberately. Nothing is patched in place, because a silently retargeted tier
  member is exactly the "the router quietly decided" failure mode §1 exists to
  prevent.
- **The pool refresh rides §6**: a rename rebuilds registrations through the
  same `buildDirectPool` path, so `/v1/models` shows the new id immediately.

## Consequences

- A client configures `local/<model>` once and keeps it across restarts, port
  changes and engine switches.
- The console's Local Models page becomes the only place a server's lifecycle is
  managed, while OCR's normal surfaces — routing, capture, protocol conversion,
  key discipline — apply to that traffic unchanged.
- `engine-cannot-serve` now names the missing piece: no profile, foreign family,
  or engine not installed. The generic "cannot serve this file" remains for
  engines whose constraint is genuinely about the file.
- Stopped models appear in `/v1/models` with `unavailable` health. This is
  deliberate: an advertised id that 503s with an explanation is easier to live
  with than an id that vanishes and silently changes what `auto` can reach.
- Adding a THIRD engine later means a new launch spec, not a new provider: the
  provider/endpoint split is what makes that a local change.

## Related

- ADR-0037 — local runtime; §6 amended here.
- ADR-0004 — health vocabulary and the `(model, credential)` breaker pair.
- ADR-0009 — quota is credential-anchored; a keyless provider has no bucket.
- ADR-0010 — provider-def ownership; `local` is core-owned, not a def.
- ADR-0022 — outbound policy; loopback stays direct, so a local leg never
  traverses the outbound proxy.
- ADR-0035 — cost is never fabricated; a declared zero is a fact, not a fallback.
