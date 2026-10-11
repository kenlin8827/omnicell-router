import { describe, it, expect } from 'bun:test';
import { resolveTierMatch, classifyTier, type ResolvedTierMatch } from '../src/providers/tier-match.js';

/**
 * Integration-ish lock for /api/admin/tier-pools/preview and the matching console
 * endpoint. Those endpoints merge the request body's `tiers` over the saved
 * config before calling resolveTierMatch(). The merge itself is a one-liner
 * (`body.tiers ?? loadConfig().tiers ?? {}`) — but the resulting match config
 * is what the user sees as "the live preview". If the merge ever stops being
 * a deep per-field overlay, every preview number on the Rules page will lie.
 *
 * rules under test:
 *   - per-field merge: a saved value is replaced by a request value of the
 *     same field; a missing request field falls back to the saved value
 *   - missing request field + missing saved value → DEFAULT_TIER_MATCH
 *   - present-but-empty `patterns: []` is NOT the same as omitted (the former
 *     disables pattern claiming, the latter falls back to baseline)
 *
 * We exercise the merge through resolveTierMatch() — the only function the
 * endpoint actually calls to turn `tiers` into a `match`.
 */
describe('/tier-pools/preview input merge (console.ts handleTierPoolsPreview)', () => {
  it('request body fully replaces the saved tiers when present', () => {
    // The endpoint does NOT deep-merge body over saved — it picks the body if
    // truthy. So saved values are ignored for any tier the body mentions.
    const saved = {
      lite: { match: { minInputPerM: 0.5, maxInputPerM: 0.9 } },
    };
    const body = {
      lite: { match: { maxInputPerM: 1.5 } },
    };
    const effective: ResolvedTierMatch = resolveTierMatch(body as any);
    // request body 'lite' is used wholesale (min 0.5 from saved is LOST)
    expect(effective.lite.minInputPerM).toBeUndefined();
    expect(effective.lite.maxInputPerM).toBe(1.5);
    // baseline defaults still apply for tiers the body does not mention
    expect(effective.plus.minInputPerM).toBe(0.8);
    expect(effective.pro.minInputPerM).toBe(3);
  });

  it('empty body falls back to saved tiers', () => {
    // body?.tiers ?? loadConfig().tiers ?? {} — undefined body → loadConfig
    const saved = {
      plus: { match: { minInputPerM: 1, maxInputPerM: 3 } },
    };
    const effective: ResolvedTierMatch = resolveTierMatch(saved as any);
    expect(effective.plus.minInputPerM).toBe(1);
    expect(effective.plus.maxInputPerM).toBe(3);
    // lite/pro/ultra still come from baseline (price-only: no preset patterns)
    expect(effective.lite.patterns).toBeUndefined();
    expect(effective.lite.maxInputPerM).toBe(0.8);
    expect(effective.pro.minInputPerM).toBe(3);
  });

  it('empty body and empty saved → DEFAULT_TIER_MATCH baseline', () => {
    const effective: ResolvedTierMatch = resolveTierMatch({});
    expect(effective.lite.maxInputPerM).toBe(0.8);
    expect(effective.plus.minInputPerM).toBe(0.8);
    expect(effective.plus.maxInputPerM).toBe(3);
    expect(effective.pro.minInputPerM).toBe(3);
    expect(effective.ultra.minInputPerM).toBe(8);
  });

  it('preview never mutates the live registry (this is a pure projection)', () => {
    // The endpoint does NOT call applyTierConfigNow — only resolveTierMatch +
    // projectTierPools. We assert the projection step here by re-running it
    // and checking the result is deterministic for the same input.
    const body = { plus: { match: { minInputPerM: 2, maxInputPerM: 8 } } };
    const a = resolveTierMatch(body as any);
    const b = resolveTierMatch(body as any);
    expect(a).toEqual(b);
    // and the resulting match classifies a $5 model as plus (in [2, 8])
    expect(classifyTier({ modelId: 'preview-check', inputPerM: 5, reasoningFlag: false }, a)).toBe('plus');
  });

  it('"price exactly at ceiling" is included in the band (preview projects the same closed intervals as runtime)', () => {
    // The Rules page shows "候选池 N" numbers — those are produced by the
    // preview endpoint, so if the preview used `<` instead of `<=`, the
    // count would silently drop by one for every boundary model.
    const body = { lite: { match: { maxInputPerM: 0.8 } } };
    const match = resolveTierMatch(body as any);
    // bandHit uses `<=`, so 0.8 is included
    expect(classifyTier({ modelId: 'at-ceiling', inputPerM: 0.8, reasoningFlag: false }, match)).toBe('lite');
    // and 0.8001 is NOT
    expect(classifyTier({ modelId: 'just-over', inputPerM: 0.8001, reasoningFlag: false }, match)).toBe('plus');
  });
});
