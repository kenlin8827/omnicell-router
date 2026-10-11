import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeConnector } from '../src/opencode/connector.js';

describe('OpenCode v2 Connect & Dynamic Model Sync', () => {
  const connector = new OpenCodeConnector();

  it('should auto-discover local OpenCode background service credentials', () => {
    assert.strictEqual(connector.isAvailable(), true, 'Expected OpenCode service config to be found');
    const cfg = connector.getServiceConfig();
    assert.ok(cfg?.baseUrl.includes('49374'));
    assert.ok(cfg?.authHeader.startsWith('Basic '));
  });

  it('should fetch active providers from OpenCode v2 REST API', async () => {
    const providers = await connector.getProviders();
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length >= 5);
    const names = providers.map(p => p.name);
    assert.ok(names.some(n => n.includes('Alibaba') || n.includes('DeepSeek') || n.includes('Kimi')));
  });

  
});
