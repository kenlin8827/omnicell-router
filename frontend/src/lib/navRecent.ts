/**
 * Recently visited console routes, newest first. Feeds the command palette's
 * empty-query ordering: that list is the only navigation surface that is not
 * contextual (the rail panel already narrows to one group, and `flat` is
 * alphabetical by group), so recency has to live there.
 *
 * Deliberately chrome-free — no extra button and no extra row, just order — so
 * this adds a capability without adding a layout branch.
 *
 * Only registry paths are remembered (the keys of `ROUTE_META_KEYS`). Detail
 * routes such as `/harness/plugins/<client>` carry the selected client in the
 * path and have no palette entry, so admitting them would fill the list with
 * routes that can never rank anything.
 */

export const NAV_RECENT_STORAGE_KEY = 'ocr_nav_recent';
export const NAV_RECENT_LIMIT = 5;

export function readRecentRoutes(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NAV_RECENT_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((route): route is string => typeof route === 'string')
      .slice(0, NAV_RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** Pure MRU step: move `pathname` to the front, drop the duplicate, cap the list. */
export function nextRecentRoutes(previous: readonly string[], pathname: string): string[] {
  return [pathname, ...previous.filter((route) => route !== pathname)].slice(0, NAV_RECENT_LIMIT);
}

export function writeRecentRoutes(routes: readonly string[]): void {
  try {
    localStorage.setItem(NAV_RECENT_STORAGE_KEY, JSON.stringify(routes));
  } catch {
    // Best-effort: a private-mode console still ranks within this session.
  }
}
