/**
 * Node's fetch ignores a `proxy` option. `nodeProxiedFetch` is the path
 * `proxiedFetch` uses when the process is not Bun: absolute-form HTTP, and
 * CONNECT + TLS for HTTPS. These tests call it directly so they exercise
 * that path even when the suite itself runs on Bun.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { nodeProxiedFetch } from '../src/utils/proxy-node.js';

function selfSigned(): { cert: string; key: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'example.test' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

describe('nodeProxiedFetch', () => {
  const EXPECTED = 'Basic ' + Buffer.from('alice:secret').toString('base64');
  let proxy: http.Server;
  let origin: https.Server;
  let proxyPort = 0;
  let originPort = 0;
  const seen: string[] = [];

  beforeAll(async () => {
    const tls = selfSigned();
    origin = https.createServer(tls, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secure: true, path: req.url }));
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()));
    originPort = (origin.address() as AddressInfo).port;

    proxy = http.createServer((req, res) => {
      seen.push(req.url || '');
      const auth = req.headers['proxy-authorization'];
      if (auth !== EXPECTED) {
        res.writeHead(407);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxied: true, url: req.url }));
    });
    proxy.on('connect', (req, socket, head) => {
      seen.push(`CONNECT ${req.url}`);
      const auth = req.headers['proxy-authorization'];
      if (auth !== EXPECTED) {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        socket.end();
        return;
      }
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => proxy.close((err) => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => origin.close((err) => err ? reject(err) : resolve()));
  });

  const proxyUrl = () => `http://alice:secret@127.0.0.1:${proxyPort}`;

  test('HTTP absolute-form sends Proxy-Authorization and returns the body', async () => {
    const res = await nodeProxiedFetch('http://example.test/v1/models', { method: 'GET' }, proxyUrl());
    expect(res.status).toBe(200);
    const body = await res.json() as { proxied: boolean; url: string };
    expect(body.proxied).toBe(true);
    expect(body.url).toBe('http://example.test/v1/models');
  });

  test('HTTPS goes through CONNECT and reads the tunneled response', async () => {
    const res = await nodeProxiedFetch(
      'https://example.test/hello',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"n":1}' },
      proxyUrl(),
      { rejectUnauthorized: false },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { secure: boolean; path: string };
    expect(body.secure).toBe(true);
    expect(body.path).toBe('/hello');
    expect(seen.some((line) => line.startsWith('CONNECT example.test:443'))).toBe(true);
  });

  test('a loopback target is not sent to the proxy', async () => {
    const before = seen.length;
    await expect(nodeProxiedFetch('http://127.0.0.1:1/', {}, proxyUrl())).rejects.toThrow();
    expect(seen.length).toBe(before);
  });
});
