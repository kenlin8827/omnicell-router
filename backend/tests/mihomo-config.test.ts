import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig, sanitizeProxyConfig } from '../src/config/index.js';
import { SCHEMA_VERSION } from '../src/config/schema.js';
import { DEFAULT_MIHOMO_CONTROLLER_PORT, DEFAULT_MIHOMO_GROUP, DEFAULT_MIHOMO_MIXED_PORT, DEFAULT_MIHOMO_TEST_URL } from '../src/config/defaults.js';
import { manualNodeFields, manualNodeMapping, mihomoConfigSummary, redactSubscriptionUrl, renderMihomoConfig } from '../src/proxy/mihomo-config.js';

describe('sanitizeProxyConfig', () => {
  test('an old file without mode stays manual and gains mihomo defaults', () => {
    const proxy = sanitizeProxyConfig({ enabled: true, url: 'http://127.0.0.1:7890' });
    expect(proxy.mode).toBe('manual');
    expect(proxy.enabled).toBe(true);
    expect(proxy.url).toBe('http://127.0.0.1:7890');
    expect(proxy.mihomo?.mixedPort).toBe(DEFAULT_MIHOMO_MIXED_PORT);
    expect(proxy.mihomo?.controllerPort).toBe(DEFAULT_MIHOMO_CONTROLLER_PORT);
    expect(proxy.mihomo?.selectedGroup).toBe(DEFAULT_MIHOMO_GROUP);
    expect(proxy.mihomo?.enabled).toBe(false);
    expect(proxy.mihomo?.subscriptions).toEqual([]);
  });

  test('explicit manual wins over mihomo.enabled', () => {
    const proxy = sanitizeProxyConfig({ mode: 'manual', mihomo: { enabled: true, mixedPort: 1 } });
    expect(proxy.mode).toBe('manual');
    expect(proxy.mihomo?.enabled).toBe(false);
    expect(proxy.mihomo?.mixedPort).toBe(1);
  });

  test('mihomo.enabled with no mode selects mihomo, and junk subscriptions are dropped', () => {
    const proxy = sanitizeProxyConfig({
      mihomo: {
        enabled: true,
        subscriptions: [
          { id: 'good', name: 'Good', url: 'https://example.com/sub?token=secret' },
          { id: 'bad id', name: 'Nope', url: 'https://example.com/x' },
          { id: 'ftp', name: 'Ftp', url: 'ftp://example.com/x' },
          { id: 'good', name: 'Dup', url: 'https://example.com/other' },
        ],
      },
    });
    expect(proxy.mode).toBe('mihomo');
    expect(proxy.mihomo?.subscriptions?.map((item) => item.id)).toEqual(['good']);
    expect(proxy.mihomo?.subscriptions?.[0].url).toContain('token=secret');
  });

  test('schemaVersion stays 1 and a v1 file without mihomo keys loads the defaults', () => {
    expect(SCHEMA_VERSION).toBe(1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-cfg-'));
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, 'schemaVersion: 1\nclient:\n  port: 3999\n  host: 127.0.0.1\nupstream:\n  proxy:\n    enabled: true\n    url: http://10.0.0.8:8888\n');
    const cfg = loadConfig(file);
    expect(cfg.proxy?.mode).toBe('manual');
    expect(cfg.proxy?.enabled).toBe(true);
    expect(cfg.proxy?.url).toBe('http://10.0.0.8:8888');
    expect(cfg.proxy?.mihomo?.mixedPort).toBe(DEFAULT_MIHOMO_MIXED_PORT);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('manual node form mapping', () => {
  test('renders form-owned protocol options and projects them back', () => {
    const base = { id: 'n1', name: 'n1', server: 'a.example', port: 443 };
    const vless = {
      ...base,
      type: 'vless',
      uuid: 'a89e9f26-1a54-4aad-bcfe-164cc3a0212c',
      network: 'grpc' as const,
      grpcServiceName: 'svc',
      tls: true,
      sni: 'a.example',
      flow: 'xtls-rprx-vision',
      realityPublicKey: 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
      realityShortId: '427f3316a646944b',
      alpn: ['h2'],
      clientFingerprint: 'chrome',
      udp: true,
      skipCertVerify: true,
    };
    const mapping = manualNodeMapping(vless);
    expect(mapping).toMatchObject({
      'grpc-opts': { 'grpc-service-name': 'svc' },
      'reality-opts': {
        'public-key': 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
        'short-id': '427f3316a646944b',
      },
      alpn: ['h2'],
      'client-fingerprint': 'chrome',
      'skip-cert-verify': true,
      udp: true,
    });
    expect(manualNodeFields(mapping)).toMatchObject({
      network: 'grpc',
      grpcServiceName: 'svc',
      sni: 'a.example',
      realityPublicKey: 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
      realityShortId: '427f3316a646944b',
      alpn: ['h2'],
      clientFingerprint: 'chrome',
      udp: true,
      skipCertVerify: true,
    });

    const ss = manualNodeMapping({
      ...base, type: 'ss', cipher: 'aes-256-gcm', password: 'p',
      plugin: 'obfs', pluginMode: 'tls', pluginHost: 'h.example',
    });
    expect(ss['plugin-opts']).toEqual({ mode: 'tls', host: 'h.example' });
    expect(manualNodeFields(ss)).toMatchObject({ plugin: 'obfs', pluginMode: 'tls', pluginHost: 'h.example' });

    const hy = manualNodeMapping({
      ...base, type: 'hysteria2', password: 'p',
      obfs: 'salamander', obfsPassword: 'x', up: '10 Mbps', down: '50 Mbps',
    });
    expect(hy).toMatchObject({ obfs: 'salamander', 'obfs-password': 'x', up: '10 Mbps', down: '50 Mbps' });
    expect(manualNodeFields(hy)).toMatchObject({ obfs: 'salamander', obfsPassword: 'x', up: '10 Mbps', down: '50 Mbps' });
  });
});

describe('renderMihomoConfig', () => {
  const secret = 'controller-secret-value';

  test('writes the mixed port, loopback controller, provider and MATCH rule', () => {
    const rendered = renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      subscriptions: [
        { id: 'alpha', name: 'Alpha', url: 'https://sub.example/a?token=hide-me', interval: 600, enabled: true },
        { id: 'beta', name: 'Beta', url: 'https://sub.example/b', enabled: false },
      ],
    });
    const doc = parse(rendered.yaml) as any;
    expect(doc['mixed-port']).toBe(7890);
    expect(doc['allow-lan']).toBe(false);
    expect(doc['bind-address']).toBe('127.0.0.1');
    // Default outbound mode, and the sanitizer must not drop a stored one.
    expect(doc.mode).toBe('rule');
    expect(parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, routingMode: 'direct' }).yaml)).toMatchObject({ mode: 'direct' });
    expect(sanitizeProxyConfig({ mihomo: { routingMode: 'direct' } }).mihomo?.routingMode).toBe('direct');
    expect(sanitizeProxyConfig({ mihomo: { routingMode: 'turbo' } }).mihomo?.routingMode).toBe('rule');
    expect(doc['external-controller']).toBe('127.0.0.1:9090');
    expect(doc.secret).toBe(secret);
    expect(doc['proxy-providers'].alpha.url).toContain('token=hide-me');
    expect(doc['proxy-providers'].beta).toBeUndefined();
    expect(doc['proxy-groups'][0].name).toBe('PROXY');
    expect(doc['proxy-groups'][0].use).toEqual(['alpha']);
    expect(doc.rules).toEqual(['MATCH,PROXY']);
    expect(rendered.providerNames).toEqual(['alpha']);
  });

  test('an automatic group carries the test url and never a DIRECT member', () => {
    const subs = [{ id: 'alpha', name: 'Alpha', url: 'https://sub.example/a' }];
    const auto = parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, groupType: 'url-test', groupInterval: 900, groupTolerance: 120, subscriptions: subs }).yaml) as any;
    expect(auto['proxy-groups'][0]).toMatchObject({ name: 'PROXY', type: 'url-test', interval: 900, tolerance: 120 });
    // The automatic group reuses the shipped health-check URL instead of
    // carrying a second copy that could drift from it.
    expect(auto['proxy-groups'][0].url).toBe(DEFAULT_MIHOMO_TEST_URL);
    // A manual selector keeps DIRECT; an automatic one must not, or a ~0 ms
    // direct route would win every cycle and bypass the tunnel.
    expect(auto['proxy-groups'][0].proxies).toBeUndefined();
    expect(auto['proxy-groups'][0].use).toEqual(['alpha']);

    const fallback = parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, groupType: 'fallback', subscriptions: subs }).yaml) as any;
    // The interval is the failure-detection window; the shipped default is a
    // minute, NOT mihomo's five. The provider health-check carries the same
    // cadence (it is disabled, but the literal 300 it used to carry was a
    // drift twin of the default).
    expect(fallback['proxy-groups'][0]).toMatchObject({ type: 'fallback', interval: 60 });
    expect(fallback['proxy-providers'].alpha['health-check'].interval).toBe(60);
    // `tolerance` is a url-test knob only; sending it to `fallback` is config noise.
    expect(fallback['proxy-groups'][0].tolerance).toBeUndefined();

    // Without an override the automatic group still gets the shipped default,
    // and a hand-built input is clamped to the same bounds the loader enforces.
    type RenderedGroups = { 'proxy-groups': Array<{ interval?: number }> };
    const autoDefault = parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, groupType: 'url-test', subscriptions: subs }).yaml) as RenderedGroups;
    expect(autoDefault['proxy-groups'][0].interval).toBe(60);
    const clamped = parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, groupType: 'url-test', groupInterval: 1, subscriptions: subs }).yaml) as RenderedGroups;
    expect(clamped['proxy-groups'][0].interval).toBe(30);

    expect((parse(renderMihomoConfig({ mixedPort: 7890, controllerPort: 9090, secret, subscriptions: subs }).yaml) as any)['proxy-groups'][0].proxies).toEqual(['DIRECT']);
  });

  test('group fields are whitelisted and clamped on load', () => {
    const cleaned = sanitizeProxyConfig({ mihomo: { groupType: 'url-test', groupInterval: 5, groupTolerance: 99999 } }).mihomo;
    expect(cleaned?.groupType).toBe('url-test');
    expect(cleaned?.groupInterval).toBe(30); // below MIHOMO_GROUP_INTERVAL_MIN_SEC → floored
    expect(cleaned?.groupTolerance).toBe(5000); // above the ms ceiling → clamped
    const junk = sanitizeProxyConfig({ mihomo: { groupType: 'chaos', groupInterval: 'soon' } }).mihomo;
    expect(junk?.groupType).toBe('select');
    // Junk and absence both stay absent: the renderer owns the default, so a
    // shipped-default change is not frozen into an existing file.
    expect(junk?.groupInterval).toBeUndefined();
    expect(sanitizeProxyConfig({ mihomo: {} }).mihomo?.groupInterval).toBeUndefined();
    // A remembered pick is manual-only. Under an automatic group the core owns
    // the choice; carrying the entry would let the boot restore pin the group
    // (mihomo's Set outranks its own delay ordering) and freeze auto-switching.
    const autoPick = sanitizeProxyConfig({ mihomo: { groupType: 'url-test', selectedNodes: { PROXY: 'node-b', OTHER: 'keep-me' } } }).mihomo;
    expect(autoPick?.selectedNodes).toEqual({ OTHER: 'keep-me' });
    const manualPick = sanitizeProxyConfig({ mihomo: { selectedNodes: { PROXY: 'node-b' } } }).mihomo;
    expect(manualPick?.selectedNodes).toEqual({ PROXY: 'node-b' });
  });

  test('the log summary never contains the secret or the subscription query', () => {
    const rendered = renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      subscriptions: [{ id: 'alpha', name: 'Alpha', url: 'https://user:token@sub.example/a?token=hide-me' }],
    });
    const summary = mihomoConfigSummary(rendered, { mixedPort: 7890, controllerPort: 9090 });
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain('hide-me');
    expect(summary).toContain('providers=1');
    expect(redactSubscriptionUrl('https://user:token@sub.example/a?token=hide-me')).toBe('https://sub.example/a');
  });

  test('custom rules render before the MATCH catch-all, targets stay symbolic', () => {
    const rendered = renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      group: 'TUNNEL',
      rules: [
        { type: 'DOMAIN-SUFFIX', payload: 'cn.example', target: 'DIRECT' },
        { type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'PROXY' },
        { type: 'DOMAIN-KEYWORD', payload: 'ads', target: 'REJECT' },
      ],
    });
    const doc = parse(rendered.yaml) as { rules: string[] };
    expect(doc.rules).toEqual([
      'DOMAIN-SUFFIX,cn.example,DIRECT',
      // PROXY is a symbolic target resolved against the live group name.
      'IP-CIDR,10.0.0.0/8,TUNNEL,no-resolve',
      'DOMAIN-KEYWORD,ads,REJECT',
      'MATCH,TUNNEL',
    ]);
  });

  test('custom rules are whitelisted: unknown types, bad targets and separators are dropped', () => {
    const cleaned = sanitizeProxyConfig({
      mihomo: {
        rules: [
          { type: 'domain-suffix', payload: ' a.example ', target: 'direct' },
          { type: 'GEOIP', payload: 'CN', target: 'DIRECT' },
          { type: 'DOMAIN', payload: 'x.example,DIRECT', target: 'PROXY' },
          { type: 'DOMAIN', payload: '', target: 'PROXY' },
          { type: 'DOMAIN', payload: 'y.example', target: 'BOGUS' },
        ],
      },
    }).mihomo;
    expect(cleaned?.rules).toEqual([
      { type: 'DOMAIN-SUFFIX', payload: 'a.example', target: 'DIRECT' },
      { type: 'DOMAIN', payload: 'y.example', target: 'PROXY' },
    ]);
  });

  test('a rule provenance label keeps printable characters and drops the rest', () => {
    const rules = sanitizeProxyConfig({
      mihomo: {
        rules: [
          { type: 'DOMAIN', payload: 'a.example', target: 'PROXY', source: 'Air-Port' },
          { type: 'DOMAIN', payload: 'b.example', target: 'PROXY', source: 'bad\nlabel' },
        ],
      },
    }).mihomo?.rules ?? [];
    expect(rules.map((rule) => rule.source)).toEqual(['Air-Port', 'bad label']);
  });

  test('refuses a missing secret and a port collision', () => {
    expect(() => renderMihomoConfig({ mixedPort: 1, controllerPort: 2, secret: '' })).toThrow();
    expect(() => renderMihomoConfig({ mixedPort: 9, controllerPort: 9, secret: 'x' })).toThrow(/differ/);
  });

  test('manual nodes render into proxies and join the group', () => {
    const rendered = renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      subscriptions: [{ id: 'alpha', name: 'Alpha', url: 'https://sub.example/a' }],
      manualNodes: [
        {
          id: 'n1', name: 'HK', type: 'vmess', server: 'h.example', port: 443,
          uuid: '11111111-2222-3333-4444-555555555555', alterId: 0,
          network: 'ws', tls: true, sni: 'sni.example', wsPath: '/ws', wsHost: 'cdn.example',
        },
        {
          id: 'n2', name: 'SS', type: 'ss', server: 's.example', port: 8388,
          cipher: 'aes-256-gcm', password: 'secret',
        },
      ],
    });
    const doc = parse(rendered.yaml) as any;
    expect(doc.proxies).toEqual([
      {
        name: 'HK', type: 'vmess', server: 'h.example', port: 443,
        uuid: '11111111-2222-3333-4444-555555555555', alterId: 0, cipher: 'auto',
        network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'cdn.example' } },
        tls: true, servername: 'sni.example',
      },
      { name: 'SS', type: 'ss', server: 's.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' },
    ]);
    // Providers and manual nodes share the selector; DIRECT stays last.
    expect(doc['proxy-groups'][0].use).toEqual(['alpha']);
    expect(doc['proxy-groups'][0].proxies).toEqual(['HK', 'SS', 'DIRECT']);

    // An automatic group can still choose a manual node, but never DIRECT.
    const auto = parse(renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      groupType: 'url-test',
      manualNodes: [{ id: 'n1', name: 'HK', type: 'trojan', server: 'h.example', port: 443, password: 'p' }],
    }).yaml) as any;
    expect(auto['proxy-groups'][0].proxies).toEqual(['HK']);
    expect(auto['proxy-groups'][0].proxies).not.toContain('DIRECT');
  });

  test('manual nodes are whitelisted by protocol and name', () => {
    const cleaned = sanitizeProxyConfig({
      mihomo: {
        manualNodes: [
          {
            id: 'n1', name: 'HK', type: 'vmess', server: 'h.example', port: 443,
            uuid: '11111111-2222-3333-4444-555555555555', network: 'ws', tls: true,
            wsPath: '/ws', wsHost: 'cdn.example',
            // Wrong-protocol residue must not reach the generated config.
            cipher: 'aes-256-gcm', password: 'stale',
          },
          { id: 'n2', name: 'SS', type: 'ss', server: 's.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' },
          // Unknown cipher, missing uuid, reserved name, bad port, duplicate name.
          { id: 'n3', name: 'BadCipher', type: 'ss', server: 'x.example', port: 1, cipher: 'rc4', password: 'x' },
          { id: 'n4', name: 'NoUuid', type: 'vless', server: 'x.example', port: 443 },
          { id: 'n5', name: 'DIRECT', type: 'trojan', server: 'x.example', port: 443, password: 'x' },
          { id: 'n6', name: 'BadPort', type: 'trojan', server: 'x.example', port: 70000, password: 'x' },
          { id: 'n7', name: 'SS', type: 'trojan', server: 'x.example', port: 443, password: 'x' },
        ],
      },
    }).mihomo?.manualNodes ?? [];
    expect(cleaned.map((node) => node.name)).toEqual(['HK', 'SS']);
    expect(cleaned[0]).toMatchObject({
      type: 'vmess',
      uuid: '11111111-2222-3333-4444-555555555555',
      network: 'ws',
      tls: true,
      wsPath: '/ws',
      wsHost: 'cdn.example',
    });
    expect(cleaned[0].password).toBeUndefined();
    expect(cleaned[1]).toMatchObject({ cipher: 'aes-256-gcm', password: 'secret' });
  });

  test('a raw YAML node keeps options the console does not model', () => {
    const pasted = stringify({
      name: 'xiong',
      type: 'vless',
      server: '144.225.124.184',
      port: 24443,
      uuid: 'a89e9f26-1a54-4aad-bcfe-164cc3a1333',
      network: 'tcp',
      tls: true,
      flow: 'xtls-rprx-vision',
      servername: 'www.cloudflare.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ', 'short-id': '427f3316a646944b' },
    });
    const cleaned = sanitizeProxyConfig({ mihomo: { manualNodes: [{ id: 'n1', yaml: pasted }] } }).mihomo?.manualNodes ?? [];
    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toMatchObject({
      name: 'xiong', type: 'vless', server: '144.225.124.184', port: 24443,
    });
    expect(cleaned[0].yaml).toContain('reality-opts');

    const doc = parse(renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      manualNodes: cleaned,
    }).yaml) as any;
    expect(doc.proxies[0]).toMatchObject({
      name: 'xiong',
      type: 'vless',
      port: 24443,
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ', 'short-id': '427f3316a646944b' },
    });
  });

  test('a pasted mapping of a whitelisted protocol still needs its credentials', () => {
    const ss = (extra: Record<string, unknown>) => stringify({ name: 'ss-node', type: 'ss', server: 's.example', port: 8388, ...extra });
    const cleaned = sanitizeProxyConfig({
      mihomo: {
        manualNodes: [
          // No cipher/password: the core would reject the whole generated file.
          { id: 'n1', yaml: ss({}) },
          { id: 'n2', yaml: ss({ cipher: 'aes-256-gcm', password: 'p' }) },
          // A protocol outside the whitelist owns its options: identity only.
          { id: 'n3', yaml: stringify({ name: 'tuic-node', type: 'tuic', server: 't.example', port: 443, uuid: 'u' }) },
        ],
      },
    }).mihomo?.manualNodes ?? [];
    expect(cleaned.map((node) => node.id)).toEqual(['n2', 'n3']);
  });

  test('the delay-test URL is validated and rendered', () => {
    expect(sanitizeProxyConfig({ mihomo: {} }).mihomo?.testUrl).toBe(DEFAULT_MIHOMO_TEST_URL);
    let cleaned = sanitizeProxyConfig({ mihomo: { testUrl: 'https://probe.example/ping' } });
    expect(cleaned.mihomo?.testUrl).toBe('https://probe.example/ping');
    for (const bad of ['ftp://probe.example/ping', 'https://user:pw@probe.example/ping', 'not a url']) {
      cleaned = sanitizeProxyConfig({ mihomo: { testUrl: bad } });
      expect(cleaned.mihomo?.testUrl).toBe(DEFAULT_MIHOMO_TEST_URL);
    }

    const doc = parse(renderMihomoConfig({
      mixedPort: 7890,
      controllerPort: 9090,
      secret,
      groupType: 'url-test',
      testUrl: 'https://probe.example/ping',
      subscriptions: [{ id: 'alpha', name: 'Alpha', url: 'https://sub.example/a' }],
    }).yaml) as any;
    expect(doc['proxy-groups'][0].url).toBe('https://probe.example/ping');
    expect(doc['proxy-providers'].alpha['health-check'].url).toBe('https://probe.example/ping');
  });
});
