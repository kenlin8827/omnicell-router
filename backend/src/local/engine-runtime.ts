/**
 * The local-engine RUNTIME contract — the one interface an inference engine
 * implements to become launchable by the gateway.
 *
 * ADR-0039 generalises ADR-0038's Strata finding: installing an engine and
 * RUNNING it are different facts, and the second one is per-engine behaviour
 * the gateway must not know about by name. Before this module every such
 * behaviour was a branch on `engine === 'strata'` spread across gguf.ts,
 * runner.ts, routes/local-models.ts and the console — adding a third engine
 * meant touching all of them. Now each engine ships a `EngineRuntime` and the
 * gateway only asks the questions below:
 *
 *   serves()      can you load THIS file?              (gating + badges)
 *   placement     who owns ctx/ngl, the planner or you?
 *   legs()        what exactly do we spawn?
 *   profile       what must the operator supply, and how is it validated?
 *
 * Nothing here imports the runner, the routes or the model store — the
 * contract is data in, data out, so a runtime is unit-testable on its own and
 * a new engine (vLLM, SGLang, MLX, …) lands as ONE module plus one catalog
 * entry, with zero edits to the runner, the routes or the console.
 */
import type { GgufMeta } from './gguf.js';

/** What a runtime is asked about a file before anything is spawned. */
export interface EngineServeInput {
  /** Registry path of the weights (shard 1 for a split file). */
  modelPath: string;
  /** Parsed GGUF header, or null when the file is not a readable GGUF. */
  meta: GgufMeta | null;
  /** The operator's stored profile for THIS engine, when there is one. */
  profile: unknown;
}

/**
 * One engine's answer about one file. `serves` is the launch gate; `reason` is
 * operator-facing text (it is shown verbatim) and must name WHICH piece is
 * missing — "cannot serve this model" once sent operators hunting for a broken
 * file when the real answer was "you never built a pack".
 */
export interface EngineServeVerdict {
  serves: boolean;
  /** The file IS in this engine's family (badge material), independent of setup. */
  family?: boolean;
  /** Family matched, but an operator-supplied launch input is missing/partial. */
  needsSetup?: boolean;
  /** The missing launch input is one the ENGINE can build itself (Strata: the
   *  pack, via the workspace's own tooling) — the console offers a build
   *  action instead of a form. Only meaningful when `serves` is false. */
  buildable?: boolean;
  /** Operator-facing refusal; required when `serves` is false. */
  reason?: string;
}

/** One spawnable process of a run. The engine leg is first, aux legs follow. */
export interface EngineLeg {
  /** `children` map key: the run id for the engine, `<runId>#<name>` for aux. */
  key: string;
  cmd: string;
  args: string[];
  /** Working directory — the binary's own, so its DLLs/runtimes resolve. */
  cwd: string;
  /** True for a sidecar process whose failure is reported, never fatal. */
  aux: boolean;
  /** Short name for logs and status rows (`vision`); defaults to the key tail. */
  name?: string;
  /** The port this leg listens on, when it has one (shown, and stop-relevant). */
  port?: number;
}

/**
 * The run-option slice a runtime may read. Structural on purpose: the runner
 * passes its own `LocalRunOptions`, and the runtime never needs the rest
 * (`autoRestart` is the supervisor's, not the engine's).
 */
export interface EngineRunOptions {
  flashAttn: boolean;
  kvCacheQ8: boolean;
  reasoning: boolean;
  threads: number;
  /** Raw argv from the launch-parameter drawer, applied verbatim to the engine leg. */
  extraArgs: string[];
}

/** Facts one launch hands to a runtime — already resolved, never re-derived. */
export interface EngineRunFacts {
  /** Run id: the engine leg's key, and the prefix of every aux key. */
  runId: string;
  /** Registry weights path. */
  modelPath: string;
  /** Stored profile for this engine (engine-owned shape). */
  profile: unknown;
  /**
   * The operator-chosen model name (ADR-0038 §7), when one is set. An engine
   * that can name its served model (llama.cpp's `--alias`, Strata's
   * `model_name`) honors it, so the name the server answers as IS the tail of
   * the gateway id — a client and the console never disagree. Absent = the
   * engine's own default naming.
   */
  servedName?: string;
  port: number;
  host: string;
  /** Resolved context. */
  ctx: number;
  /** Resolved GPU layer count; -1 when placement is not the gateway's. */
  ngl: number;
  options: EngineRunOptions;
  backend: string;
  target: string;
  binary: string;
}

/** Port allocation for auxiliary legs (never a fixed port — ADR-0037 §5). */
export interface EngineLegServices {
  allocatePort(): Promise<number>;
}

/**
 * Facts one build job hands to a runtime (ADR-0039 §9) — already resolved,
 * never re-derived. A build produces the launch input the engine DERIVES:
 * Strata packs the GGUF with the workspace's own tooling, so the operator
 * never runs `iq_pack.py` by hand.
 */
export interface EngineBuildInput {
  /** Job id: the build leg's key and the log ring's. */
  jobId: string;
  /** Registry weights path (shard 1 for a split file). */
  modelPath: string;
  /** Stored profile for this engine (engine-owned shape). */
  profile: unknown;
  /** The installed engine binary, when one is installed (discovery fallback). */
  binary?: string;
}

/** What a launch will declare, for the console's plan panel. */
export interface EngineDeclaration {
  /** Flags the launch passes, as the operator would read them. */
  argv: string[];
  /** Capability rows the profile switches on or off (MTP / PLE / vision …). */
  features: Array<{ label: string; on: boolean }>;
  /** Rough decode speed (tokens/s) from the ENGINE'S OWN load model (Strata:
   *  dense half resident, experts streamed) — the console shows it exactly as
   *  it shows the gateway planner's estimate. Absent = no estimate. */
  estTokPerSec?: number;
  /** Bytes the engine maps EAGERLY at load (Strata: the pack's dense half +
   *  index, not the whole GGUF). A fact, not a display number: the console
   *  turns it into the first-load readout with its own rate, so the estimate
   *  base is never a duplicated heuristic. */
  firstLoadBytes?: number;
}

/** One choice of a `select` field. */
export interface EngineFieldOption {
  /** The stored value (`int8`) — never translated: it is a flag value. */
  value: string;
  /** Literal label; flag values are not prose, so they carry no i18n key. */
  label: string;
  /** i18n key of the label — for prose choices like "off"; wins over `label`. */
  labelKey?: string;
}

/**
 * One operator-supplied profile input the console renders.
 *
 * The kinds are the WIRE SHAPES a profile can hold, not llama.cpp's needs: a
 * new engine whose profile has an enum, a toggle or an argv list expresses it
 * here and the console renders it without an edit (ADR-0039). `list` splits on
 * whitespace and stores `string[]` — the same convention as the run drawer's
 * extra-arguments field, so one engine's argv and the shared argv never
 * disagree.
 */
export interface EngineFieldSpec {
  /** Dotted path into the profile (`vision.exe`), used as the form key. */
  key: string;
  /** i18n key of the label. */
  label: string;
  /** i18n key of the hint line. */
  hint?: string;
  kind: 'text' | 'number' | 'select' | 'boolean' | 'list';
  /** Choices (kind `select`). */
  options?: EngineFieldOption[];
  /** A select that also accepts a typed value (a path override): the console
   *  appends a "custom…" entry that swaps the dropdown for the text input, so
   *  the common case is a pick and the rare override stays possible. */
  customizable?: boolean;
  placeholder?: string;
  /** A path typed in mono — engines take filesystem paths here. */
  mono?: boolean;
  /** The value is a filesystem location the console can offer a picker for
   *  (the server-side FilePickerModal); the stored shape stays a text path. */
  picker?: 'directory' | 'file';
  /** The resolved value FOLLOWS another setting (Strata: python ← the
   *  runtime directory's interpreter). The console shows it as a ghost
   *  placeholder and never pins it unedited — pinning a derived value only
   *  makes it stale when the field it follows moves. */
  derived?: boolean;
  /** Blocks saving while empty. */
  required?: boolean;
  /** Number bounds (kind `number`). */
  min?: number;
  max?: number;
  step?: number;
}

/** A titled block of inputs in the run page's launch-parameter drawer. */
export interface EngineProfileGroup {
  id: string;
  /** i18n key of the section title. */
  label: string;
  fields: EngineFieldSpec[];
}

/**
 * What a profile summary may read about the run it belongs to. An engine that
 * DERIVES its launch inputs (Strata writes the config from the gateway's own
 * runtime directory) needs the model path to answer at all —
 * an empty profile is a valid answer there, so `profile` alone is not enough
 * (ADR-0039 §8).
 */
export interface EngineProfileWhere {
  /** Registry path of the weights (shard 1 for a split file). */
  modelPath: string;
  /** The installed engine binary, when the launch already picked one. */
  binary?: string;
  /** Parsed GGUF header + total weights size — the inputs an engine-owned
   *  estimate (speed, eager load) is computed from. Absent only where the
   *  caller genuinely has neither. */
  meta?: GgufMeta | null;
  sizeBytes?: number;
}

/**
 * The operator-supplied half of a run: a schema the console renders, a
 * validator the routes call, a path list the runner preflights, and a summary
 * the plan panel shows. Every part is engine-owned.
 *
 * `groups` may be EMPTY. That is not a broken form: it says the engine needs
 * nothing from the operator (its launch inputs are derived), and the console
 * must render no profile block at all rather than an empty one.
 */
export interface EngineProfileSpec {
  /** i18n key of the drawer's intro paragraph. */
  intro: string;
  groups: EngineProfileGroup[];
  /** Validate + normalise one raw blob. Unknown keys are dropped, not folded. */
  normalize(raw: unknown): { ok: true; profile: unknown } | { ok: false; code: string; error: string };
  /** Every path the profile names; the runner preflights existence for all of
   *  them at once (one failed launch per typo is not a UX). */
  paths(profile: unknown, modelPath: string): string[];
  /** The declared summary for a launch (engine-owned placement only). */
  describe(profile: unknown, ctx: number, kvCacheQ8: boolean, where?: EngineProfileWhere): EngineDeclaration;
  /** The `model` name the server answers as, when the profile owns it. */
  servedName?(profile: unknown, where?: EngineProfileWhere): string | undefined;
}

/**
 * Placement authority. `gateway` = plan.ts computes the layer split and the
 * engine merely receives it; `engine` = the engine's own cache policy decides,
 * so the console prints a DECLARED summary instead of previewing a decision it
 * does not make (ADR-0038 §5).
 */
export type EnginePlacementMode = 'gateway' | 'engine';

/** Which of the shared run controls this engine's binary actually takes. */
export interface EngineRunControls {
  ngl: boolean;
  threads: boolean;
  flashAttn: boolean;
  kv: boolean;
  reasoning: boolean;
  /** Speculative-decoding draft control (auto/off) — the engine's profile owns
   *  how "off" is expressed; the console never names the mechanism. */
  spec: boolean;
  /** Vision-leg control (auto/off) — same ownership rule as `spec`. */
  vision: boolean;
}

/**
 * Engine-level setup: facts of the INSTALLATION (one per machine), declared
 * like the profile but stored per ENGINE, not per model (ADR-0039 §10). Strata
 * declares workspace / dataRoot / python — optional pins over the directories
 * the gateway owns under its home. An empty value uses those directories.
 * Stored under `engineSetup[engineId]` in local-settings.json.
 */
export interface EngineSetupSpec {
  /** i18n key of the section intro line. */
  intro: string;
  fields: EngineFieldSpec[];
  /** Validate + normalise one raw blob into string values; unknown keys dropped. */
  normalize(raw: unknown): { ok: true; setup: Record<string, string> } | { ok: false; error: string };
  /**
   * The paths the console shows when nothing is pinned (ADR-0039 §13). Stored
   * settings are NOT consulted here (the console already shows them, and a
   * stale override must not echo back as the default).
   */
  resolve?(ctx: { binary?: string }): Record<string, string>;
}

/** The whole runtime an engine ships. */
export interface EngineRuntime {
  placement: EnginePlacementMode;
  accepts: EngineRunControls;
  /** Can this runtime load the file? Asked for every registered engine. */
  serves(input: EngineServeInput): EngineServeVerdict;
  /** Context for an engine-owned placement, and for the plan preview. */
  resolveCtx?(input: { requested: number; profile: unknown; meta: GgufMeta | null }): number;
  /** argv legs for one launch: engine first, auxiliary legs after. */
  legs(facts: EngineRunFacts, services: EngineLegServices): Promise<EngineLeg[] | { error: string }>;
  /** Build the launch input this engine derives (Strata: the pack), as legs
   *  for the build supervisor. Absent = the engine has nothing to build, and
   *  its verdicts never carry `buildable`. */
  build?(input: EngineBuildInput): Promise<EngineLeg[] | { error: string }>;
  profile?: EngineProfileSpec;
  /** Installation-level settings (ADR-0039 §10); absent = nothing to set up. */
  setup?: EngineSetupSpec;
}
