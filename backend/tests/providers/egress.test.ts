import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { DispatchingProvider } from '../../src/providers/executors/dispatch.js';
import { initProxyConfig } from '../../src/utils/proxy.js';
import { claimPluginWires } from '../../src/providers/plugin-wires.js';
import type { LLMProvider } from '../../src/providers/base.js';
import type { ModelRegistration, ProviderConfig, ProxyConfig, RouterConfig } from '../../src/config/types.js';

/**
 * The trace's egress stamp (ADR-0005 §8) is resolved at the dial through
 * `registry.egressFor`: the base comes from the serving transport's
 * `dialBaseFor`, and the decision from the SAME `resolveProxyUrl` the
 * executors use. Absence must stay UNKNOWN — never collapse to direct.
 */

const model = (provider = 'p', id = `${provider}/m`): ModelRegistration =>
  ({ id, provider, upstreamModel: 'm', tier: 'lite', pricing: { input: 1, output: 2, cacheRead: 0.1 } });

function makeRegistry(): ProviderRegistry {
  const config = {
    port: 3000,
    host: '127.0.0.1',
    circuitBreaker: { enabled: false },
    models: [],
  } as unknown as RouterConfig;
  const registry = new ProviderRegistry(config, false);
  registry.setAutoRefreshTierMatch(false);
  return registry;
}

function dialingProvider(base?: string): LLMProvider {
  return {
    name: 'p',
    dialBaseFor: () => base,
    createCompletion: async () => {
      throw new Error('egressFor must never execute the provider');
    },
  };
}

const proxy = (cfg: Partial<ProxyConfig>) => initProxyConfig(cfg as ProxyConfig);

describe('ProviderRegistry.egressFor', () => {
  it('no proxy config = direct', () => {
    initProxyConfig(undefined);
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('https://api.example.com/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'direct' });
  });

  it('enabled proxy = proxy with the REDACTED origin (no credentials)', () => {
    proxy({ enabled: true, url: 'http://user:pass@proxy.example:8080' });
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('https://api.example.com/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'proxy', origin: 'http://proxy.example:8080' });
    initProxyConfig(undefined);
  });

  it('an excludes hit forces direct even with a global proxy', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080', excludes: ['p/*'] });
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('https://api.example.com/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'direct' });
    initProxyConfig(undefined);
  });

  it('a non-empty includes list sends unlisted models direct and listed ones through the proxy', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080', includes: ['q/*'] });
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('https://p.example/v1'));
    registry.registerProvider('q', dialingProvider('https://q.example/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'direct' });
    assert.deepEqual(registry.egressFor(model('q')), { mode: 'proxy', origin: 'http://proxy.example:8080' });
    initProxyConfig(undefined);
  });

  it('a loopback dial base is direct even with a global proxy', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080' });
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('http://127.0.0.1:11434/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'direct' });
    initProxyConfig(undefined);
  });

  it('mihomo mode reports the loopback mixed port, not an exit node', () => {
    proxy({ enabled: true, mode: 'mihomo', mihomo: { mixedPort: 7891, controllerPort: 9090 } });
    const registry = makeRegistry();
    registry.registerProvider('p', dialingProvider('https://api.example.com/v1'));
    assert.deepEqual(registry.egressFor(model()), { mode: 'proxy', origin: 'http://127.0.0.1:7891' });
    initProxyConfig(undefined);
  });

  it('a transport without dialBaseFor (plugin-owned) = UNKNOWN, proxy configured or not', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080' });
    const registry = makeRegistry();
    registry.registerProvider('p', { name: 'p', createCompletion: async () => { throw new Error('x'); } });
    assert.equal(registry.egressFor(model()), undefined);
    initProxyConfig(undefined);
  });

  it('an unregistered provider = UNKNOWN', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080' });
    const registry = makeRegistry();
    assert.equal(registry.egressFor(model()), undefined);
    initProxyConfig(undefined);
  });

  it('mock mode never dials = UNKNOWN', () => {
    proxy({ enabled: true, url: 'http://proxy.example:8080' });
    const config = {
      port: 3000,
      host: '127.0.0.1',
      circuitBreaker: { enabled: false },
      models: [],
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, true);
    assert.equal(registry.egressFor(model()), undefined);
    initProxyConfig(undefined);
  });
});

describe('DispatchingProvider.dialBaseFor', () => {
  const poolConfig = {
    name: 'd',
    type: 'dispatch',
    baseUrl: 'https://pool-level.example',
    apiKey: 'sk-test',
  } as ProviderConfig;
  const wireModel = (wire?: string): ModelRegistration =>
    ({ ...model('d'), wire } as ModelRegistration);

  it('answers the per-wire base for core wires — never the pool-level baseUrl', () => {
    const dispatch = new DispatchingProvider(poolConfig, {
      'anthropic-messages': 'https://api.anthropic.com',
      'openai-chat': 'https://chat.example/v1',
    });
    assert.equal(dispatch.dialBaseFor(wireModel('anthropic-messages')), 'https://api.anthropic.com');
    assert.equal(dispatch.dialBaseFor(wireModel('openai-chat')), 'https://chat.example/v1');
  });

  it('an absent wire falls back to openai-chat (the executor default)', () => {
    const dispatch = new DispatchingProvider(poolConfig, { 'openai-chat': 'https://chat.example/v1' });
    assert.equal(dispatch.dialBaseFor(wireModel(undefined)), 'https://chat.example/v1');
  });

  it('an unknown non-plugin type still dials through the chat fallback and is core', () => {
    const dispatch = new DispatchingProvider(poolConfig, { 'weird-wire': 'https://weird.example/v1' });
    assert.equal(dispatch.dialBaseFor(wireModel('weird-wire')), 'https://weird.example/v1');
  });

  it('plugin-owned wires answer UNKNOWN', () => {
    claimPluginWires(['qoder']);
    try {
      const dispatch = new DispatchingProvider(poolConfig, { qoder: 'https://openapi.qoder.sh' });
      assert.equal(dispatch.dialBaseFor(wireModel('qoder')), undefined);
    } finally {
      claimPluginWires([]);
    }
  });

  it('skipped wires (systemone / unroutable) answer UNKNOWN', () => {
    const dispatch = new DispatchingProvider(poolConfig, {
      systemone: 'https://decision.example',
      unroutable: 'https://azure.example',
    });
    assert.equal(dispatch.dialBaseFor(wireModel('systemone')), undefined);
    assert.equal(dispatch.dialBaseFor(wireModel('unroutable')), undefined);
  });
});