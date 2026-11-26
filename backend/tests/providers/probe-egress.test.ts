import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { probeProvider } from '../../src/opencode/probe.js';
import { initProxyConfig } from '../../src/utils/proxy.js';
import type { ProxyConfig } from '../../src/config/types.js';

/**
 * A probe must REPORT the egress it took, not just succeed or fail.
 *
 * The model-scoped proxy split (`proxy.includes` / `proxy.excludes`) is the only
 * table that governs upstream calls, while `forwardProxy.rules` is host-scoped
 * and never touches gateway-originated traffic. Both mistakes — rules written in
 * the wrong table, or an exclude-only config, which proxies nothing — produce a
 * perfectly healthy-looking test that silently went direct. The `egress` limb is
 * what turns "it works" into "it works VIA the split I configured".
 *
 * Loopback targets stay direct by rule, so the proxy leg is asserted through the
 * resolver's own contract: a reachable non-loopback BaseURL is impossible in a
 * unit test, and `resolveProxyUrl` already proves the routing decision elsewhere
 * (`tests/proxy/proxy.test.ts`). What is asserted here is the STAMP: the probe
 * computes the same decision and never invents a direction it did not take.
 */

let server: ReturnType<typeof Bun.serve> | null = null;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ id: 'x', choices: [{ message: { content: 'pong' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
  initProxyConfig(undefined);
});

beforeEach(() => initProxyConfig(undefined));

describe('probe egress stamp', () => {
  it('reports direct when no include rule matches — the split never applied', async () => {
    initProxyConfig({ enabled: true, url: 'http://proxy.invalid:8080' } as ProxyConfig);
    const res = await probeProvider({ baseURL: `${base}/v1`, apiKey: 'k', model: 'm1', kind: 'openai-chat', provider: 'p1' });
    // Exclude-only / empty includes = allowlist gates nothing through.
    expect(res.ok).toBe(true);
    expect(res.egress).toBe('direct');
    expect(res.egressProxy).toBeUndefined();
  });

  it('reports direct for a loopback BaseURL even when an include rule matches', async () => {
    initProxyConfig({ enabled: true, url: 'http://proxy.invalid:8080', includes: ['*'] } as ProxyConfig);
    const res = await probeProvider({ baseURL: `${base}/v1`, apiKey: 'k', model: 'm1', kind: 'openai-chat', provider: 'p1' });
    expect(res.egress).toBe('direct');
  });

  it('reports proxy + redacted origin when the split matches this provider/model', async () => {
    // A matching include rule points the probe at an unreachable proxy on
    // loopback's BLANK side, so the dial fails — but the STAMP must already say
    // `proxy`: the operator's question is which way it went, not whether it
    // answered.
    initProxyConfig({ enabled: true, url: 'http://127.0.0.1:9/', includes: ['p2/*'] } as ProxyConfig);
    const res = await probeProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm1',
      kind: 'openai-chat',
      provider: 'p2',
      timeoutMs: 1500,
    });
    expect(res.ok).toBe(false);
    expect(res.egress).toBe('proxy');
    // Origin only — credentials in the proxy URL must never reach the console.
    expect(res.egressProxy).toBe('http://127.0.0.1:9');
  });

  it('a model that the split excludes reports direct', async () => {
    initProxyConfig({
      enabled: true,
      url: 'http://127.0.0.1:9/',
      includes: ['p3/*'],
      excludes: ['p3/claude-*'],
    } as ProxyConfig);
    const res = await probeProvider({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'claude-opus-4',
      kind: 'openai-chat',
      provider: 'p3',
      timeoutMs: 1500,
    });
    expect(res.egress).toBe('direct');
  });
});