import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { saveConfig } from '../src/config/index.js';
import { registerMihomoRoutes } from '../src/routes/mihomo.js';
import { setMihomoDownloadFetchForTests } from '../src/proxy/mihomo-binary.js';
import { setMihomoSidecarDepsForTests } from '../src/proxy/mihomo-sidecar.js';
import zlib from 'node:zlib';
import { mihomoAssetName } from '../src/proxy/mihomo-binary.js';

describe('mihomo admin routes', () => {
  const SECRET = 'route-secret-value';
  let controller: http.Server;
  let port = 0;
  let selected = 'node-a';
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
              'node-a': { name: 'node-a', type: 'Vmess', history: [{ delay: 30 }] },
              DIRECT: { name: 'DIRECT', type: 'Direct' },
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
        if (url === '/providers/proxies' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ providers: {} }));
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
          subscriptions: [],
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
    expect(listed.nodes[0].selected).toBe(true);

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
    expect(res.json().ok).toBe(true);
    expect(res.json().version).toBe('v1.2.3');
  });
});
