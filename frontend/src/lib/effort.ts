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

/** Dropdown options: UI "unset" sentinel first, then the 6 ladder
 * values. The save payload uses `EFFORT_UNSET` to mean "do not write
 * the wire field at all" and any `ReasoningEffort` value to mean
 * "write this exact value". */
export const EFFORT_OPTIONS = [EFFORT_UNSET, ...EFFORT_LADDER] as const;

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
 * `[{value, label}, ...]` with one entry for "unset" plus one per
 * `ReasoningEffort`. The label format is:
 *   - `EFFORT_UNSET`  → the i18n `pmUnset` label (e.g. "不设置")
 *   - `<effort>`      → `<effort> <localized>` so users see both the
 *                       protocol token and a short hint in their language
 */
export const effortOptionList = (t: (k: string) => string) =>
  EFFORT_OPTIONS.map((o) => ({
    value: o,
    label: o === EFFORT_UNSET ? t('op.pmUnset') : `${o} ${t(`op.${EFFORT_I18N_KEY[o]}`)}`,
  }));

