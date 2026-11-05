/** Theme preference and resolved color scheme shared by the shell and editor. */
export type ThemeId = 'light' | 'dark';
export type ThemePreference = ThemeId | 'system';

export const THEME_STORAGE_KEY = 'ocr_theme';
export const DEFAULT_THEME: ThemeId = 'light';
export const LIGHT_THEME_IDS: readonly ThemeId[] = ['light'];

const LEGACY_THEME_IDS: Record<string, ThemeId> = {
  light: 'light', azure: 'light', amber: 'light',
  onyx: 'dark', indigo: 'dark', emerald: 'dark', violet: 'dark', rose: 'dark',
  obsidian: 'dark', cyber: 'dark', sunset: 'dark',
};

export function resolveThemePreference(raw: string | null): ThemePreference {
  if (!raw || raw === 'system') return 'system';
  if (raw === 'light' || raw === 'dark') return raw;
  return LEGACY_THEME_IDS[raw] ?? 'system';
}

export function resolveStoredTheme(raw: string | null): ThemeId {
  const preference = resolveThemePreference(raw);
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function isLightTheme(id: string): boolean {
  return (LIGHT_THEME_IDS as readonly string[]).includes(id);
}
