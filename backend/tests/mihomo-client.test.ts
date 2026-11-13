import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MihomoClient, MihomoControllerError } from '../src/proxy/mihomo-client.js';

describe('MihomoClient', () => {
  const SECRET = 'unit-test-secret';
  let server: http.Server;
  let basePort = 0;
  const seen: Array<{ method: string; url: string; auth: string | undefined; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const auth = req.headers.authorization;
        seen.push({ method: req.method || '', url: req.url || '', auth, body: Buffer.concat(chunks).toString('utf8') });
        if (auth !== `Bearer ${SECRET}`) {
          res.writeHead(401);
          res.end('no');
          return;
        }
        if (req.url === '/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ meta: true, version: 'v1.19.15' }));
          return;
        }
        if (req.url === '/proxies' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            proxies: {
              PROXY: { name: 'PROXY', type: 'Selector', now: 'node-a', all: ['node-a', 'DIRECT'] },
              'node-a': { name: 'node-a', type: 'Shadowsocks', history: [{ delay: 42 }] },
              DIRECT: { name: 'DIRECT', type: 'Direct' },
            },
          }));
          return;
        }
        if (req.method === 'PUT' && req.url === '/proxies/PROXY') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.url?.startsWith('/proxies/node-a/delay')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ delay: 17 }));
          return;
        }
        if (req.url?.startsWith('/group/PROXY/delay')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 'node-a': 17, DIRECT: 0 }));
          return;
        }
        if (req.url === '/providers/proxies' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            providers: { alpha: { name: 'alpha', vehicleType: 'HTTP', updatedAt: '2026-01-01T00:00:00Z', proxies: [{}, {}] } },
          }));
          return;
        }
        if (req.method === 'PUT' && req.url === '/providers/proxies/alpha') {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    basePort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  test('sends the bearer token and reads proxies, delay, providers', async () => {
    const client = new MihomoClient({ port: basePort, secret: SECRET });
    expect(await client.version()).toBe('v1.19.15');
    const snap = await client.proxies();
    expect(snap.proxies.PROXY.now).toBe('node-a');
    expect(snap.proxies['node-a'].delay).toBe(42);
    await client.select('PROXY', 'node-a');
    expect(await client.delay('node-a')).toBe(17);
    expect(await client.groupDelay('PROXY')).toEqual({ 'node-a': 17, DIRECT: 0 });
    const providers = await client.providers();
    expect(providers[0]).toMatchObject({ name: 'alpha', nodeCount: 2 });
    await client.refreshProvider('alpha');
    expect(seen.every((call) => call.auth === `Bearer ${SECRET}`)).toBe(true);
    const select = seen.find((call) => call.url === '/proxies/PROXY');
    expect(select?.body).toBe(JSON.stringify({ name: 'node-a' }));
  });

  test('a wrong secret is an unauthorized error and the message does not contain it', async () => {
    const client = new MihomoClient({ port: basePort, secret: 'wrong-secret-value' });
    try {
      await client.version();
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(MihomoControllerError);
      const failure = err as MihomoControllerError;
      expect(failure.code).toBe('unauthorized');
      expect(failure.message).not.toContain('wrong-secret-value');
    }
  });
});
