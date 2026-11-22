import { pickLocaleText } from './plugin-config';

/**
 * Resolve a package-declared setup advisory (`manifest.warningLabels`) for the
 * console: pick the active UI language (same fallback chain as every other
 * manifest text) and fill the `{name}` slots from the warning's `params`.
 *
 * Undefined means the owning package declared no text for the code; the caller
 * decides what to show (the console falls back to its generic advisory copy).
 */
export function pluginWarningText(
  labels: Record<string, string | Record<string, string>> | undefined,
  code: string,
  params: Record<string, string> | undefined,
  lang: string
): string | undefined {
  const text = pickLocaleText(labels?.[code], lang);
  if (!text) return undefined;
  if (!params) return text;
  // Regex-free, mirroring the i18n t() contract: a param key may come from a
  // plugin and an unescaped regex metacharacter would throw.
  let out = text;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(v);
  return out;
}
