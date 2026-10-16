/**
 * Theme identity shared by the pre-paint bootstrap (main.tsx), the picker
 * (Layout) and anything that branches on the active `data-theme` value.
 * Ids are bare color/material nouns (no brand words, no generic adjectives);
 * localized display names in i18n are the product-facing copy.
 * The persisted key in localStorage is `ocr_theme`.
 */
export type ThemeId = 'onyx' | 'indigo' | 'emerald' | 'violet' | 'rose' | 'azure' | 'amber';

export const THEME_STORAGE_KEY = 'ocr_theme';

export const THEME_IDS: readonly ThemeId[] = [
  'onyx', 'indigo', 'emerald', 'violet', 'rose', 'azure', 'amber',
];

/** Light-class themes (paper surfaces). The CSS light-group token overrides and
 *  the CodeMirror chrome both branch on this set — keep them in sync. */
export const LIGHT_THEME_IDS: readonly ThemeId[] = ['azure', 'amber'];

/** Theme applied when the user has never picked one (fresh install / cleared storage). */
export const DEFAULT_THEME: ThemeId = 'azure';

/** Pre-rename theme ids persisted in existing users' localStorage. */
const LEGACY_THEME_IDS: Record<string, ThemeId> = {
  obsidian: 'onyx',
  cyber: 'emerald',
  sunset: 'rose',
  light: 'azure',
};

/** Migrate a raw stored value to a current ThemeId; unknown/absent → DEFAULT_THEME. */
export function resolveStoredTheme(raw: string | null): ThemeId {
  if (!raw) return DEFAULT_THEME;
  if ((THEME_IDS as readonly string[]).includes(raw)) return raw as ThemeId;
  return LEGACY_THEME_IDS[raw] ?? DEFAULT_THEME;
}

export function isLightTheme(id: string): boolean {
  return (LIGHT_THEME_IDS as readonly string[]).includes(id);
}
