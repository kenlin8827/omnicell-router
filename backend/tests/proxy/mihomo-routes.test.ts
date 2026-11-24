import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { loadConfig, saveConfig } from '../../src/config/index.js';
import { MIHOMO_CN_DIRECT_RULES, MIHOMO_LAN_DIRECT_RULES } from '../../src/config/defaults.js';
import { registerMihomoRoutes, setUrlProbeOsProxyReaderForTests } from '../../src/routes/mihomo.js';
import { setMihomoDownloadFetchForTests } from '../../src/proxy/mihomo-binary.js';
import { appendMihomoCoreLog, clearMihomoCoreLogs } from '../../src/proxy/mihomo-logs.js';
import { mihomoWorkDir, setMihomoSidecarDepsForTests } from '../../src/proxy/mihomo-sidecar.js';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultMihomoBinaryPath, mihomoAssetName } from '../../src/proxy/mihomo-binary.js';

describe('mihomo admin routes', () => {
  const SECRET = 'route-secret-value';
  let controller: http.Server;
  let port = 0;
  let selected = 'node-a';
  let liveMode = 'rule';
  const app = Fastify();

  beforeAll(async () => {
    // The machine leg reads the OS system proxy; a real CI/dev box's own
    // settings are not the fixture. Tests that exercise the proxied path
    // override this reader for their duration.
    setUrlProbeOsProxyReaderForTests(async () => undefined);
    setMihomoSidecarDepsForTests({
      persistSecret: () => {},
      binaryResolver: () => ({ path: null, source: null }),
      spawnImpl: () => ({ pid: 1, on() {}, unref() {} }),
      // A recorded pid in a failing-start path must never reach the real taskkill.
      killTreeImpl: () => true,
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
        if (url.startsWith('/group/DEAD/delay')) {
          // Every member failed: mihomo renders the whole batch as 504.
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'get delay: all proxies timeout' }));
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

  test('a group batch test reports per-member delays or one stable timeout code', async () => {
    const batch = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'PROXY', group: true },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ status: 'ok', group: 'PROXY', delays: { 'node-a': 11, DIRECT: 1 } });

    // mihomo answers "no member answered" with 504; the console needs the
    // stable timeout code, not the raw controller string.
    const dead = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy/mihomo/proxies/test',
      payload: { name: 'DEAD', group: true },
    });
    expect(dead.statusCode).toBe(502);
    expect(dead.json()).toMatchObject({ status: 'error', code: 'timeout' });
  });

  test('the captured core log ring is readable and clearable', async () => {
    clearMihomoCoreLogs();
    appendMihomoCoreLog('stderr', 'level=error msg="config parse failed"');
    appendMihomoCoreLog('gateway', 'core process started (pid 1)');

    const listed = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/logs' });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { status: string; lines: Array<{ stream: string; text: string }> };
    expect(body.status).toBe('ok');
    expect(body.lines.map((line) => line.text)).toEqual([
      'level=error msg="config parse failed"',
      'core process started (pid 1)',
    ]);
    expect(body.lines[0].stream).toBe('stderr');

    const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/proxy/mihomo/logs' });
    expect(cleared.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/logs' });
    expect((after.json() as { lines: unknown[] }).lines).toEqual([]);
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
      payload: { name: 'Alpha', url: 'https://sub.example/feed?token=hide-me', interval: 600, proxy: 'HK-01' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().subscription.id as string;
    expect(created.json().subscription.url).toContain('token=hide-me');
    expect(created.json().subscription.proxy).toBe('HK-01');
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

  // The regression this locks: a cancel used to be invisible to the gateway (no
  // disconnect event reaches a hijacked reply on this runtime) and reasonless
  // when it did arrive, so the engine kept downloading to nobody behind the next
  // click, and the operator saw a failure toast with engine text instead of a
  // paused transfer. Stopping is now an explicit, per-leg call, and the staged
  // bytes survive it (ADR-0022).
  test('install: cancelling the leg stops the engine with a reason, reports an outcome, keeps the partial file', async () => {
    const asset = mihomoAssetName(process.platform, process.arch, 'v1.2.3');
    expect(asset).not.toBeNull();
    let transferSignal: AbortSignal | undefined;
    let pushed = 0;
    let abandoned = false;
    const chunk = new Uint8Array(8 * 1024);
    setMihomoDownloadFetchForTests((async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/releases/')) {
        return new Response(JSON.stringify({
          tag_name: 'v1.2.3',
          assets: [{ name: asset!.name, browser_download_url: 'https://example.test/mihomo.bin' }],
        }));
      }
      transferSignal = init?.signal ?? undefined;
      // Trickles forever with real validators: the transfer is still moving when
      // the cancel lands, exactly as it would be if the operator walked away.
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              if (abandoned || pushed++ > 2000) {
                try { stream.close(); } catch { /* the engine cancelled the body */ }
                resolve();
                return;
              }
              try {
                stream.enqueue(chunk);
              } catch {
                abandoned = true;
              }
              resolve();
            }, 1);
          });
        },
      });
      return new Response(body, {
        headers: {
          etag: '"mihomo-part-1"',
          'last-modified': new Date(Date.UTC(2026, 0, 1)).toUTCString(),
        },
      });
    }) as typeof fetch);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const livePort = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${livePort}/api/admin/proxy/mihomo`;
    const dec = new TextDecoder();
    /** NDJSON frames off one live stream, until the predicate matches. Spelled
     *  with a newline constant instead of an escape so the fixture stays
     *  copy-safe across line endings. */
    async function readFrames(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      done: (frame: Record<string, unknown>) => boolean,
      limit = 400,
    ): Promise<Record<string, unknown> | null> {
      const NL = String.fromCharCode(10);
      let buf = '';
      for (let i = 0; i < limit; i++) {
        const { value, done: ended } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        const parts = buf.split(NL);
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const text = part.trim();
          if (!text) continue;
          const frame = JSON.parse(text) as Record<string, unknown>;
          if (done(frame)) return frame;
        }
        if (ended) return null;
      }
      return null;
    }
    const cancel = async (leg: string): Promise<boolean> => {
      const r = await fetch(`${base}/transfers/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leg }),
      });
      return ((await r.json()) as { cancelled: boolean }).cancelled;
    };

    // The client keeps the stream OPEN and reads slowly: nothing about this
    // socket tells the gateway the operator is done, so the cancel call is the
    // only signal that can work here.
    const res = await fetch(`${base}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(await readFrames(reader, (f) => f.type === 'progress')).toBeTruthy();

    // One leg only: the geo key matches nothing while a core install runs.
    expect(await cancel('geo:node')).toBe(false);
    expect(transferSignal?.aborted).toBe(false);

    expect(await cancel('core')).toBe(true);
    const result = await readFrames(reader, (f) => f.type === 'result');
    // The engine saw OUR reason, and the route reported a cancelled download
    // rather than an install failure.
    expect(String(transferSignal?.reason)).toContain('cancelled by the console');
    expect(result?.code).toBe('download-aborted');
    // And the leg is released once the handler finishes, so a later cancel (the
    // next click's cleanup, an unmount) has nothing left to stop.
    let stillLive = await cancel('core');
    for (let i = 0; i < 100 && stillLive; i++) {
      await Bun.sleep(10);
      stillLive = await cancel('core');
    }
    expect(stillLive).toBe(false);

    // A cancel is a PAUSE, not a discard. The staged part and the sidecar that
    // makes those bytes resumable both survive it, and they live in the bin
    // directory next to where the executable would land (a core asset is never
    // staged in the geo work dir).
    const binDir = path.dirname(defaultMihomoBinaryPath());
    const staged = (await fs.readdir(binDir)).filter((f) => f.endsWith('.part') || f.endsWith('.part.json'));
    expect(staged.length).toBe(2);
    const partName = staged.find((f) => f.endsWith('.part'));
    const metaName = staged.find((f) => f.endsWith('.part.json'));
    expect(partName).toBeDefined();
    expect(metaName).toBeDefined();
    expect((await fs.stat(path.join(binDir, partName as string))).size).toBeGreaterThan(0);
    const meta = JSON.parse(await fs.readFile(path.join(binDir, metaName as string), 'utf8')) as {
      url?: string; etag?: string; lastModified?: string;
    };
    // The sidecar is what turns held bytes into a continuation: the same url, and
    // a validator the next attempt can present with its Range request.
    expect(meta.url).toBe('https://example.test/mihomo.bin');
    expect(meta.etag ?? meta.lastModified).toBeTruthy();
    for (const f of staged) await fs.rm(path.join(binDir, f), { force: true });
    setMihomoDownloadFetchForTests(undefined);
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
    expect(body.rules).toEqual([
      { type: 'DOMAIN-SUFFIX', payload: 'a.com', target: 'PROXY', source: 'paste' },
      { type: 'GEOIP', payload: 'CN', target: 'DIRECT', source: 'paste' },
    ]);
    expect(body.skipped).toEqual([]);
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
          // A separator inside the payload would splice extra fields into the
          // generated document, so it is dropped, never shipped.
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

  test('the rules presets are served from the backend declaration', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/rules/presets' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; defaults: { target: string; source?: string }[]; cn: unknown[] };
    expect(body.status).toBe('ok');
    // One declaration shared with the fresh-config seed — not a console copy.
    expect(body.defaults.length).toBe(MIHOMO_LAN_DIRECT_RULES.length);
    expect(body.defaults.every((rule) => rule.target === 'DIRECT' && rule.source === 'default')).toBe(true);
    expect(body.cn).toEqual(MIHOMO_CN_DIRECT_RULES);
  });

  test('geo status names the two database files', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/mihomo/geo' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; present: boolean; files: { key: string; file: string; exists: boolean }[] };
    expect(body.status).toBe('ok');
    expect(body.present).toBe(false);
    expect(body.files.map((file) => [file.key, file.file, file.exists])).toEqual([
      ['geoip', 'geoip.metadb', false],
      ['geosite', 'GeoSite.dat', false],
    ]);
  });

  test('the geo download leg is validated and the node leg wants a live core', async () => {
    const parseEvents = (raw: string) => raw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    const bad = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/geo', payload: { leg: 'socks' } });
    expect(bad.statusCode).toBe(400);

    const dir = mihomoWorkDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'geoip.metadb'), 'stub');
    await fs.writeFile(path.join(dir, 'GeoSite.dat'), 'stub');
    try {
      // Installed files mean nothing is fetched: the node leg answers ok
      // without a core and without touching the network.
      const ok = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/geo', payload: { leg: 'node' } });
      expect(parseEvents(ok.body).at(-1)).toMatchObject({ type: 'result', ok: true, present: true });

      // Files gone + no live controller: the same call refuses up front
      // instead of dialing a dead mixed port (or GitHub).
      await fs.rm(path.join(dir, 'geoip.metadb'), { force: true });
      await fs.rm(path.join(dir, 'GeoSite.dat'), { force: true });
      const before = loadConfig();
      saveConfig({ proxy: { mihomo: { ...before.proxy?.mihomo, controllerSecret: '' } } });
      try {
        const refused = await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/geo', payload: { leg: 'node' } });
        expect(parseEvents(refused.body).at(-1)).toMatchObject({ type: 'result', ok: false, code: 'not-running', present: false });
      } finally {
        saveConfig({ proxy: { ...before.proxy } });
      }
    } finally {
      await fs.rm(path.join(dir, 'geoip.metadb'), { force: true });
      await fs.rm(path.join(dir, 'GeoSite.dat'), { force: true });
    }
  });

  test('a geo rule list is refused before it reaches the file or the core', async () => {
    const before = loadConfig().proxy?.mihomo?.rules ?? [];
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/admin/proxy/mihomo/rules',
      payload: { rules: [{ type: 'GEOIP', payload: 'CN', target: 'DIRECT' }] },
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { code?: string }).code).toBe('geo-missing');
    // Nothing was persisted: the file and the process never disagree.
    expect(loadConfig().proxy?.mihomo?.rules ?? []).toEqual(before);

    // With both databases present the same list saves and round-trips.
    const dir = mihomoWorkDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'geoip.metadb'), 'stub');
    await fs.writeFile(path.join(dir, 'GeoSite.dat'), 'stub');
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/admin/proxy/mihomo/rules',
        payload: { rules: [{ type: 'GEOIP', payload: 'CN', target: 'DIRECT' }] },
      });
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as { rules: unknown[] }).rules).toEqual([{ type: 'GEOIP', payload: 'CN', target: 'DIRECT' }]);
    } finally {
      await fs.rm(path.join(dir, 'geoip.metadb'), { force: true });
      await fs.rm(path.join(dir, 'GeoSite.dat'), { force: true });
      await app.inject({ method: 'PUT', url: '/api/admin/proxy/mihomo/rules', payload: { rules: [] } });
    }
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

  test('the URL check has a machine leg that bypasses the controller', async () => {
    const target = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', () => done()));
    const port = (target.address() as AddressInfo).port;
    try {
      const machine = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `http://127.0.0.1:${port}/generate_204`, mode: 'machine' },
      });
      // The machine leg is a raw socket from the gateway process: no node
      // attribution, no controller round trip — its `ms` is this machine's own
      // egress, and with no OS proxy configured that egress is direct.
      expect(machine.json()).toMatchObject({
        status: 'ok', mode: 'machine', via: 'direct', reachable: true, url: `http://127.0.0.1:${port}/generate_204`,
      });
      expect(typeof machine.json().ms).toBe('number');
      expect(machine.json().node).toBeUndefined();
      expect(machine.json().proxy).toBeUndefined();

      // The tunnel leg keeps its shape and names its mode. (An earlier test
      // left the selector on the timeout node; pin the healthy one.)
      await app.inject({ method: 'POST', url: '/api/admin/proxy/mihomo/proxies/select', payload: { name: 'node-a' } });
      const tunnel = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: 'https://probe.example/ping' },
      });
      expect(tunnel.json()).toMatchObject({ status: 'ok', mode: 'tunnel', reachable: true, node: 'node-a' });

      // An unknown mode is a 400 — never a silent fallback to the tunnel leg.
      const badMode = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { mode: 'bogus' },
      });
      expect(badMode.statusCode).toBe(400);
    } finally {
      await new Promise<void>((done) => target.close(() => done()));
    }
  });

  test('the machine leg follows the OS system proxy, and its bypass list', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;
    if (!lan) return; // No non-loopback fixture address on this box.
    const target = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((done) => target.listen(0, '0.0.0.0', () => done()));
    const targetPort = (target.address() as AddressInfo).port;
    // A stand-in OS proxy: it answers the absolute-form GET itself and also
    // records that it was asked for a CONNECT tunnel (https target).
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(`GET ${req.url}`);
      res.writeHead(204);
      res.end();
    });
    proxy.on('connect', (_req, socket) => {
      seen.push('CONNECT');
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', () => done()));
    const proxyPort = (proxy.address() as AddressInfo).port;
    try {
      // (a) no bypass entry ⇒ the OS proxy carries the request.
      setUrlProbeOsProxyReaderForTests(async () => ({ server: `127.0.0.1:${proxyPort}`, bypass: [] }));
      const viaProxy = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `http://${lan}:${targetPort}/generate_204`, mode: 'machine' },
      });
      expect(viaProxy.json()).toMatchObject({
        status: 'ok', mode: 'machine', via: 'system-proxy', proxy: `127.0.0.1:${proxyPort}`, reachable: true,
      });
      expect(seen).toContain(`GET http://${lan}:${targetPort}/generate_204`);

      // (b) a bypass entry for the host ⇒ direct, never touching the proxy.
      const before = seen.length;
      setUrlProbeOsProxyReaderForTests(async () => ({ server: `127.0.0.1:${proxyPort}`, bypass: [lan] }));
      const bypassed = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `http://${lan}:${targetPort}/generate_204`, mode: 'machine' },
      });
      expect(bypassed.json()).toMatchObject({ status: 'ok', mode: 'machine', via: 'direct', reachable: true });
      expect(seen.length).toBe(before);

      // (c) an https target must open a CONNECT tunnel; a proxy that refuses
      // is the answer, not a transport error.
      setUrlProbeOsProxyReaderForTests(async () => ({ server: `127.0.0.1:${proxyPort}`, bypass: [] }));
      const refused = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `https://${lan}:${targetPort}/`, mode: 'machine' },
      });
      expect(refused.json()).toMatchObject({
        status: 'ok', mode: 'machine', via: 'system-proxy', reachable: false, error: 'proxy-502',
      });
      expect(seen).toContain('CONNECT');
    } finally {
      setUrlProbeOsProxyReaderForTests(async () => undefined);
      await new Promise<void>((done) => proxy.close(() => done()));
      await new Promise<void>((done) => target.close(() => done()));
    }
  });

  test('the machine leg ignores HTTP_PROXY/HTTPS_PROXY from the environment', async () => {
    // On this runtime `fetch` AND node:http/node:https honor the env proxies
    // (a dead one fails them all), so the leg follows only the OS setting —
    // and here there is none. The target must be a NON-loopback address: the
    // runtime auto-bypasses env proxies for loopback, so a 127.0.0.1 target
    // would pass through either implementation and prove nothing.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;
    const target = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((done) => target.listen(0, '0.0.0.0', () => done()));
    const port = (target.address() as AddressInfo).port;
    const savedEnv = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY };
    try {
      process.env.HTTP_PROXY = 'http://127.0.0.1:1';
      process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
      if (lan) {
        // An env-aware client stack would report ECONNREFUSED (the dead proxy).
        const machine = await app.inject({
          method: 'POST',
          url: '/api/admin/proxy/mihomo/test-url',
          payload: { url: `http://${lan}:${port}/generate_204`, mode: 'machine' },
        });
        expect(machine.json()).toMatchObject({ status: 'ok', mode: 'machine', via: 'direct', reachable: true });
        expect(typeof machine.json().ms).toBe('number');
      }
    } finally {
      if (savedEnv.http === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = savedEnv.http;
      if (savedEnv.https === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = savedEnv.https;
      await new Promise<void>((done) => target.close(() => done()));
    }
  });
  test('the URL check answers the machine leg with no core configured', async () => {
    const target = http.createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((done) => target.listen(0, '127.0.0.1', () => done()));
    const port = (target.address() as AddressInfo).port;
    const saved = loadConfig().proxy;
    try {
      // No controllerSecret/port ⇒ no client. The machine leg must still
      // answer: the whole point is diagnosing a suspect tunnel.
      saveConfig({ proxy: { mihomo: { controllerSecret: '', controllerPort: undefined } } });
      const machine = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `http://127.0.0.1:${port}/`, mode: 'machine' },
      });
      expect(machine.json()).toMatchObject({ status: 'ok', mode: 'machine', via: 'direct', reachable: true });

      const tunnel = await app.inject({
        method: 'POST',
        url: '/api/admin/proxy/mihomo/test-url',
        payload: { url: `http://127.0.0.1:${port}/` },
      });
      expect(tunnel.statusCode).toBe(409);
    } finally {
      saveConfig({ proxy: saved });
      await new Promise<void>((done) => target.close(() => done()));
    }
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

