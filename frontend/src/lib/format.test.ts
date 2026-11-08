/**
 * `humanizeKey` — the label fallback for wire values that arrive as bare
 * identifiers.
 *
 * The motivating case is a plugin whose `configSchema` declares
 * `{key: 'previewBytes', type: 'number'}` with no localized `title`: the
 * settings drawer used to print the raw identifier as the field heading. The
 * contract that matters is (a) every casing convention spaces out, (b) the
 * result is stable and capitalized so it reads as a label, and (c) an input
 * with no word characters comes back untouched (never an empty heading).
 */
import { describe, expect, it } from 'vitest';
import { humanizeKey } from './format';

describe('humanizeKey', () => {
  it('spaces camelCase and capitalizes the head', () => {
    expect(humanizeKey('previewBytes')).toBe('Preview bytes');
    expect(humanizeKey('interceptLegacy')).toBe('Intercept legacy');
  });

  it('spaces snake_case and kebab-case', () => {
    expect(humanizeKey('max_result_chars')).toBe('Max result chars');
    expect(humanizeKey('tool-timeout-ms')).toBe('Tool timeout ms');
  });

  it('keeps acronym boundaries as separate words', () => {
    expect(humanizeKey('HTTPProxyHost')).toBe('Http proxy host');
    expect(humanizeKey('apiKeyID')).toBe('Api key id');
  });

  it('leaves a single word capitalized and a symbol-only key untouched', () => {
    expect(humanizeKey('model')).toBe('Model');
    expect(humanizeKey('__')).toBe('__');
  });
});
