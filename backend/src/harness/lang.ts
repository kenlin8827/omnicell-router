import type { TranslationLang } from './translation.js';

/**
 * Script-based language evidence for a third-party document (README, published body).
 *
 * Only the scripts that CANNOT be confused are recognized: Han-dominant prose is Chinese, kana marks
 * Japanese, Hangul marks Korean. Latin-script languages (en/es/fr/de/pt) are deliberately NOT guessed
 * from stop words — a wrong guess would silently serve a German README to an English console, which
 * is worse than spending one translation.
 *
 * The console uses the verdict to skip machine translation when the text is already in its language;
 * the detail reader uses it to accept a linked localized README only when the linked body really is
 * in that script. `null` means "no evidence", never "English".
 */
export function scriptLanguage(text: string): TranslationLang | null {
  // Fenced code is language-neutral (and often Latin-heavy identifiers in an otherwise Chinese page);
  // counting it would hide exactly the signal this function exists to find.
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const letters = (prose.match(/\p{L}/gu) ?? []).length;
  // Too little prose to judge: badges and a one-line blurb prove nothing.
  if (letters < 40) return null;
  const han = (prose.match(/\p{Script=Han}/gu) ?? []).length;
  const kana = (prose.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const hangul = (prose.match(/\p{Script=Hangul}/gu) ?? []).length;
  // Kana/Hangul are decisive even in small proportion: a Japanese page is mostly Han-plus-kana, and
  // a Chinese page carries no kana at all.
  if (kana / letters > 0.05) return 'ja';
  if (hangul / letters > 0.05) return 'ko';
  if (han / letters > 0.4) return 'zh';
  return null;
}
