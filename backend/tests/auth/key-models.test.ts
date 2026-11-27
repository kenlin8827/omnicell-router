import '../helpers/sandbox-home.js';
import { describe, it, expect } from 'bun:test';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { loadConfig } from '../../src/config/index.js';
import { allowedFollowLists, buildKeyModelsView } from '../../src/auth/key-models.js';
import { createApiKey, deleteApiKey, listApiKeys } from '../../src/auth/api-keys.js';

describe('buildKeyModelsView', () => {
  it('returns error for an unknown key id', () => {
    const registry = new ProviderRegistry(loadConfig(), false);
    const view = buildKeyModelsView('no-such-key', registry);
    expect(view.status).toBe('error');
  });

  it('returns ok view with virtual rows for a real key', () => {
    const created = createApiKey({ name: 'key-models-test' });
    expect(created.success).toBe(true);
    const id = created.data!.id;
    try {
      const registry = new ProviderRegistry(loadConfig(), false);
      const view = buildKeyModelsView(id, registry);
      expect(view.status).toBe('ok');
      if (view.status !== 'ok') return;
      expect(view.models.some((m) => m.id === 'auto' && m.virtual)).toBe(true);
      const lists = allowedFollowLists(view);
      expect(Array.isArray(lists.extraModels)).toBe(true);
      expect(Array.isArray(lists.virtualModels)).toBe(true);
    } finally {
      deleteApiKey(id);
      expect(listApiKeys(false).find((k) => k.id === id)).toBeUndefined();
    }
  });
});
