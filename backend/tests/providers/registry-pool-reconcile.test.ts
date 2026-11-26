import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { LLMProvider } from '../../src/providers/base.js';
import type { ModelRegistration, RouterConfig } from '../../src/config/types.js';

/**
 * Hot-pool reconciliation must REPLACE a model record in place, not Object.assign
 * over it. Boot emits EITHER `configTier` (operator pin) OR `autoTier`
 * (member-list-claimed), and `reasoningDisableable` / `pricing` only when the
 * source states them. A merge that keeps keys absent from the fresh record
 * leaves a stale `autoTier` (silently re-claiming a freshly pinned model), a
 * stale always-think fact, or a stale price forever after the source changed —
 * the silent pin-loss / stale-fact-permanence class (round-3 Finding A).
 *
 * Identity is preserved: the Map entry and any held reference stay valid while
 * absent provenance/capability keys are reset.
 */

const fakeProvider = { name: 'p', createCompletion: async () => ({}), createStream: async function* () {} } as unknown as LLMProvider;

function reg(models: ModelRegistration[]): ProviderRegistry {
  const config = { port: 0, host: '127.0.0.1', models, tiers: {} } as unknown as RouterConfig;
  const r = new ProviderRegistry(config, false);
  r.setAutoRefreshMembers(false);
  r.registerProvider('p', fakeProvider);
  return r;
}

const base = (id: string, extra: Partial<ModelRegistration> = {}): ModelRegistration => ({
  id,
  provider: 'p',
  upstreamModel: id.split('/')[1] ?? id,
  tier: 'plus',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
  ...extra,
});

describe('applyDirectPool — replace-in-place reconciliation resets absent keys', () => {
  it('adding an operator pin clears the stale autoTier stamp (no silent re-claim)', () => {
    const r = reg([base('p/m', { autoTier: true })]);
    const held = r.getModel('p/m')!;
    expect(held.autoTier).toBe(true);
    // Operator adds `tier: ultra` to the defs file → fresh record is pinned.
    r.applyDirectPool([{ name: 'p', provider: fakeProvider, config: { baseUrl: 'https://p.test/v1' } } as never], [
      base('p/m', { configTier: 'ultra', tier: 'ultra' }),
    ]);
    const after = r.getModel('p/m')!;
    expect(after).toBe(held); // identity preserved
    expect(after.configTier).toBe('ultra');
    expect(after.tier).toBe('ultra');
    expect(after.autoTier).toBeUndefined(); // the stale stamp must NOT survive
  });

  it('removing the vendor always-think fact clears stale reasoningDisableable', () => {
    const r = reg([base('p/m', { autoTier: true, reasoningDisableable: false })]);
    expect(r.getModel('p/m')!.reasoningDisableable).toBe(false);
    // Vendor now allows thinking-off → fresh record omits the fact.
    r.applyDirectPool([{ name: 'p', provider: fakeProvider, config: { baseUrl: 'https://p.test/v1' } } as never], [
      base('p/m', { autoTier: true }),
    ]);
    expect(r.getModel('p/m')!.reasoningDisableable).toBeUndefined();
  });

  it('a catalog price disappearing clears stale pricing (unknown, never free)', () => {
    const r = reg([base('p/m', { autoTier: true })]);
    expect(r.getModel('p/m')!.pricing?.input).toBe(1);
    const noPrice = base('p/m', { autoTier: true });
    delete (noPrice as Partial<ModelRegistration>).pricing;
    r.applyDirectPool([{ name: 'p', provider: fakeProvider, config: { baseUrl: 'https://p.test/v1' } } as never], [noPrice]);
    expect(r.getModel('p/m')!.pricing).toBeUndefined();
  });

  it('removing the pin restores the autoTier stamp (member lists may move it again)', () => {
    const r = reg([base('p/m', { configTier: 'ultra', tier: 'ultra' })]);
    expect(r.getModel('p/m')!.configTier).toBe('ultra');
    r.applyDirectPool([{ name: 'p', provider: fakeProvider, config: { baseUrl: 'https://p.test/v1' } } as never], [
      base('p/m', { autoTier: true }),
    ]);
    const after = r.getModel('p/m')!;
    expect(after.configTier).toBeUndefined();
    expect(after.autoTier).toBe(true);
  });
});