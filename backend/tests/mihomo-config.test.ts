import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { loadConfig, sanitizeProxyConfig } from '../src/config/index.js';
import { SCHEMA_VERSION } from '../src/config/schema.js';
import { DEFAULT_MIHOMO_CONTROLLER_PORT, DEFAULT_MIHOMO_GROUP, DEFAULT_MIHOMO_MIXED_PORT } from '../src/config/defaults.js';
import { mihomoConfigSummary, redactSubscriptionUrl, renderMihomoConfig } from '../src/proxy/mihomo-config.js';

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
    expect(doc['external-controller']).toBe('127.0.0.1:9090');
    expect(doc.secret).toBe(secret);
    expect(doc['proxy-providers'].alpha.url).toContain('token=hide-me');
    expect(doc['proxy-providers'].beta).toBeUndefined();
    expect(doc['proxy-groups'][0].name).toBe('PROXY');
    expect(doc['proxy-groups'][0].use).toEqual(['alpha']);
    expect(doc.rules).toEqual(['MATCH,PROXY']);
    expect(rendered.providerNames).toEqual(['alpha']);
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

  test('refuses a missing secret and a port collision', () => {
    expect(() => renderMihomoConfig({ mixedPort: 1, controllerPort: 2, secret: '' })).toThrow();
    expect(() => renderMihomoConfig({ mixedPort: 9, controllerPort: 9, secret: 'x' })).toThrow(/differ/);
  });
});
