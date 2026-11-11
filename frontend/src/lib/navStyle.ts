/**
 * Console navigation style — a pure client preference, deliberately NOT part of
 * `config.yaml`: it changes nothing the gateway does, and two consoles may show
 * the same gateway differently. Same tier as the theme preference, so it lives
 * in localStorage and applies live through a same-document event.
 *
 * Styles:
 * - `rail` rail of group glyphs + the selected group's item list beside it
 *        (default; both levels stay visible)
 * - `flat` one column, every group listed under a static section label
 *
 * Why just these two: a tree/accordion is the same two-level data with a fold
 * in front of it, so it buys nothing beyond an extra click and a state to
 * remember — the two columns already keep every group one click away and every
 * item of the current group visible without scrolling.
 *
 * The rail additionally owns one sub-option: whether each glyph carries a short
 * caption. Captions are ON by default — eight glyphs alone are ambiguous
 * (`Layers`/`Zap` each appear twice in the item lists, and `Plug` is used by two
 * different groups), and an operator who has not yet learned the shapes should
 * not have to hover to find out which group a symbol opens. Turning them off
 * buys 8px back for the item list.
 */

export type NavStyleId = 'rail' | 'flat';

export const NAV_STYLE_STORAGE_KEY = 'ocr_nav_style';
export const NAV_RAIL_LABELS_STORAGE_KEY = 'ocr_nav_rail_labels';
/** Same-document notification so the shell re-reads the preference without a
 *  reload; `storage` covers a second window. */
export const NAV_STYLE_CHANGED_EVENT = 'ocr:navstyle';

export const DEFAULT_NAV_STYLE: NavStyleId = 'rail';
export const NAV_STYLES: readonly NavStyleId[] = ['rail', 'flat'];

export interface NavPreference {
  style: NavStyleId;
  /** `rail` only: draw a short caption under each group glyph. */
  railLabels: boolean;
}

export const DEFAULT_NAV_PREFERENCE: NavPreference = { style: DEFAULT_NAV_STYLE, railLabels: true };

export function resolveNavStyle(raw: string | null): NavStyleId {
  return NAV_STYLES.includes(raw as NavStyleId) ? (raw as NavStyleId) : DEFAULT_NAV_STYLE;
}

export function readNavPreference(): NavPreference {
  try {
    return {
      style: resolveNavStyle(localStorage.getItem(NAV_STYLE_STORAGE_KEY)),
      // Only an explicit "0" turns captions off: a first-run console has no key
      // yet, and the default is ON.
      railLabels: localStorage.getItem(NAV_RAIL_LABELS_STORAGE_KEY) !== '0',
    };
  } catch {
    return DEFAULT_NAV_PREFERENCE;
  }
}

/** Persist a partial patch and notify the open shell. Storage failures (private
 *  mode) must not block the live application of the change. */
export function writeNavPreference(patch: Partial<NavPreference>): NavPreference {
  const next = { ...readNavPreference(), ...patch };
  try {
    localStorage.setItem(NAV_STYLE_STORAGE_KEY, next.style);
    localStorage.setItem(NAV_RAIL_LABELS_STORAGE_KEY, next.railLabels ? '1' : '0');
  } catch {
    // Best-effort; the event below still applies it to this window.
  }
  window.dispatchEvent(new Event(NAV_STYLE_CHANGED_EVENT));
  return next;
}
