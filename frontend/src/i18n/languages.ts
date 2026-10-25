import type { Lang } from './types';

/** All supported UI languages, in switcher-menu order. Labels are ENDONYMS
 *  (native names) — locale-independent by design: the native name for Chinese
 *  reads the same no matter which UI language is active, so the switcher never
 *  goes through the translation tables. Single source of truth: I18nContext
 *  (persistence + browser-language detection) and the Layout switcher both
 *  derive from here. */
export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'pt', label: 'Português' },
];

/** Flattened code list — the persisted-language validator in I18nContext. */
export const LANG_CODES: readonly Lang[] = LANGUAGES.map((l) => l.value);

/** navigator.language → UI Lang. Prefix match (zh-TW → zh, pt-PT → pt);
 *  anything unrecognized falls back to English. */
export const detectLang = (): Lang => {
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  if (nav.startsWith('zh')) return 'zh';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('de')) return 'de';
  if (nav.startsWith('fr')) return 'fr';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('pt')) return 'pt';
  return 'en';
};
