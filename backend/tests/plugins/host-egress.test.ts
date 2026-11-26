import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { buildHostSdkForTests } from '../../src/plugins/host.js';
import { initProxyConfig } from '../../src/utils/proxy.js';
import type { ProxyConfig } from '../../src/config/types.js';

/**
 * A plugin wire reaches its upstream through `host.fetch`, never the global
 * fetch — that is the whole reason `proxy.includes` can govern it (ADR-0022).
 *
 * Without this seam a plugin did its own dialing, went direct whatever the
 * operator configured, and the console could not even say so: the probe had no
 * honest egress to report. The two primitives asserted here are the contract
 * every plugin's request path and `probe()` read:
 *
 *   - `host.fetch(url, init, { provider, model })` — the dial, split-aware;
 *   - `host.resolveProxy(url, { provider, model })` — the same decision
 *     WITHOUT dialing, so a probe can stamp its verdict.
 *
 * The proxy leg is asserted through `resolveProxy` (a real proxied dial needs a
 * reachable non-loopback upstream, impossible in a unit test) — and both
 * primitives run the SAME resolver, so a passing `resolveProxy` is what makes
 * the `host.fetch` dial split-aware.
 */

let server: ReturnType<typeof Bun.serve> | null = null;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
  initProxyConfig(undefined);
});

beforeEach(() => initProxyConfig(undefined));

type Host = ReturnType<typeof buildHostSdkForTests>;

const host = (): Host =>
  buildHostSdkForTests({
    id: 'probe-fixture',
    name: 'probe-fixture',
    version: '0.0.0',
    apiVersion: 1,
    type: 'model-service',
    parts: ['model-service'],
    wires: ['systemone'],
  } as never, '/tmp');

describe('plugin host egress seam', () => {
  it('exposes fetch and resolveProxy (a plugin without them cannot be split)', () => {
    const h = host();
    expect(typeof h.fetch).toBe('function');
    expect(typeof h.resolveProxy).toBe('function');
  });

  it('resolveProxy answers undefined when no include rule matches', () => {
    initProxyConfig({ enabled: true, url: 'http://proxy.invalid:8080' } as ProxyConfig);
    expect(host().resolveProxy('https://api.example.com/v1', { provider: 'p1', model: 'm1' })).toBeUndefined();
  });

  it('resolveProxy answers the proxy when the split matches this provider/model', () => {
    initProxyConfig({ enabled: true, url: 'http://127.0.0.1:7890/', includes: ['p2/*'] } as ProxyConfig);
    expect(host().resolveProxy('https://api.example.com/v1', { provider: 'p2', model: 'm1' })).toBe(
      'http://127.0.0.1:7890/'
    );
  });

  it('an excludes entry carves the model back out', () => {
    initProxyConfig({
      enabled: true,
      url: 'http://127.0.0.1:7890/',
      includes: ['p3/*'],
      excludes: ['p3/claude-*'],
    } as ProxyConfig);
    expect(host().resolveProxy('https://api.example.com/v1', { provider: 'p3', model: 'claude-opus-4' })).toBeUndefined();
    expect(host().resolveProxy('https://api.example.com/v1', { provider: 'p3', model: 'glm-5' })).toBeDefined();
  });

  it('host.fetch dials the target and honours the loopback bypass', async () => {
    // Loopback must never be proxied (a local model server is not an upstream),
    // so this dial is direct even with a matching include rule — and it proves
    // host.fetch actually performs the request rather than routing around it.
    initProxyConfig({ enabled: true, url: 'http://proxy.invalid:8080', includes: ['*'] } as ProxyConfig);
    const res = await host().fetch(`${base}/v1/models`, { method: 'GET' }, { provider: 'p4', model: 'm1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('host.fetch is split-aware for a non-loopback target', async () => {
    // An unreachable proxy + a matching rule: the dial goes THROUGH the proxy,
    // so it fails. A direct dial would reach the internet and answer 200/4xx —
    // failing fast here is the proof that the split was consulted.
    initProxyConfig({ enabled: true, url: 'http://127.0.0.1:9/', includes: ['p5/*'] } as ProxyConfig);
    await expect(
      host().fetch('https://api.example.com/v1/models', { method: 'GET', signal: AbortSignal.timeout(1500) }, { provider: 'p5', model: 'm1' })
    ).rejects.toBeDefined();
  });
});