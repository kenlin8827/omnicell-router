/**
 * Frontend mirror of the OpenCode 6-level thinking-effort ladder
 * (backend/src/types/router.ts `EFFORT_LADDER`). The wire value is
 * always one of these 6 strings; `none` is a real effort value meaning
 * "do not think", NOT a default or an omitted-field placeholder.
 *
 * Components import this constant rather than restating the array
 * inline so the dropdown, labels, autofill detector, and any future
 * formatter all share a single source of truth.
 */
export const EFFORT_LADDER = [
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
] as const;
export type ReasoningEffort = (typeof EFFORT_LADDER)[number];

/** UI-only "unset" sentinel for form fields. The save payload treats
 * this as "do not write the wire field at all" (i.e. `undefined` over
 * the wire), so it is NOT a member of `EFFORT_LADDER`. */
export const EFFORT_UNSET = '' as const;
export type EffortValue = ReasoningEffort | typeof EFFORT_UNSET;

/** i18n key for each reasoning-effort level. The label rendering is
 * `<wire> <localized>` so the protocol token the client will send
 * stays in view. */
export const EFFORT_I18N_KEY: Record<ReasoningEffort, string> = {
  none: 'pmEffortNone',
  low: 'pmEffortLow',
  medium: 'pmEffortMedium',
  high: 'pmEffortHigh',
  xhigh: 'pmEffortXhigh',
  max: 'pmEffortMax',
};

/** Build the dropdown option list for a Combobox. Returns
 * `[{value, label}, ...]` with one entry for "unset" plus one per level in
 * `levels` (default: the full ladder). Pass a model's declared subset to keep
 * a picker from offering a level that model does not support. The label
 * format is:
 *   - `EFFORT_UNSET`  → the i18n `pmUnset` label (e.g. "unset")
 *   - `<effort>`      → `<effort><sep><localized>` so users see both the
 *                       protocol token and a short hint in their language
 */
export const effortOptionList = (t: (k: string) => string, levels: readonly string[] = EFFORT_LADDER, sep = ' ') =>
  [EFFORT_UNSET, ...levels].map((o) => ({
    value: o,
    label: o === EFFORT_UNSET ? t('op.pmUnset') : `${o}${sep}${t(`op.${EFFORT_I18N_KEY[o as ReasoningEffort]}`)}`,
  }));

/**
 * Frontend mirror of backend boot-direct `effortLadderFor`: resolve a
 * catalog model record's effective thinking-level list.
 *  - `effort`-type options: values ∩ EFFORT_LADDER (the model's real list);
 *  - `budget_tokens`: full ladder (continuous budget maps any level);
 *  - `toggle` / unresolvable: [] (no explicit level control);
 *  - no options: legacy boolean → full-ladder fallback.
 */
export function effectiveEffortLadder(m: {
  reasoning?: boolean;
  reasoningOptions?: { type: string; values?: string[] }[];
}): string[] {
  const opts = m.reasoningOptions;
  if (!Array.isArray(opts) || opts.length === 0) {
    return m.reasoning === true ? [...EFFORT_LADDER] : [];
  }
  const effortOpt = opts.find((o) => o?.type === 'effort');
  if (effortOpt && Array.isArray(effortOpt.values) && effortOpt.values.length > 0) {
    const allowed = effortOpt.values.filter((v) => (EFFORT_LADDER as readonly string[]).includes(v));
    if (allowed.length > 0) return allowed;
  }
  if (opts.some((o) => o?.type === 'budget_tokens')) return [...EFFORT_LADDER];
  return [];
}

