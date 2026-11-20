import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/ToastProvider';
import { useI18n } from '../i18n/I18nContext';

export interface TranslationEntry {
  src: string;
  text: string;
  model: string;
}

export interface TranslationBatchProgress {
  done: number;
  total: number;
  failed: number;
}

export interface TranslationItem {
  key: string;
  text: string | null | undefined;
}

/**
 * Shared client-side translation state for console pages (cache seeding, single-item translation,
 * chunked batch translation, and MT/ORIG toggle).
 */
export function useTranslationCache() {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [entries, setEntries] = useState<Record<string, TranslationEntry>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [batch, setBatch] = useState<TranslationBatchProgress | null>(null);

  // Drop derived translations when the UI language changes so the next seed loads the new target language.
  useEffect(() => {
    setEntries({});
    setShowOriginal({});
  }, [lang]);

  /** Seed already-cached translations from the server (read-only, zero model spend). */
  const seed = useCallback(
    async (items: TranslationItem[], isCancelled?: () => boolean): Promise<void> => {
      const valid = items.filter((item): item is { key: string; text: string } => Boolean(item.text && item.text.trim()));
      const uniqueTexts = [...new Set(valid.map((item) => item.text.trim()))];
      if (uniqueTexts.length === 0) return;

      const merged: Record<string, { text: string; model: string }> = {};
      // Backend caps lookup at 500 texts per call.
      for (let i = 0; i < uniqueTexts.length; i += 500) {
        if (isCancelled?.()) return;
        const slice = uniqueTexts.slice(i, i + 500);
        const { translations } = await api.translationsLookup({ lang, texts: slice });
        Object.assign(merged, translations);
      }
      if (isCancelled?.()) return;

      setEntries((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of valid) {
          const hit = merged[item.text.trim()];
          const stale = next[item.key]?.src !== item.text;
          if (hit && stale) {
            next[item.key] = { src: item.text, text: hit.text, model: hit.model };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [lang]
  );

  /** Translate a single item on demand. */
  const translateOne = useCallback(
    async (key: string, sourceText: string | null | undefined): Promise<void> => {
      if (!sourceText || !sourceText.trim()) return;
      setEntries((prev) => ({ ...prev, [key]: { src: sourceText, text: '…', model: '' } }));
      try {
        const res = await api.translate({ text: sourceText, lang });
        setEntries((prev) => ({ ...prev, [key]: { src: sourceText, text: res.text, model: res.model } }));
      } catch (e) {
        setEntries((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        toast.error(`${t('harness.translateFailed')}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [lang, t, toast]
  );

  /** Translate all pending items in chunks of 8 with deduplication and progress reporting. */
  const translateAll = useCallback(
    async (
      items: TranslationItem[],
      confirmFn?: (pendingCount: number) => Promise<boolean>
    ): Promise<void> => {
      const pending = items.filter(
        (item): item is { key: string; text: string } =>
          Boolean(item.text && item.text.trim()) && entries[item.key]?.src !== item.text
      );
      if (pending.length === 0) return;

      if (confirmFn) {
        const ok = await confirmFn(pending.length);
        if (!ok) return;
      }

      const keysByText = new Map<string, string[]>();
      const sourceByTrimmed = new Map<string, string>();
      for (const item of pending) {
        const trimmed = item.text.trim();
        sourceByTrimmed.set(trimmed, item.text);
        const list = keysByText.get(trimmed) ?? [];
        list.push(item.key);
        keysByText.set(trimmed, list);
      }

      const texts = [...keysByText.keys()];
      const CHUNK = 8;
      let done = 0;
      let failed = 0;
      let aborted = false;
      setBatch({ done: 0, total: texts.length, failed: 0 });

      try {
        for (let i = 0; i < texts.length; i += CHUNK) {
          const chunk = texts.slice(i, i + CHUNK);
          try {
            const res = await api.translateBatch({ lang, texts: chunk });
            setEntries((prev) => {
              const next = { ...prev };
              for (const [text, translated] of Object.entries(res.results)) {
                const src = sourceByTrimmed.get(text) ?? text;
                for (const key of keysByText.get(text) ?? []) {
                  next[key] = { src, text: translated.text, model: translated.model };
                }
              }
              return next;
            });
            failed += res.errors.length;
          } catch (e) {
            failed += chunk.length;
            const err = e as Error & { code?: string };
            toast.error(`${t('harness.translateFailed')}: ${err.message}`);
            if (err.code === 'no_api_key') {
              aborted = true;
              break;
            }
          }
          done += chunk.length;
          setBatch({ done: Math.min(done, texts.length), total: texts.length, failed });
        }
      } finally {
        setBatch(null);
        if (!aborted) {
          if (failed > 0) toast.error(`${t('harness.translateAllPartial')}: ${failed}/${texts.length}`);
          else toast.success(t('harness.translateAllDone'));
        }
      }
    },
    [entries, lang, t, toast]
  );

  const toggleOriginal = useCallback((key: string) => {
    setShowOriginal((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  /** Resolve display text and translation state for a given item key and current source text. */
  const getDisplay = useCallback(
    (key: string, sourceText: string | null | undefined) => {
      const src = sourceText ?? '';
      const entry = entries[key];
      const translated = entry && entry.src === src ? entry : undefined;
      const showingTranslation = Boolean(translated) && !showOriginal[key];
      return {
        text: showingTranslation && translated ? translated.text : src,
        translated,
        showingTranslation,
      };
    },
    [entries, showOriginal]
  );

  return {
    lang,
    entries,
    setEntries,
    showOriginal,
    batch,
    seed,
    translateOne,
    translateAll,
    toggleOriginal,
    getDisplay,
  };
}
