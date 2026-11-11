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
 *
 * `flat` owns the other two sub-options. It is where a long list lives (39 rows
 * for the full catalogue), so it is the only style that needs a way to trade
 * breathing room for fitting on one screen, and the only one where folding a
 * group away can be worth a click. Sub-options are shown only for the style
 * they belong to — the settings card reveals them on switch rather than greying
 * out controls that do nothing.
 *
 * The fold is deliberately session-only and starts fully open: a persisted
 * per-group fold state is how the pre-rail sidebar drifted to "everything open"
 * after a few pages, and re-introducing that memory would re-introduce the bug.
 */

export type NavStyleId = 'rail' | 'flat';

export const NAV_STYLE_STORAGE_KEY = 'ocr_nav_style';
export const NAV_RAIL_LABELS_STORAGE_KEY = 'ocr_nav_rail_labels';
export const NAV_ROW_DENSITY_STORAGE_KEY = 'ocr_nav_row_density';
export const NAV_COLLAPSIBLE_STORAGE_KEY = 'ocr_nav_collapsible';
/** Same-document notification so the shell re-reads the preference without a
 *  reload; `storage` covers a second window. */
export const NAV_STYLE_CHANGED_EVENT = 'ocr:navstyle';

export const DEFAULT_NAV_STYLE: NavStyleId = 'rail';
export const NAV_STYLES: readonly NavStyleId[] = ['rail', 'flat'];

export interface NavPreference {
  style: NavStyleId;
  /** `rail` only: draw a short caption under each group glyph. */
  railLabels: boolean;
  /** `flat` only: row height, i.e. how many groups fit without scrolling. */
  density: NavDensity;
  /** `flat` only: group headings fold their group away. Session state — the
   *  preference says whether the headings are controls, not which are folded. */
  collapsible: boolean;
}

export type NavDensity = 'comfortable' | 'compact';

export const DEFAULT_NAV_PREFERENCE: NavPreference = {
  style: DEFAULT_NAV_STYLE,
  railLabels: true,
  density: 'comfortable',
  collapsible: false,
};

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
      density: localStorage.getItem(NAV_ROW_DENSITY_STORAGE_KEY) === 'compact' ? 'compact' : 'comfortable',
      collapsible: localStorage.getItem(NAV_COLLAPSIBLE_STORAGE_KEY) === '1',
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
    localStorage.setItem(NAV_ROW_DENSITY_STORAGE_KEY, next.density);
    localStorage.setItem(NAV_COLLAPSIBLE_STORAGE_KEY, next.collapsible ? '1' : '0');
  } catch {
    // Best-effort; the event below still applies it to this window.
  }
  window.dispatchEvent(new Event(NAV_STYLE_CHANGED_EVENT));
  return next;
}
