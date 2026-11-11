/**
 * One-line text helpers shared by the harness layers that record or render a description.
 *
 * The budget is ONE number: discovery caps a package's own line at it, and the manifest writer caps
 * a caller-supplied line at the same value, so a card cannot render two different lengths depending
 * on where the text came from.
 */

/** Card-line cap (characters), including the ellipsis. */
export const DESCRIPTION_MAX = 300;

/** Fold every whitespace run to one space and cap at `DESCRIPTION_MAX`; null when no text remains. */
export function oneLine(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}
