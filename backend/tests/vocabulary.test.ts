import { describe, expect, test } from 'bun:test';
import { NPM_VOCABULARY, vocabularyAliasFor } from '../src/providers/vocabulary.js';
import { wireFor } from '../src/providers/wire.js';
import { opencodeV2PackageFor } from '../src/opencode/user-config.js';

/**
 * The npm SDK vocabulary is served to the console over
 * /api/admin/opencode/npm-vocabulary and DRIVES every UI npm surface. These
 * pins keep the table honest against the actual wire resolver:
 *   - alias and v2 package resolve to the SAME wire (the write-side mapping in
 *     user-config.ts must never change the wire a user gets) for every entry the
 *     dropdown OFFERS;
 *   - every v2 package is opencode-v2 shaped and round-trips through the
 *     write-side mapping (alias → package → same wire);
 *   - orders are unique and ascending (stable dropdown order).
 */
describe('npm vocabulary consistency', () => {
  test('alias and v2 package resolve to the same wire', () => {
    for (const e of NPM_VOCABULARY) {
      expect(wireFor(e.alias)).toBe(e.wire);
      expect(wireFor(e.package)).toBe(e.wire);
    }
  });

  test('write-side mapping round-trips each alias onto its v2 package', () => {
    for (const e of NPM_VOCABULARY) {
      expect(opencodeV2PackageFor(e.alias)).toBe(e.package);
      expect(vocabularyAliasFor(e.package)).toBe(e.alias);
      expect(vocabularyAliasFor(e.alias)).toBe(e.alias);
    }
  });

  test('unknown npm strings pass through the display alias untouched', () => {
    expect(vocabularyAliasFor('@scope/custom-provider')).toBe('@scope/custom-provider');
    expect(vocabularyAliasFor('@opencode/ai/providers/unknown-segment')).toBe(
      '@opencode/ai/providers/unknown-segment'
    );
  });

  test('orders are unique and ascending — the dropdown order is stable', () => {
    const orders = NPM_VOCABULARY.map((e) => e.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(new Set(orders).size).toBe(orders.length);
  });

  // Version-scoped exception (ADR-0008 2026-10-23 amendment): the decision alias
  // is not OFFERED while the client ships no `typesafe` package. The wire itself
  // is still resolvable, so hand-written defs keep working.
  test('the decision alias is withheld from the dropdown while the client cannot load its package', () => {
    expect(NPM_VOCABULARY.find((e) => e.alias === '@ai-sdk/typesafe-ai')).toBeUndefined();
    expect(wireFor('@ai-sdk/typesafe-ai')).toBe('systemone');
    expect(wireFor('@opencode/ai/providers/typesafe')).toBe('systemone');
  });
});
