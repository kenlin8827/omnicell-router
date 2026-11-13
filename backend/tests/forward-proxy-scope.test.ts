import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { resolveHost } from '../src/forward-proxy/rules.js';
import {
  clearProxyAccessLog,
  listProxyAccessEvents,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * Interception scope and the inbound socket cap (`maxConnections`) — ADR-0008 §3
 * as revised by ADR-0018.
 *
 * Whether a host is intercepted is one half of the rule table and lives in ONE
 * place (`resolveHost`): first match wins, `tunnel` defaults to false (intercept
 * — the historical posture), and the catch-all is what expresses the old
 * allow-list posture (a catch-all carrying `ingress: 'passthrough'`). The e2e
 * half asserts the consequence that matters: a host whose rule says
 * `passthrough` is never intercepted, so the interceptor never runs for it.
 */

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-scope-'));
}

/** Send CONNECT through the proxy; resolve once the 200 is received. */
function connectViaProxy(proxyPort: number, targetHost: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${port} HTTP/1.1\r\nHost: ${targetHost}:${port}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        sock.removeListener('data', onData);
        resolve(sock);
      }
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

/** TLS handshake over an established CONNECT socket (validates against ca). */
function tlsOver(socket: net.Socket, servername: string, ca: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, ca, rejectUnauthorized: true }, () => resolve(t));
    t.on('error', reject);
  });
}

function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('forward-proxy: interception scope (the tunnel half of the rule table)', () => {
  it('the catch-all expresses the posture; deny wins by position; globs apply', () => {
    // No table / no rows = blind tunnel (claims posture, ADR-0018 Revision 4);
    // only the audit posture decrypts an unclaimed host with no table.
    assert.equal(resolveHost('api.example.com', []).tunnel, true);
    assert.equal(resolveHost('api.example.com', undefined).tunnel, true);
    assert.equal(resolveHost('api.example.com', [], { intercept: 'all' }).tunnel, false);

    // Allow-list posture: the catch-all tunnels, named hosts are intercepted.
    const allowlist = [
      { match: 'api.cursor.sh', ingress: 'intercept', egress: 'direct' as const },
      { match: '*.openai.com', ingress: 'intercept', egress: 'direct' as const },
      { match: '*', ingress: 'passthrough', egress: 'direct' as const },
    ];
    assert.equal(resolveHost('api.cursor.sh', allowlist).tunnel, false);
    assert.equal(resolveHost('chat.openai.com', allowlist).tunnel, false, 'glob matches');
    assert.equal(resolveHost('other.test', allowlist).tunnel, true);

    // Deny wins when it is written FIRST — position, not a special case.
    const denyFirst = [{ match: 'api.cursor.sh', ingress: 'passthrough', egress: 'direct' as const }, ...allowlist];
    assert.deepEqual(resolveHost('api.cursor.sh', denyFirst), {
      action: 'direct',
      tunnel: true,
      reason: 'rule',
      ruleIndex: 0,
      match: 'api.cursor.sh',
    });

    // Loopback is always tunneled, allow-list or not.
    assert.equal(resolveHost('127.0.0.1', allowlist).tunnel, true);
    assert.equal(resolveHost('localhost', []).tunnel, true);
  });

  it('only allow-listed hosts reach the interceptor; the rest are blind-tunneled', async () => {
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      intercept: async (_req, res) => {
        intercepted += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      },
      rules: [
        { match: 'allow.test', ingress: 'intercept', egress: 'direct' },
        { match: '*', ingress: 'passthrough', egress: 'direct' },
      ],
    });

    try {
      // Allow-listed → decrypted, the interceptor owns the request.
      const allowed = await connectViaProxy(handle.port, 'allow.test', 443);
      const tlsSock = await tlsOver(allowed, 'allow.test', handle.caCertPem);
      const body = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no answer from the interceptor')), 5000);
        let buf = '';
        tlsSock.on('data', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes('{"ok":true}')) {
            clearTimeout(timer);
            resolve(buf);
          }
        });
        tlsSock.write('POST /v1/chat/completions HTTP/1.1\r\nHost: allow.test\r\nContent-Length: 2\r\n\r\n{}');
      });
      assert.match(body, /200 OK/);
      assert.equal(intercepted, 1);

      // Not allow-listed → blind tunnel: the CONNECT succeeds (bytes are still
      // proxied) but nothing is decrypted, so the interceptor never runs.
      const blocked = await connectViaProxy(handle.port, 'blocked.test', 443);
      blocked.on('error', () => {});
      await new Promise<void>((resolve) => {
        blocked.on('close', () => resolve());
        setTimeout(resolve, 2000);
      });
      assert.equal(intercepted, 1, 'a non-allow-listed host must never be decrypted');

      const notes = listProxyAccessEvents()
        .filter((e) => e.kind === 'connect')
        .map((e) => e.note || '');
      assert.ok(notes.some((n) => n.includes('connect (mitm)')), `notes: ${JSON.stringify(notes)}`);
      assert.ok(
        notes.some((n) => n.includes('connect (blind tunnel)')),
        `the ledger must record the tunnel: ${JSON.stringify(notes)}`
      );

      tlsSock.destroy();
      allowed.destroy();
      blocked.destroy();
    } finally {
      await handle.close();
    }
  });
});

describe('forward-proxy: inbound socket cap (maxConnections)', () => {
  it('refuses exchanges past the cap and releases the slot on close', async () => {
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      // The cap is admission, not interception: keep the sockets on the MITM
      // leg so a CONNECT stays open without an upstream to dial (a blind tunnel
      // would dial `h0.test` and drop the admitted socket on DNS failure —
      // ADR-0018 Revision 4 changed which leg an unclaimed host takes).
      interceptPosture: 'all',
      intercept: async () => false,
      maxConnections: 2,
    });

    const open: net.Socket[] = [];
    try {
      // Two admitted tunnels fill the cap (admission happens on CONNECT, the
      // point where the proxy starts spending fds).
      for (let i = 0; i < 2; i += 1) {
        open.push(await connectViaProxy(handle.port, `h${i}.test`, 443));
      }
      await waitFor(() => handle.activeConnections() === 2);

      // The third CONNECT is refused: no 200, the socket is closed.
      const refused = net.connect(handle.port, '127.0.0.1');
      refused.on('error', () => {});
      let saw200 = false;
      refused.on('data', (d: Buffer) => {
        if (d.toString('latin1').includes('200 Connection Established')) saw200 = true;
      });
      await once(refused, 'connect');
      refused.write('CONNECT third.test:443 HTTP/1.1\r\nHost: third.test:443\r\n\r\n');
      await new Promise<void>((resolve) => {
        refused.on('close', () => resolve());
        setTimeout(resolve, 3000);
      });
      assert.equal(saw200, false, 'a refused CONNECT must never see 200 Connection Established');
      assert.equal(handle.activeConnections(), 2, 'the cap holds — the extra exchange was never admitted');
      refused.destroy();

      // Closing an admitted socket frees its slot.
      open[0].destroy();
      await waitFor(() => handle.activeConnections() === 1);
    } finally {
      for (const s of open) s.destroy();
      await handle.close();
    }
  });
});
