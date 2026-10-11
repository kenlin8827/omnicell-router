/**
 * Shared modality vocabulary for model editors (ModelEditDialog definitions
 * + OcrEditModal aggregate overrides). Single source of truth so both
 * editors render the same checkbox set and the same localized labels.
 */
export const MODALITY_OPTIONS = ['text', 'image', 'audio', 'video', 'pdf'] as const;
export type Modality = (typeof MODALITY_OPTIONS)[number];

/** Localized modality label with protocol-token fallback (i18n key
 * `models.mod<Text|Image|Audio|Video|Pdf>`). */
export const modalityLabel = (t: (k: string) => string, m: string): string => {
  const key = `models.mod${m.charAt(0).toUpperCase()}${m.slice(1)}`;
  try {
    const v = t(key);
    return v && v !== key ? v : m;
  } catch {
    return m;
  }
};
