import React, { createContext, useContext, useState, type ReactNode } from 'react';
import type { Lang, TranslationDict } from './types';
import { zhCN } from './locales/zh-CN';
import { enUS } from './locales/en-US';

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
  /** Raw dictionary of the active language. For content that is DATA-shaped
   *  (arrays / objects the UI edits, e.g. the playground's decision presets)
   *  where `t()`'s string lookup cannot help. */
  dict: TranslationDict;
}

const DICTIONARIES: Record<Lang, TranslationDict> = {
  zh: zhCN,
  en: enUS,
};

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(() => {
    const saved = localStorage.getItem('ocr_lang');
    if (saved === 'en' || saved === 'zh') return saved;
    return navigator.language.startsWith('zh') ? 'zh' : 'en';
  });

  const setLang = (newLang: Lang) => {
    setLangState(newLang);
    localStorage.setItem('ocr_lang', newLang);
  };

  const t = (path: string, params?: Record<string, string | number>): string => {
    const dict = DICTIONARIES[lang] || DICTIONARIES.zh;
    const parts = path.split('.');

    let current: any = dict;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        // Fallback to English
        let fallback: any = DICTIONARIES.en;
        for (const fbPart of parts) {
          if (fallback && typeof fallback === 'object' && fbPart in fallback) {
            fallback = fallback[fbPart];
          } else {
            return path;
          }
        }
        current = fallback;
        break;
      }
    }

    if (typeof current !== 'string') return path;

    if (params) {
      let str = current;
      for (const [k, v] of Object.entries(params)) {
        // Regex-free interpolation: param keys may originate from disk rows
        // (traces), and a metacharacter key would throw in RegExp.
        str = str.split(`{${k}}`).join(String(v));
      }
      return str;
    }

    return current;
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t, dict: DICTIONARIES[lang] || DICTIONARIES.zh }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = (): I18nContextValue => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
};
