/**
 * The ONE mapping from a vendor model row to the models.dev-shaped def the pull
 * engine writes. Every model-service plugin feeds {@link VendorCapabilities} in
 * here; none of them builds an OCR def by hand (ADR-0035).
 *
 * Why it exists: `qoder-models` and `workbuddy-models` each grew their own
 * `xxxCatalogToDef`, and the two drifted on exactly the field that decides
 * money and behaviour — `reasoningOptions`. qoder wrote a bare
 * `[{type:'toggle'}]` for every reasoning model ("the catalog publishes no tier
 * table"), `effortLadderFor` resolves `toggle` to `[]`, and `[]` makes
 * `downgradeReasoning` collapse every requested level to `'none'` — so a
 * client asking for `high` on GLM-5.4 silently got the cheapest level. The
 * vendor had in fact declared `thinking_config.enabled.efforts` all along; the
 * plugin just never read it. One mapper means one place to be wrong, one place
 * to test, and no plugin able to re-derive the rule "wrong" on its own.
 *
 * Iron rules (each of them a silent, expensive bug in production):
 *
 *  1. An effort TABLE is the only thing that may become
 *     `{type:'effort',values}`. `{type:'toggle'}` is allowed ONLY when the
 *     vendor itself says "on/off, no levels" — a level-less toggle resolves to
 *     `[]` and erases the client's requested level.
 *  2. Nothing is invented. `undefined` means "the vendor did not say", and the
 *     field is omitted. Never write `tool_call: true` / `temperature: true`
 *     because "probably fine": a wrong `true` makes the gateway send a
 *     parameter the upstream rejects.
 *  3. `attachment` (models.dev boolean) and `modalities.input` (v2 spelling)
 *     are ONE fact and are always emitted together, driven by the same
 *     {@link ModalityInput} list — a vision model must never read as text-only
 *     in the console while the wire sends an image.
 *  4. `limit.input` is the prompt-side cap (models.dev `limit.input`), distinct
 *     from `limit.context` (the window). Vendors that publish only a window
 *     leave `input` unset rather than having it inferred.
 *  5. A vendor's "disabled" flag becomes `disabled: true`, so the model leaves
 *     the routing pool instead of being offered and failing per request.
 */

import { EFFORT_LADDER, type ReasoningEffort } from '../types/router.js';

/** models.dev `modalities.input` vocabulary — the only values the capability
 *  plane understands. `image|audio|video|pdf` are independent facts, so a
 *  vendor that documents PDF input says so here instead of being folded into
 *  `attachment` (which is vision only). */
export type ModalityInput = 'text' | 'image' | 'audio' | 'video' | 'pdf';

/** models.dev `modalities.output` vocabulary. */
export type ModalityOutput = 'text' | 'image' | 'audio';

/**
 * One vendor row, normalized: what the vendor DECLARED, nothing else.
 *
 * Every capability is tri-state where the vendor's own schema is tri-state:
 * `true` = declared supported, `false` = declared unsupported, `undefined` =
 * the vendor said nothing (and the field is omitted from the def).
 */
export interface VendorCapabilities {
  /** Wire model id (qoder `key`, workbuddy `id`). */
  id: string;
  /** Human label. Omitted when the vendor has none — the console then renders
   *  the id, which is what the old `name ?? id` fallbacks did anyway. */
  name?: string;
  /**
   * Reasoning, as the vendor declares it. Omitted entirely for a model the
   * vendor does not mark as reasoning.
   */
  reasoning?: VendorReasoning;
  /** Input modalities the vendor declared. `undefined` = no declaration, and
   *  the def carries no `attachment`/`modalities` at all.
   *
   *  A vendor that only knows "can it see images" passes
   *  `['text','image']`; one that documents audio/pdf passes the full list. */
  inputModalities?: ModalityInput[];
  /** Output modalities. Omitted = text-only is NOT assumed to be declared;
   *  callers that know it is text pass `['text']`. */
  outputModalities?: ModalityOutput[];
  /** Tool calling, when the vendor declares it. */
  toolCall?: boolean;
  /** Temperature support, when the vendor declares it. Vendors rarely do —
   *  leave undefined rather than guessing. */
  temperature?: boolean;
  /** Structured/JSON output support (models.dev `structured_output`). */
  structuredOutput?: boolean;
  /** Token budgets. `context` = window, `input` = prompt cap (often absent),
   *  `output` = max completion. */
  limit?: { context?: number; input?: number; output?: number };
  /** models.dev `cost`, USD per 1M tokens. A vendor that bills in CREDIT
   *  multipliers (qoder `price_factor`) must DERIVE this — factor × a measured
   *  base rate × the official credit→USD ratio (see
   *  `plugins/qoder-models/pricing.ts`) — and never write the raw factor here:
   *  a bare multiplier is not a dollar price and would corrupt every price
   *  band. Leave it absent when no dollar price can honestly be derived. */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** Vendor marks the row disabled/retired. */
  disabled?: boolean;
  /** A pinned thinking level for a model with ONE gear (see
   *  {@link VendorReasoning.fixedEffort}). */
  interleavedField?: string;
  /** Anything the vendor publishes that OCR has no vocabulary for yet, kept
   *  verbatim under `vendor` so a later field can be promoted without
   *  re-pulling. Never read by routing. */
  vendor?: Record<string, unknown>;
}

/**
 * The vendor's reasoning declaration, in the vocabulary vendors actually use.
 *
 * Three real shapes, each with a different honest answer:
 *  - a TABLE (`efforts`) → that exact table, plus `defaultEffort`;
 *  - a FIXED GEAR (one `effort`, no table) → a one-value table, so the router
 *    clamps to it and clients still see a thinking model;
 *  - ON/OFF ONLY (`disableable: true` and no efforts) → the one case a bare
 *    `{type:'toggle'}` is the truth;
 *  - THINKS ALWAYS (efforts but `disableable: false`) → the table with NO
 *    `none` member, which is exactly what makes `downgradeReasoning` refuse to
 *    emit `'none'` and what makes the wire stop sending "turn thinking off".
 */
export interface VendorReasoning {
  /** The vendor's level table. Values are normalized by {@link EFFORT_VALUES}. */
  efforts?: string[];
  /** The vendor's default level (`is_default` on an effort entry, or a pinned
   *  `reasoning.effort`). */
  defaultEffort?: string;
  /** `true` = the vendor lets thinking be turned OFF; `false` = it always
   *  thinks (GLM-5.4, MiniMax-M3.1); `undefined` = not stated. */
  disableable?: boolean;
  /** A single pinned gear for a model with no table. */
  fixedEffort?: string;
}

/** The wire vocabulary, in increasing order — the gateway's OWN ladder, never a
 *  local copy. A vendor level it cannot name is dropped rather than leaked into
 *  `supportedReasoningEfforts` as an unroutable string. */
const EFFORT_VALUES: readonly ReasoningEffort[] = EFFORT_LADDER;

/** Normalize a vendor level list: keep the known levels, dedupe, preserve the
 *  vendor's order (toOcrDef restores ladder order before publishing). */
export function normalizeEfforts(values: readonly string[] | undefined): ReasoningEffort[] {
  if (!Array.isArray(values)) return [];
  const out: ReasoningEffort[] = [];
  for (const raw of values) {
    const level = String(raw).trim().toLowerCase() as ReasoningEffort;
    if (EFFORT_VALUES.includes(level) && !out.includes(level)) out.push(level);
  }
  return out;
}

/**
 * Build the OCR models.dev-shaped def from normalized vendor capabilities.
 *
 * The output feeds `host.pull.catalogToDef` (via `upsertModel`) and the defs
 * file, so every field here is a real OCR vocabulary member — see
 * `backend/src/opencode/catalog/types.ts` `CatalogModel`.
 */
export function toOcrDef(caps: VendorCapabilities): Record<string, unknown> {
  const def: Record<string, unknown> = { id: caps.id };
  if (caps.name !== undefined) def.name = caps.name;

  const reasoning = caps.reasoning;
  // The on/off fact travels with the def: the boot ladder expands a bare
  // reasoning boolean into the full EFFORT_LADDER, which INCLUDES `none`.
  // Without this field an always-think model with no table would be told it
  // serves thinking-off, and the router would reproduce the 1210 refusal the
  // table stripping exists to prevent (ADR-0035 rule 2 — the withholding must
  // hold at the ROUTING plane, not only on the published table).
  if (reasoning?.disableable === false) def.reasoningDisableable = false;

  if (reasoning) {
    // Iron rule 1: a table is a table; a bare toggle only when the vendor said
    // on/off and nothing more. `[]` (= toggle) is what erased the level.
    const efforts = normalizeEfforts(reasoning.efforts);
    const fixed = normalizeEfforts(reasoning.fixedEffort ? [reasoning.fixedEffort] : []);

    if (efforts.length > 0) {
      // Vendors publish efforts as an unordered OBJECT (`{high, low, max}`), so
      // the level order must be restored from the gateway's own ladder —
      // otherwise the console renders `xhigh` before `low` and a `defaultEffort`
      // reads as if it sat at the wrong end of the list.
      efforts.sort((a, b) => EFFORT_VALUES.indexOf(a) - EFFORT_VALUES.indexOf(b));
      // A model that always thinks must NOT advertise `none`: the router picks
      // the ladder's max ≤ request, and with no `none` member it can never
      // emit "thinking off", which is the 1210 refusal's whole cause.
      const table = reasoning.disableable === false ? efforts.filter((e) => e !== 'none') : efforts;
      def.reasoning = true;
      // An always-think model NEVER advertises `none`, not even as a fallback:
      // a contradictory vendor table (`['none']` + disableable:false) must not
      // resurrect the level its own on/off fact forbids — the router would
      // then send thinking-off and eat the 1210 refusal this rule exists to
      // prevent. When stripping empties the table, the boolean alone is the
      // honest minimum (no invented ladder, no forbidden `none`).
      if (table.length > 0) {
        def.reasoningOptions = [{ type: 'effort', values: table }];
        const defaultEffort = normalizeEfforts(reasoning.defaultEffort ? [reasoning.defaultEffort] : [])[0];
        if (defaultEffort && table.includes(defaultEffort)) def.defaultEffort = defaultEffort;
      }
    } else if (fixed.length > 0) {
      // One gear, no table: a one-value table keeps clients showing a thinking
      // model while the router clamps to the only level the vendor honours.
      def.reasoning = true;
      def.reasoningOptions = [{ type: 'effort', values: fixed }];
      def.defaultEffort = fixed[0];
    } else if (reasoning.disableable === true) {
      // The ONE honest toggle: on/off with no levels declared.
      def.reasoning = true;
      def.reasoningOptions = [{ type: 'toggle' }];
    } else {
      // The vendor says it reasons but declares neither a table nor on/off.
      // Claiming a ladder would be invention; claiming a toggle would be a
      // lie that erases every level. The boolean alone is the honest minimum —
      // and `effortLadderFor` expands it, which the caller opts into knowingly.
      def.reasoning = true;
    }
  }

  // Iron rule 3: `attachment` and `modalities.input` are one fact.
  //
  // `modalities` is a MULTIMODALITY declaration, not a restatement that text
  // works — every model does text. Emitting `{input:['text']}` for a text-only
  // row would claim a capability ledger the vendor never published (and the
  // console renders it as a badge). So the block appears only for a row with a
  // non-text input modality or a non-text output modality; a text-only row
  // carries NEITHER `attachment` nor `modalities`.
  const input = caps.inputModalities?.length ? [...new Set(caps.inputModalities)] : undefined;
  const output = caps.outputModalities?.length ? [...new Set(caps.outputModalities)] : undefined;
  const multiInput = input?.filter((m) => m !== 'text');
  const multiOutput = output?.filter((m) => m !== 'text');
  if (multiInput?.length || multiOutput?.length) {
    def.modalities = { ...(input ? { input } : {}), ...(output ? { output } : {}) };
  }
  if (multiInput?.includes('image')) def.attachment = true;

  // Iron rule 2: only what the vendor declared.
  if (caps.toolCall !== undefined) def.tool_call = caps.toolCall;
  if (caps.temperature !== undefined) def.temperature = caps.temperature;
  if (caps.structuredOutput !== undefined) def.structured_output = caps.structuredOutput;
  if (caps.interleavedField) def.interleaved = { field: caps.interleavedField };

  // Iron rule 4: `input` is the prompt cap, never invented from `context`.
  if (caps.limit) {
    const limit: Record<string, number> = {};
    if (typeof caps.limit.context === 'number' && caps.limit.context > 0) limit.context = caps.limit.context;
    if (typeof caps.limit.input === 'number' && caps.limit.input > 0) limit.input = caps.limit.input;
    if (typeof caps.limit.output === 'number' && caps.limit.output > 0) limit.output = caps.limit.output;
    if (Object.keys(limit).length > 0) def.limit = limit;
  }

  if (caps.cost) {
    const cost: Record<string, number> = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      const v = caps.cost[k];
      if (typeof v === 'number' && v >= 0) cost[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = v;
    }
    if (Object.keys(cost).length > 0) def.cost = cost;
  }

  if (caps.disabled === true) def.disabled = true;
  if (caps.vendor && Object.keys(caps.vendor).length > 0) def.vendor = caps.vendor;
  return def;
}