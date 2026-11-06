import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ensureCa, CertMinter } from '../src/forward-proxy/ca.js';
import { resolveUpstreamTls, setUpstreamTlsReader } from '../src/forward-proxy/upstream-tls.js';
import {
  clearProxyAccessLog,
  listProxyAccessEvents,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * Upstream TLS trust for the origin legs (ADR-0019).
 *
 * The proxy validates the REAL target certificate, so an origin signed by a
 * private CA is unreachable until that CA is named. Three behaviours are pinned:
 *   - default (system trust) → 502 that NAMES the trust failure and its code,
 *     instead of the old opaque "upstream connection failed";
 *   - `upstreamTls.caFile` → the origin is reachable (appended, not replacing);
 *   - `upstreamTls.insecure` → verification off (the escape hatch).
 *
 * The origin is reachable only through the `lookup` test seam; `caFile` and
 * `insecure` come from the REAL live reader, because that is the surface under
 * test.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const toLoopback = ((_h: string, _o: unknown, cb: (e: null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as tls.ConnectionOptions['lookup'];

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

/** A private-CA origin: its leaf is signed by the test CA, which the OS does not trust. */
function privateCaOrigin(ca: ReturnType<typeof ensureCa>) {
  const leaf = new CertMinter(ca).get('origin.trust.test');
  const srv = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) => {
    let buf = '';
    s.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      s.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\ntrusted');
    });
    s.on('error', () => {});
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        close: () =>
          new Promise((done) => {
            try {
              srv.close(() => done());
            } catch {
              done();
            }
            setTimeout(done, 500);
          }),
      })
    );
  });
}

/** Drive one plain-HTTP-over-CONNECT exchange and return the proxy's answer. */
async function exchange(handlePort: number, originPort: number): Promise<string> {
  const sock = await connectViaProxy(handlePort, 'origin.trust.test', originPort);
  const client = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: 'origin.trust.test', rejectUnauthorized: false }, () => resolve(t));
    t.on('error', reject);
  });
  const resp = await new Promise<string>((resolve, reject) => {
    client.write('GET / HTTP/1.1\r\nHost: origin.trust.test\r\nConnection: close\r\n\r\n');
    let buf = '';
    client.on('data', (d: Buffer) => (buf += d.toString()));
    client.on('end', () => resolve(buf));
    client.on('close', () => resolve(buf));
    client.on('error', reject);
  });
  client.destroy();
  return resp;
}

async function startProxy(caDir: string) {
  return createForwardProxyServer({
    port: 0,
    host: '127.0.0.1',
    caDir,
    intercept: async () => false,
    // The test seam provides ONLY the lookup; caFile / insecure come from the
    // live reader (the config surface this suite is about).
    upstreamTls: { lookup: toLoopback },
  });
}

describe('forward-proxy: upstream TLS trust (ADR-0019)', () => {
  it('names the trust failure by default instead of a generic connection error', async () => {
    setUpstreamTlsReader(() => undefined); // system trust store only
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: false, persistDays: 1 }));
    clearProxyAccessLog();

    const ca = ensureCa(tmpDir('ocr-fp-trust-ca-'));
    const origin = await privateCaOrigin(ca);
    const handle = await startProxy(tmpDir('ocr-fp-trust-'));

    const resp = await exchange(handle.port, origin.port);
    assert.ok(/upstream TLS certificate rejected/.test(resp), `expected a named trust failure, got: ${resp}`);
    assert.ok(/502/.test(resp), `expected 502, got: ${resp}`);
    assert.ok(
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT/.test(resp),
      `expected the TLS error code in the answer, got: ${resp}`
    );
    assert.ok(/upstreamTls\.caFile/.test(resp), 'the answer must name the fix');

    const note = listProxyAccessEvents(50).find((e) => (e.note ?? '').startsWith('upstream tls:'));
    assert.ok(note, `expected an "upstream tls:" ledger note, got: ${JSON.stringify(listProxyAccessEvents(5).map((e) => e.note))}`);

    await origin.close();
    await handle.close();
  });

  it('reaches the origin once its CA is named in upstreamTls.caFile', async () => {
    const ca = ensureCa(tmpDir('ocr-fp-trust-ca2-'));
    const caFile = path.join(tmpDir('ocr-fp-trust-bundle-'), 'root-ca.pem');
    fs.writeFileSync(caFile, ca.caCertPem);
    setUpstreamTlsReader(() => ({ caFile, insecure: false }));

    const origin = await privateCaOrigin(ca);
    const handle = await startProxy(tmpDir('ocr-fp-trust2-'));

    const resp = await exchange(handle.port, origin.port);
    assert.ok(resp.includes('trusted'), `expected the origin body, got: ${resp}`);
    assert.ok(resp.includes('200 OK'), `expected 200, got: ${resp}`);

    await origin.close();
    await handle.close();
  });

  it('honours upstreamTls.insecure as the escape hatch', async () => {
    setUpstreamTlsReader(() => ({ insecure: true }));

    const ca = ensureCa(tmpDir('ocr-fp-trust-ca3-'));
    const origin = await privateCaOrigin(ca);
    const handle = await startProxy(tmpDir('ocr-fp-trust3-'));

    const resp = await exchange(handle.port, origin.port);
    assert.ok(resp.includes('trusted'), `expected the origin body, got: ${resp}`);

    await origin.close();
    await handle.close();
  });

  it('a missing caFile falls back to the system store (verification stays ON)', () => {
    setUpstreamTlsReader(() => ({ caFile: path.join(tmpDir('ocr-fp-nope-'), 'absent.pem'), insecure: false }));
    const resolved = resolveUpstreamTls();
    assert.equal(resolved.opts?.ca, undefined, 'an unreadable bundle must not be installed');
    assert.equal(resolved.opts?.rejectUnauthorized, undefined, 'verification must stay at its default (on)');
    assert.match(resolved.key, /@unreadable$/, 'the pool key must record the unreadable bundle');
  });

  it('APPENDS the bundle to the system roots instead of replacing them', () => {
    // `ca` is not additive in tls.connect: a bundle installed alone would make
    // every publicly-signed origin untrusted — the opposite of what the option
    // promises. The resolved list must therefore carry the system roots too.
    const ca = ensureCa(tmpDir('ocr-fp-trust-ca4-'));
    const caFile = path.join(tmpDir('ocr-fp-trust-bundle2-'), 'root-ca.pem');
    fs.writeFileSync(caFile, ca.caCertPem);
    setUpstreamTlsReader(() => ({ caFile, insecure: false }));

    const list = resolveUpstreamTls().opts?.ca as string[];
    assert.ok(Array.isArray(list), 'ca must be a list so it can be appended to');
    assert.equal(list.length, tls.rootCertificates.length + 1, 'system roots + the operator bundle');
    assert.equal(list[list.length - 1], ca.caCertPem, 'the bundle is last');
    assert.ok(list.includes(tls.rootCertificates[0]), 'the system roots are still present');
    setUpstreamTlsReader(() => undefined);
  });

  it('insecure wins over caFile — no trust list is installed when verification is off', () => {
    const caFile = path.join(tmpDir('ocr-fp-trust-bundle3-'), 'root-ca.pem');
    fs.writeFileSync(caFile, ensureCa(tmpDir('ocr-fp-trust-ca5-')).caCertPem);
    setUpstreamTlsReader(() => ({ caFile, insecure: true }));
    const resolved = resolveUpstreamTls();
    assert.equal(resolved.opts?.rejectUnauthorized, false);
    assert.equal(resolved.opts?.ca, undefined, 'a full CA parse per connection would be wasted');
    assert.match(resolved.key, /^insecure\|/);
    setUpstreamTlsReader(() => undefined);
  });

  it('the pool key tracks the trust policy, so a session is never reused across it', () => {
    setUpstreamTlsReader(() => undefined);
    const systemTrust = resolveUpstreamTls().key;
    setUpstreamTlsReader(() => ({ insecure: true }));
    const insecure = resolveUpstreamTls().key;
    assert.notEqual(systemTrust, insecure);
    assert.equal(systemTrust, 'sys');
    assert.equal(insecure, 'insecure');
    setUpstreamTlsReader(() => undefined);
  });
});
