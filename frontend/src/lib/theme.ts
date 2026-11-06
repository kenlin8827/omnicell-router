/** Theme preference and resolved color scheme shared by the shell and editor. */
export type ThemeId = 'light' | 'dark';
export type ThemePreference = ThemeId | 'system';

export const THEME_STORAGE_KEY = 'ocr_theme';
export const DEFAULT_THEME: ThemeId = 'light';
export const LIGHT_THEME_IDS: readonly ThemeId[] = ['light'];

export function resolveThemePreference(raw: string | null): ThemePreference {
  if (!raw || raw === 'system') return 'system';
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function resolveStoredTheme(raw: string | null): ThemeId {
  const preference = resolveThemePreference(raw);
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function isLightTheme(id: string): boolean {
  return (LIGHT_THEME_IDS as readonly string[]).includes(id);
}
