import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { registerMihomoRoutes } from '../src/routes/mihomo.js';
import { setMihomoDownloadFetchForTests } from '../src/proxy/mihomo-binary.js';
import { mihomoWorkDir, setMihomoSidecarDepsForTests } from '../src/proxy/mihomo-sidecar.js';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mihomoAssetName } from '../src/proxy/mihomo-binary.js';

describe('mihomo admin routes', () => {
  const SECRET = 'route-secret-value';
  let controller: http.Server;
  let port = 0;
  let selected = 'node-a';
  let liveMode = 'rule';
  const app = Fastify();

  beforeAll(async () => {
    setMihomoSidecarDepsForTests({
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => ({ pid: 1, on() {}, unref() {} }),
    });
    controller = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${SECRET}`) {
          res.writeHead(401);
          res.end();
          return;
        }
        const url = req.url || '';
        if (url === '/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: 'v1.2.3' }));
          return;
        }
        if (url === '/proxies' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            proxies: {
              PROXY: { name: 'PROXY', type: 'Selector', now: selected, all: ['node-a', 'DIRECT'] },
              // A second group whose members are NOT in PROXY's list: asking for
              // it must resolve type/delay from the snapshot, never from the
              // other group's rows (that mismatch rendered "Unknown").
              SUB: { name: 'SUB', type: 'Selector', now: 'node-b', all: ['node-b'] },
              // A group whose only member is operator-authored: the listing
              // must attribute it to the manual list, not to a provider id.
              MANUAL: { name: 'MANUAL', type: 'Selector', now: 'manual-1', all: ['manual-1'] },
              // A group whose members exist ONLY in a provider snapshot.
              PROVIDERS: { name: 'PROVIDERS', type: 'Selector', now: 'node-b', all: ['node-b'] },
              // An automatic group: mihomo owns the pick, the console must not.
              AUTO: { name: 'AUTO', type: 'URLTest', now: 'node-a', all: ['node-a', 'node-b'] },
              'node-a': { name: 'node-a', type: 'Vmess', history: [{ delay: 30 }] },
              'node-b': { name: 'node-b', type: 'Trojan', history: [{ delay: 88 }] },
              DIRECT: { name: 'DIRECT', type: 'Direct' },
              'manual-1': { name: 'manual-1', type: 'Vless', history: [{ delay: 12 }] },
              // Current mihomo renders its delay timeout as 504 + "Timeout".
              'node-timeout': { name: 'node-timeout', type: 'Hysteria2' },
            },
          }));
          return;
        }
        if (req.method === 'PUT' && url === '/proxies/PROXY') {
          selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.startsWith('/proxies/node-timeout/delay')) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Timeout' }));
          return;
        }
        if (url.startsWith('/proxies/') && url.includes('/delay')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ delay: 11 }));
          return;
        }
        if (url.startsWith('/group/') && url.includes('/delay')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 'node-a': 11, DIRECT: 1 }));
          return;
        }
        // The effective rule table. Only the generated MATCH rule exists here —
        // a subscription's own `rules:` never reach it.
        if (url === '/rules' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            rules: [
              { type: 'DomainSuffix', payload: 'corp.internal', proxy: 'DIRECT' },
              { type: 'Match', payload: '', proxy: 'PROXY' },
            ],
          }));
          return;
        }
        if (url === '/providers/proxies' && req.method === 'GET') {
          // Two subscriptions, so the nodes tab has something to filter by and
          // the listing can attribute each row to its provider.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            providers: {
              subA: { name: 'subA', vehicleType: 'HTTP', proxies: [{ name: 'node-a' }] },
              // Provider-backed nodes: /proxies never lists these, so type/delay
              // must come from here — otherwise the whole subscription renders
              // as type "Unknown" with no delay.
              subB: {
                name: 'subB',
                vehicleType: 'HTTP',
                proxies: [
                  { name: 'node-b', type: 'Trojan', history: [{ delay: 88 }] },
                  // Present ONLY here: the config-scoped delay route answers
                  // 404 for a provider member, so its test must use this scope.
                  { name: 'sub-only', type: 'Hysteria2', history: [{ delay: 77 }] },
                ],
              },
            },
          }));
          return;
        }
        if (req.method === 'GET' && /^\/providers\/proxies\/[^/]+\/[^/]+\/healthcheck/.test(url)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ delay: 55 }));
          return;
        }
        if (req.method === 'PUT' && url.startsWith('/providers/proxies/')) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === 'PUT' && url.startsWith('/configs')) {
          res.writeHead(204);
          res.end();
          return;
        }
        // mihomo's own outbound mode: the console reads it and PATCHes it live.
        if (url === '/configs' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ mode: liveMode, 'mixed-port': 7890 }));
          return;
        }
        if (url === '/configs' && req.method === 'PATCH') {
          liveMode = JSON.parse(Buffer.concat(chunks).toString('utf8')).mode;
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => controller.listen(0, '127.0.0.1', () => resolve()));
    port = (controller.address() as AddressInfo).port;
    const saved = saveConfig({
      proxy: {
        enabled: true,
        mode: 'mihomo',
        mihomo: {
          mixedPort: port === 7890 ? 7891 : 7890,
          controllerPort: port,
          controllerSecret: SECRET,
          selectedGroup: 'PROXY',
          // Named subscriptions: the nodes tab must label providers by NAME.
          subscriptions: [{ id: 'subB', name: 'Airport B', url: 'https://sub.example/b' }],
        },
      },
    });
    expect(saved.success).toBe(true);
    registerMihomoRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    setMihomoSidecarDepsForTests(null);
    setMihomoDownloadFetchForTests(undefined);
    await app.close();
    await new Promise<void>((resolve, reject) => controller.close((err) => err ? reject(err) : resolve()));
  });

  test('serves a PAC script pointing at the configured mixed port', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy.pac' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ns-proxy-autoconfig');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.payload;
    expect(body).toContain('function FindProxyForURL(url, host)');
    // Loopback and private ranges stay direct; everything else takes the port.
    expect(body).toContain("if (shExpMatch(host, '192.168.*')) return 'DIRECT';");
    expect(body).toContain("if (isPlainHostName(host)) return 'DIRECT';");
    expect(body).toMatch(/return 'PROXY 127\.0\.0\.1:\d+';/);
    // No secret or subscription material in a public, unauthenticated document.
    expect(body).not.toContain(SECRET);
  });

  test('status, proxies, select and delay', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/status' });
    expect(status.statusCode).toBe(200);
    const body = status.json() as any;
    expect(body.running).toBe(true);
    expect(body.version).toBe('v1.2.3');
    expect(body.secretConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SECRET);

    const proxies = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies' });
    expect(proxies.statusCode).toBe(200);
    const listed = proxies.json() as any;
    expect(listed.nodes.map((node: { name: string }) => node.name)).toEqual(['node-a', 'DIRECT']);
    expect(listed.groupType).toBe('select');
    // DIRECT is a built-in; node-a's provider (`subA`) is not a DECLARED
    // subscription either — mihomo's own `default` provider looks the same, so
    // neither may surface as a filterable source.
    expect(listed.nodes.map((node: { source: { kind: string } }) => node.source.kind)).toEqual(['builtin', 'builtin']);
    expect(listed.nodes[0].selected).toBe(true);

    // An automatic group reports its kind so the console can disable its picker.
    const auto = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies?group=AUTO' });
    expect(auto.statusCode).toBe(200);
    expect((auto.json() as any).groupType).toBe('url-test');

    const sub = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies?group=SUB' });
    expect(sub.statusCode).toBe(200);
    const subBody = sub.json() as any;
    expect(subBody.group).toBe('SUB');
    expect(subBody.nodes).toEqual([{
      name: 'node-b', type: 'Trojan', delay: 88, selected: true,
      manualId: null, source: { kind: 'subscription', id: 'subB' },
    }]);

    const select = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/select',
      payload: { group: 'PROXY', name: 'DIRECT' },
    });
    expect(select.statusCode).toBe(200);
    expect(select.json().name).toBe('DIRECT');

    const again = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies' });
    expect(again.json().now).toBe('DIRECT');

    const delay = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'node-a' },
    });
    expect(delay.statusCode).toBe(200);
    expect(delay.json().delay).toBe(11);

    // A subscription node is absent from /proxies: the config-scoped route
    // answers 404, so the test must be routed through its provider.
    const providerDelay = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'sub-only' },
    });
    expect(providerDelay.statusCode).toBe(200);
    expect(providerDelay.json().delay).toBe(55);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'no-such-node' },
    });
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json().code).toBe('node-not-found');
  });

  test('subscription crud rejects a bad url and keeps the token out of the error', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/subscriptions',
      payload: { name: 'Nope', url: 'not a url' },
    });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/subscriptions',
      payload: { name: 'Alpha', url: 'https://sub.example/feed?token=hide-me', interval: 600 },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().subscription.id as string;
    expect(created.json().subscription.url).toContain('token=hide-me');
    expect(JSON.stringify(created.json().sidecar)).not.toContain('hide-me');

    const list = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/subscriptions' });
    expect(list.json().subscriptions.some((item: { id: string }) => item.id === id)).toBe(true);

    const refreshed = await app.inject({ method: 'POST', url: `/api/admin/proxy/mihomo/subscriptions/${id}/refresh` });
    expect(refreshed.statusCode).toBe(200);

    const removed = await app.inject({ method: 'DELETE', url: `/api/admin/proxy/mihomo/subscriptions/${id}` });
    expect(removed.statusCode).toBe(200);
  });

  test('manual node crud validates, persists and writes through to the config', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: { name: 'NoSecret', type: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm' },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: { name: 'My SS', type: 'ss', server: 'ss.example', port: 8388, cipher: 'aes-256-gcm', password: 'secret' },
    });
    expect(created.statusCode).toBe(200);
    const node = created.json().node as { id: string; name: string; type: string };
    expect(node).toMatchObject({ name: 'My SS', type: 'ss' });
    expect((loadConfig().proxy?.mihomo?.manualNodes ?? []).map((item) => item.name)).toContain('My SS');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: { name: 'My SS', type: 'ss', server: 'other.example', port: 8388, cipher: 'aes-256-gcm', password: 'x' },
    });
    expect(duplicate.statusCode).toBe(400);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/admin/proxy/mihomo/nodes/${node.id}`,
      payload: { name: 'My Trojan', type: 'trojan', server: 't.example', port: 443, password: 'p', sni: 't.example' },
    });
    expect(updated.statusCode).toBe(200);
    const saved = loadConfig().proxy?.mihomo?.manualNodes?.[0];
    expect(saved).toMatchObject({ name: 'My Trojan', type: 'trojan', port: 443 });
    // The old protocol's fields do not survive a type switch.
    expect(saved?.cipher).toBeUndefined();

    // A saved selection pointing at the row must be pruned with it, otherwise
    // every boot replays a name the running core cannot resolve.
    saveConfig({ proxy: { mihomo: { selectedNodes: { PROXY: 'My Trojan', OTHER: 'keep-me' } } } });

    const removed = await app.inject({ method: 'DELETE', url: `/api/admin/proxy/mihomo/nodes/${node.id}` });
    expect(removed.statusCode).toBe(200);
    expect(loadConfig().proxy?.mihomo?.manualNodes).toEqual([]);
    expect(loadConfig().proxy?.mihomo?.selectedNodes).toEqual({ OTHER: 'keep-me' });
  });

  test('a pasted YAML batch is stored canonically and is editable as YAML', async () => {
    const paste = [
      'proxies:',
      '  - name: "xiong"',
      '    type: vless',
      '    server: 144.225.124.184',
      '    port: 24443',
      '    uuid: a89e9f26-1a54-4aad-bcfe-164cc3a0212c',
      '    network: tcp',
      '    tls: true',
      '    flow: xtls-rprx-vision',
      '    servername: www.cloudflare.com',
      '    client-fingerprint: chrome',
      '    reality-opts:',
      '      public-key: hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
      '      short-id: 427f3316a646944b',
    ].join('\n');
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: { yaml: paste },
    });
    expect(created.statusCode).toBe(200);
    const nodes = created.json().nodes as { id: string; name: string; type: string; yaml: string }[];
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'xiong', type: 'vless' });
    expect(nodes[0].yaml).toContain('reality-opts');
    expect(loadConfig().proxy?.mihomo?.manualNodes?.[0]).toMatchObject({ name: 'xiong', type: 'vless' });

    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/admin/proxy/mihomo/nodes/${nodes[0].id}`,
      payload: { yaml: 'name: xiong-2\ntype: trojan\nserver: t.example\nport: 443\npassword: p' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().node).toMatchObject({ name: 'xiong-2', type: 'trojan' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: { yaml: 'name: [unclosed' },
    });
    expect(malformed.statusCode).toBe(400);

    const removed = await app.inject({ method: 'DELETE', url: `/api/admin/proxy/mihomo/nodes/${nodes[0].id}` });
    expect(removed.statusCode).toBe(200);
    expect(loadConfig().proxy?.mihomo?.manualNodes).toEqual([]);
  });

  test('a YAML-authored node is projected into form fields and form saves keep unmodeled keys', async () => {
    const paste = [
      'name: reality-node',
      'type: vless',
      'server: 203.0.113.9',
      'port: 24443',
      'uuid: a89e9f26-1a54-4aad-bcfe-164cc3a0212c',
      'network: tcp',
      'tls: true',
      'flow: xtls-rprx-vision',
      'servername: www.cloudflare.com',
      'client-fingerprint: chrome',
      'smux:',
      '  enabled: true',
      'reality-opts:',
      '  public-key: hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
      '  short-id: 427f3316a646944b',
    ].join('\n');
    const created = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/nodes', payload: { yaml: paste } });
    expect(created.statusCode).toBe(200);
    const id = (created.json().node as { id: string }).id;

    const listed = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/nodes' });
    expect(listed.statusCode).toBe(200);
    const row = (listed.json().nodes as { id: string; fields?: Record<string, unknown> }[]).find((item) => item.id === id);
    // The form is not empty for a pasted row: the mapping is projected back.
    expect(row?.fields).toMatchObject({
      uuid: 'a89e9f26-1a54-4aad-bcfe-164cc3a0212c',
      tls: true,
      sni: 'www.cloudflare.com',
      flow: 'xtls-rprx-vision',
      clientFingerprint: 'chrome',
      realityPublicKey: 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
      realityShortId: '427f3316a646944b',
    });

    const edited = await app.inject({
      method: 'PUT',
      url: `/api/admin/proxy/mihomo/nodes/${id}`,
      payload: {
        name: 'reality-node',
        type: 'vless',
        server: '203.0.113.9',
        port: 24443,
        uuid: 'a89e9f26-1a54-4aad-bcfe-164cc3a0212c',
        network: 'ws',
        wsPath: '/ws',
        tls: true,
        sni: 'cdn.example.com',
        flow: 'xtls-rprx-vision',
        realityPublicKey: 'hD5cxUiWuOJuhepcV521_w_UUsldvqYhd3QRJkuoOzQ',
        realityShortId: '427f3316a646944b',
      },
    });
    expect(edited.statusCode).toBe(200);
    const saved = loadConfig().proxy?.mihomo?.manualNodes?.[0];
    const mapping = parse(saved?.yaml ?? '') as Record<string, unknown>;
    expect(mapping['ws-opts']).toMatchObject({ path: '/ws' });
    expect(mapping.servername).toBe('cdn.example.com');
    // Cleared in the form → gone from the mapping; unmodeled keys survive.
    expect(mapping['client-fingerprint']).toBeUndefined();
    expect(mapping.smux).toEqual({ enabled: true });
    expect(mapping['reality-opts']).toMatchObject({ 'short-id': '427f3316a646944b' });
  });

  test('an unsupported YAML protocol edits identity only', async () => {
    const paste = 'name: tuic-node\ntype: tuic\nserver: 203.0.113.10\nport: 443\ntoken: keep-me\n';
    const created = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/nodes', payload: { yaml: paste } });
    expect(created.statusCode).toBe(200);
    const id = (created.json().node as { id: string }).id;
    const renamed = await app.inject({
      method: 'PUT',
      url: `/api/admin/proxy/mihomo/nodes/${id}`,
      payload: { name: 'tuic-renamed', server: '203.0.113.10', port: 8443 },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().node).toMatchObject({ name: 'tuic-renamed', type: 'tuic', port: 8443 });
    expect((renamed.json().node as { yaml: string }).yaml).toContain('token: keep-me');
  });

  test('install uses the injected downloader', async () => {
    const asset = mihomoAssetName(process.platform, process.arch, 'v1.2.3');
    expect(asset).not.toBeNull();
    const packed = asset!.gzip ? zlib.gzipSync(Buffer.from('bin')) : Buffer.from('nope');
    setMihomoDownloadFetchForTests((async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/releases/')) {
        return new Response(JSON.stringify({
          tag_name: 'v1.2.3',
          assets: [{ name: asset!.name, browser_download_url: 'https://example.test/mihomo.bin' }],
        }));
      }
      return new Response(packed);
    }) as typeof fetch);
    const res = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/install', payload: {} });
    if (!asset!.gzip && process.platform === 'win32') {
      // The zip fixture is only built in the binary suite. Skip the body check on Windows here.
      expect([200, 400, 500]).toContain(res.statusCode);
      return;
    }
    expect(res.statusCode).toBe(200);
    // Streaming install: the payload is NDJSON — `progress` ticks then one `result`.
    const events = res.payload.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const result = events.find((evt) => evt.type === 'result') as { ok?: boolean; version?: string } | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.version).toBe('v1.2.3');
  });

  test('outbound mode is saved and hot-applied to the running core', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/routing-mode', payload: { mode: 'turbo' } });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/routing-mode', payload: { mode: 'direct' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; routingMode: string; live: boolean };
    expect(body.routingMode).toBe('direct');
    // A probe answered /version, so the core counts as running: the PATCH must
    // have reached it, not just been written to config.yaml.
    expect(body.live).toBe(true);
    expect(liveMode).toBe('direct');
    expect(loadConfig().proxy?.mihomo?.routingMode).toBe('direct');

    // Restore so later tests see the default.
    await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/routing-mode', payload: { mode: 'rule' } });
    expect(liveMode).toBe('rule');
  });

  test('exposes the rule table the core actually loaded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/rules' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rules: { type: string; payload: string; proxy: string }[] };
    expect(body.rules).toEqual([
      { type: 'DomainSuffix', payload: 'corp.internal', proxy: 'DIRECT' },
      { type: 'Match', payload: '', proxy: 'PROXY' },
    ]);
  });

  test('rule import parses a pasted profile and saves nothing', async () => {
    const before = loadConfig().proxy?.mihomo?.rules ?? [];
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/rules/import',
      payload: {
        source: 'text',
        text: 'proxy-groups:\n  - { name: AUTO, type: select }\nrules:\n  - DOMAIN-SUFFIX,a.com,AUTO\n  - GEOIP,CN,DIRECT\n',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rules: unknown[]; skipped: unknown[]; mappedToProxy: number };
    expect(body.rules).toEqual([{ type: 'DOMAIN-SUFFIX', payload: 'a.com', target: 'PROXY', source: 'paste' }]);
    expect(body.skipped).toEqual([{ reason: 'GEOIP', count: 1 }]);
    expect(body.mappedToProxy).toBe(1);
    // The import is a DRAFT: an import must never move traffic on its own.
    expect(loadConfig().proxy?.mihomo?.rules ?? []).toEqual(before);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/rules/import',
      payload: { source: 'subscription', subscriptionId: 'nope' },
    });
    expect(unknown.statusCode).toBe(404);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/rules/import',
      payload: { source: 'text', text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });

  test('rule import reads the core provider cache instead of the network', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/subscriptions',
      // Unreachable on purpose: a network fetch would fail here.
      payload: { name: 'Cached', url: 'https://127.0.0.1:9/feed.yaml', enabled: true },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().subscription.id as string;

    const providers = path.join(mihomoWorkDir(), 'providers');
    await fs.mkdir(providers, { recursive: true });
    await fs.writeFile(
      path.join(providers, `${id}.yaml`),
      'proxy-groups:\n  - { name: AUTO, type: select }\nrules:\n  - DOMAIN-SUFFIX,cached.example,AUTO\n',
      'utf8',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/rules/import',
      payload: { source: 'subscription', subscriptionId: id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: string; rules: unknown[]; mappedToProxy: number };
    expect(body.source).toBe('cache');
    // The subscription name becomes the provenance label on every imported row.
    expect(body.rules).toEqual([{ type: 'DOMAIN-SUFFIX', payload: 'cached.example', target: 'PROXY', source: 'Cached' }]);
    expect(body.mappedToProxy).toBe(1);

    // Without a cache the DNS-unreachable host must surface as a 502, not a crash.
    await fs.rm(path.join(providers, `${id}.yaml`), { force: true });
    const failed = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/rules/import',
      payload: { source: 'subscription', subscriptionId: id },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe('import-failed');
  });

  test('custom rules are persisted as one ordered list', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/proxy/mihomo/rules',
      payload: {
        rules: [
          { type: 'DOMAIN-SUFFIX', payload: 'corp.internal', target: 'DIRECT' },
          { type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'PROXY' },
          // No geo database here: an unusable type must be dropped, never shipped.
          { type: 'GEOIP', payload: 'CN', target: 'PROXY' },
          { type: 'DOMAIN', payload: 'a,b', target: 'PROXY' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rules: { type: string; payload: string; target: string }[] };
    expect(body.rules).toEqual([
      { type: 'DOMAIN-SUFFIX', payload: 'corp.internal', target: 'DIRECT' },
      { type: 'IP-CIDR', payload: '10.0.0.0/8', target: 'PROXY' },
    ]);
    expect(loadConfig().proxy?.mihomo?.rules).toEqual(body.rules);

    const notArray = await app.inject({
      method: 'PUT',
      url: '/api/admin/proxy/mihomo/rules',
      payload: { rules: 'nope' },
    });
    expect(notArray.statusCode).toBe(400);

    // Restore the empty list so later tests see the shipped default.
    await app.inject({ method: 'PUT', url: '/api/admin/proxy/mihomo/rules', payload: { rules: [] } });
  });

  test('provider-backed nodes keep their type when /proxies omits them', async () => {
    // The real controller does exactly this: a group's `all` lists provider node
    // names, but the per-proxy snapshot only holds groups and built-ins.
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies?group=PROVIDERS' });
    const body = res.json() as any;
    expect(body.nodes.map((node: { name: string; type: string; source: { kind: string } }) => [node.name, node.type, node.source.kind]))
      .toEqual([['node-b', 'Trojan', 'subscription']]);
  });

  test('a manual node is attributed to the manual source', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: {
        name: 'manual-1', type: 'vless', server: 'm.example', port: 443,
        uuid: '11111111-2222-3333-4444-555555555555', tls: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const listed = (await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/proxies?group=MANUAL' })).json() as any;
    expect(listed.nodes).toHaveLength(1);
    expect(listed.nodes[0].source).toEqual({ kind: 'manual', id: created.json().node.id });
    expect(listed.nodes[0].manualId).toBe(created.json().node.id);
    await app.inject({ method: 'DELETE', url: `/api/admin/proxy/mihomo/nodes/${created.json().node.id}` });
  });

  test('the unsaved-node probe measures TCP reachability', async () => {
    const reachable = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes/test',
      payload: { server: '127.0.0.1', port },
    });
    expect(reachable.statusCode).toBe(200);
    expect(reachable.json()).toMatchObject({ status: 'ok', reachable: true });
    expect(typeof reachable.json().ms).toBe('number');

    // A YAML paste is probed from its own server/port.
    const fromYaml = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes/test',
      payload: { yaml: `name: probe\ntype: trojan\nserver: 127.0.0.1\nport: ${port}\npassword: p` },
    });
    expect(fromYaml.json()).toMatchObject({ status: 'ok', reachable: true });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes/test',
      payload: { server: '127.0.0.1', port: 0 },
    });
    expect(invalid.statusCode).toBe(400);
  });

  test('the delay-test URL can be overridden per request and is validated', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'node-a', url: 'https://probe.example/ping' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', delay: 11 });

    for (const url of ['ftp://probe.example/ping', 'https://user:pw@probe.example/ping']) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/proxies/test',
        payload: { name: 'node-a', url },
      });
      expect(bad.statusCode).toBe(400);
    }
  });

  test('the URL connectivity check runs through the selected node', async () => {
    saveConfig({ proxy: { mihomo: { selectedGroup: 'PROXY' } } });
    // An earlier test may have moved the selector; pin the node this check
    // should report.
    await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/proxies/select', payload: { name: 'node-a' } });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/test-url',
      payload: { url: 'https://probe.example/ping' },
    });
    expect(ok.json()).toMatchObject({ status: 'ok', reachable: true, node: 'node-a', url: 'https://probe.example/ping' });

    // A node that times out reports the stable `timeout` code (the UI localizes
    // it) instead of the controller's raw 504 status line.
    await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/proxies/select', payload: { name: 'node-timeout' } });
    const timedOut = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/test-url',
      payload: { url: 'https://probe.example/ping' },
    });
    expect(timedOut.json()).toMatchObject({ status: 'ok', reachable: false, node: 'node-timeout', error: 'timeout' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/test-url',
      payload: { url: 'file:///etc/passwd' },
    });
    expect(bad.statusCode).toBe(400);
  });
  test('the catalog exposes protocols, fields and enum whitelists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/nodes/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      protocols: string[]; fields: Record<string, string[]>; enums: Record<string, string[]>;
    };
    expect(body.protocols).toContain('vless');
    expect(body.fields.vless).toContain('realityPublicKey');
    expect(body.enums.ssCiphers).toContain('aes-256-gcm');
    expect(body.enums.networks).toEqual(['tcp', 'ws', 'grpc', 'h2']);
  });

  test('an invalid typed field answers with the field name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/nodes',
      payload: {
        name: 'bad-uuid', type: 'vless', server: 'a.example', port: 443, uuid: 'nope',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid-node-field', field: 'uuid' });
});
});

