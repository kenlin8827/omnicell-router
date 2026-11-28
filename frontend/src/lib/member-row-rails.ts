/** Fixed rail widths shared by BOTH member-row editors (combo and tier): the
 *  grip+index gutter and the trailing action cluster. One declaration keeps the
 *  two dialogs' pickers starting and ending on the same x — a local copy in
 *  either page would drift silently on the next tweak. */
export const MEMBER_GUTTER_W = '42px';
export const MEMBER_ACTIONS_W = '92px';

/** Preview chips both member-row quick-add popovers show before collapsing the
 *  tail into one "+N" chip. */
export const MEMBER_QUICK_CHIP_CAP = 8;

/** Rotation-share (weight) field, shared by BOTH member-row editors (combo and
 *  tier). One box size and one CENTRED value: a left-aligned digit in a narrow
 *  box reads as a stray label rather than an editable value, and two different
 *  sizes made the two pages look like two unrelated controls. */
export const MEMBER_WEIGHT_INPUT = {
  width: '52px',
  height: 30,
  minHeight: 30,
  boxSizing: 'border-box' as const,
  padding: '3px 6px',
  fontSize: 'var(--text-xs)',
  textAlign: 'center' as const,
  flexShrink: 0,
} as const;
