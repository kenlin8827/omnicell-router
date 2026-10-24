import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getConfigPath } from '../src/config/index.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ComboConfig, ModelRegistration, RouterConfig } from '../src/config/types.js';

/**
 * Hand-edited-YAML safety net for combos (ADR-0003 two-axis liveness): a
 * combo that lands on disk WITHOUT a console save event must register on the
 * lazy maybeRefreshTierMatch replay (2 s TTL; the first pool read fires it),
 * not wait for a restart. Regression cover for the incident where combos
 * present in config.yaml stayed invisible to routing (console badge
 * "inactive") until a manual re-save. Also pins the unchanged-section guard:
 * a no-op replay must not reset round-robin cursors.
 */

const model = (id: string): ModelRegistration => ({
  id,
  provider: 'p',
  upstreamModel: id,
  tier: 'lite',
  pricing: { input: 1, output: 2, cacheRead: 0.1 },
});

function makeConfig(combos?: ComboConfig[]): RouterConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: false },
    models: [model('p/a'), model('p/b')],
    ...(combos ? { combos } : {}),
  } as unknown as RouterConfig;
}

const RR_COMBOS: ComboConfig[] = [{ id: 'rr', selection: 'round_robin', models: ['p/a', 'p/b'] }];

describe('combo lazy refresh (hand-edited-YAML safety net)', () => {
  it('a combo that appears on disk without a save event registers on the next pool read', () => {
    // Write the combo the way a hand edit would: straight to the sandbox
    // config on disk, bypassing every console save route.
    fs.writeFileSync(
      getConfigPath(),
      'port: 3000\nhost: 127.0.0.1\napiKeys: []\ncombos:\n  - id: lazy-combo\n    models:\n      - p/a\n'
    );

    const registry = new ProviderRegistry(makeConfig(), false); // constructor saw NO combos
    assert.equal(registry.isCombo('lazy-combo'), false);

    registry.getCandidateModelsForTier('lite', false); // first pool read fires the lazy replay
    assert.equal(registry.isCombo('lazy-combo'), true);
    assert.deepEqual(
      registry.resolveCombo('lazy-combo').map((m) => m.id),
      ['p/a']
    );
  });

  it('unchanged-section replay is a no-op: round-robin cursors survive; real edits reset them', () => {
    const registry = new ProviderRegistry(makeConfig(RR_COMBOS), false);
    const members = () => registry.resolveCombo('rr');

    assert.equal(registry.pickComboLeader('rr', members()).id, 'p/a'); // cursor 0 → 1
    registry.applyCombos(RR_COMBOS.map((c) => ({ ...c }))); // same content, fresh objects
    assert.equal(registry.pickComboLeader('rr', members()).id, 'p/b'); // cursor preserved: 1 → 2

    registry.applyCombos(RR_COMBOS.map((c) => ({ ...c, note: 'edited' }))); // real change
    assert.equal(registry.pickComboLeader('rr', members()).id, 'p/a'); // cursor reset: 0 → 1
  });
});
