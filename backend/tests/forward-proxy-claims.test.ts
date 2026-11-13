import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../src/forward-proxy/server.js';
import { ruleDecision } from '../src/forward-proxy/egress.js';
import { lintRules, resolveHost, type ResolveOptions } from '../src/forward-proxy/rules.js';
import { commitGateways, removeGateway, stageGateway } from '../src/plugins/gateways.js';
import type { ClientGatewayPlugin } from '../src/plugins/types.js';

/**
 * The claims posture (ADR-0018 Revision 4): interception is DECIDED, not a
 * blank-machine default.
 *
 * Three inputs decide one host's decrypt/tunnel half, in this order: a SPECIFIC
 * row (the operator outranks everything), the live client-gateway claim set
 * (the capability the gateway declares), and finally the `intercept` posture
 * (`claims` = nothing else decrypts, `all` = the audit posture). The catch-all
 * row only supplies `egress` plus the default posture for hosts nothing
 * declares — which is why a catch-all carrying `intercept` under `claims` is a
 * lint finding rather than a silent no-op.
 */

const ALL_CLAIMED = ['claim.test', 'api.ai.jetbrains.com.cn'];

const opts = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  claimed: new Set(ALL_CLAIMED),
  intercept: 'claims',
  ...over,
});

const CATCH_ALL_PASSTHROUGH = [{ match: '*', ingress: 'passthrough' as const, egress: 'proxy' as const }];

describe('resolveHost — the claims posture', () => {
  it('an empty table decrypts nothing unclaimed and everything claimed', () => {
    assert.deepEqual(resolveHost('any.example', [], opts({ claimed: new Set() })), {
      action: 'direct',
      tunnel: true,
      reason: 'fallback',
    });
    assert.deepEqual(resolveHost('any.example', [], opts()), {
      action: 'direct',
      tunnel: true,
      reason: 'fallback',
    });
    assert.deepEqual(resolveHost('claim.test', [], opts()), {
      action: 'direct',
      tunnel: false,
      reason: 'claim',
    });
  });

  it('is case-insensitive about the claim set (plugin manifests are hand-written)', () => {
    assert.equal(resolveHost('Claim.TEST', [], opts({ claimed: new Set(['claim.test']) })).reason, 'claim');
    assert.equal(resolveHost('claim.test', [], opts({ claimed: new Set(['CLAIM.TEST']) })).tunnel, false);
  });

  it('intercept: all decrypts every host, claimed or not', () => {
    for (const host of ['claim.test', 'nobody-claims-this.example']) {
      const d = resolveHost(host, CATCH_ALL_PASSTHROUGH, opts({ intercept: 'all' }));
      assert.equal(d.tunnel, false, host);
      assert.equal(d.action, 'proxy', 'the catch-all egress is untouched by the posture');
    }
    // With no table at all the audit posture still decrypts (action direct).
    assert.deepEqual(resolveHost('any.example', undefined, opts({ intercept: 'all', claimed: new Set() })), {
      action: 'direct',
      tunnel: false,
      reason: 'fallback',
    });
  });

  it('a catch-all passthrough row still decrypts a claimed host', () => {
    assert.deepEqual(resolveHost('claim.test', CATCH_ALL_PASSTHROUGH, opts()), {
      action: 'proxy',
      tunnel: false,
      reason: 'claim',
    });
    assert.deepEqual(resolveHost('other.test', CATCH_ALL_PASSTHROUGH, opts()), {
      action: 'proxy',
      tunnel: true,
      reason: 'fallback',
    });
  });

  it('a specific row outranks a claim — reject and passthrough both override it', () => {
    const rules = [
      { match: 'api.ai.jetbrains.com.cn', ingress: 'reject' as const, egress: 'direct' as const },
      { match: 'claim.test', ingress: 'passthrough' as const, egress: 'direct' as const },
      { match: '*', ingress: 'intercept' as const, egress: 'proxy' as const },
    ];
    assert.deepEqual(resolveHost('api.ai.jetbrains.com.cn', rules, opts()), {
      action: 'reject',
      tunnel: false,
      reason: 'rule',
      ruleIndex: 0,
      match: 'api.ai.jetbrains.com.cn',
    });
    assert.deepEqual(resolveHost('claim.test', rules, opts()), {
      action: 'direct',
      tunnel: true,
      reason: 'rule',
      ruleIndex: 1,
      match: 'claim.test',
    });
  });

  it('a catch-all reject keeps its admission-gate meaning and no claim un-blocks it', () => {
    const rejectAll = [{ match: '*', ingress: 'reject' as const, egress: 'direct' as const }];
    for (const host of ['claim.test', 'other.test']) {
      assert.deepEqual(resolveHost(host, rejectAll, opts()), {
        action: 'reject',
        tunnel: false,
        reason: 'rule',
        ruleIndex: 0,
        match: '*',
      });
    }
    // ...and the audit posture never overrides a blocklist either.
    assert.equal(resolveHost('other.test', rejectAll, opts({ intercept: 'all' })).action, 'reject');
  });

  it('loopback stays direct + tunneled against any posture, claim or rule', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']) {
      for (const posture of ['claims', 'all'] as const) {
        assert.deepEqual(
          resolveHost(host, [{ match: '*', ingress: 'intercept', egress: 'direct' }], opts({ intercept: posture, claimed: new Set([host]) })),
          { action: 'direct', tunnel: true, reason: 'loopback' },
          `${host} under ${posture}`,
        );
      }
    }
  });

  it('egress is untouched: the matched row still decides direct vs proxy', () => {
    assert.equal(resolveHost('claim.test', [{ match: '*', ingress: 'passthrough', egress: 'proxy' }], opts()).action, 'proxy');
    assert.equal(resolveHost('claim.test', [{ match: '*', ingress: 'passthrough', egress: 'direct' }], opts()).action, 'direct');
    // No catch-all = the historical direct fallback, tunneled or not.
    assert.deepEqual(resolveHost('claim.test', [], opts()), { action: 'direct', tunnel: false, reason: 'claim' });
    assert.deepEqual(resolveHost('nobody.test', [], opts()), { action: 'direct', tunnel: true, reason: 'fallback' });
  });
});

describe('lintRules — catch-all-intercepts', () => {
  const codes = (raw: unknown, proxyEnabled = true, intercept: 'claims' | 'all' = 'claims'): string[] =>
    lintRules(raw, proxyEnabled, intercept).map((w) => w.code);

  it('fires only when the posture is claims AND the catch-all says intercept', () => {
    const interceptAll = [{ match: '*', ingress: 'intercept', egress: 'proxy' }];
    assert.deepEqual(codes(interceptAll, true, 'claims'), ['catch-all-intercepts']);
    assert.deepEqual(codes(interceptAll, true, 'all'), [], 'the audit posture makes the row true');
    assert.deepEqual(codes([{ match: '*', ingress: 'passthrough', egress: 'proxy' }], true, 'claims'), []);
    assert.deepEqual(codes([{ match: '*', ingress: 'reject', egress: 'direct' }], true, 'claims'), []);
  });

  it('addresses the row the operator typed', () => {
    const raw = [
      { match: 'a.test', ingress: 'passthrough', egress: 'direct' },
      { match: '*', ingress: 'intercept', egress: 'proxy' },
    ];
    const [warning] = lintRules(raw, true, 'claims');
    assert.equal(warning.code, 'catch-all-intercepts');
    assert.equal(warning.ruleIndex, 1);
  });

  it('is not a substitute for no-catch-all', () => {
    assert.deepEqual(codes([{ match: 'a.test', ingress: 'intercept', egress: 'proxy' }], true, 'claims'), ['no-catch-all']);
  });
});

// ── e2e: the claim set reaches the live decision path, not just the unit ─────

function tmpCaDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-claims-'));
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

function tlsOver(socket: net.Socket, servername: string, ca: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, ca, rejectUnauthorized: true }, () => resolve(t));
    t.on('error', reject);
  });
}

const CLAIMED_HOST = 'claims-e2e.test';
const UNCLAIMED_HOST = 'unclaimed-e2e.test';

const stubGateway: ClientGatewayPlugin = {
  hosts: [CLAIMED_HOST],
  match: () => true,
  handle: async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"claimed":true}');
  },
};

describe('forward-proxy e2e: a claimed host is decrypted under a passthrough catch-all', () => {
  after(() => {
    removeGateway('claims-e2e');
  });

  it('decrypts the claimed host and blind-tunnels the rest', async () => {
    stageGateway('claims-e2e', stubGateway);
    commitGateways();
    let intercepted = 0;
    const handle = await createForwardProxyServer({
      port: 0,
      host: '127.0.0.1',
      caDir: tmpCaDir(),
      rules: CATCH_ALL_PASSTHROUGH,
      interceptPosture: 'claims',
      intercept: async (_req, res) => {
        intercepted += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return true;
      },
    });
    let tlsSock: tls.TLSSocket | undefined;
    try {
      // The live decision path (the one every proxy leg uses) agrees with the
      // registry: claimed → decrypt, everything else → tunnel.
      assert.equal(ruleDecision(CLAIMED_HOST).tunnel, false);
      assert.equal(ruleDecision(CLAIMED_HOST).reason, 'claim');
      assert.equal(ruleDecision(UNCLAIMED_HOST).tunnel, true);

      const sock = await connectViaProxy(handle.port, CLAIMED_HOST, 443);
      tlsSock = await tlsOver(sock, CLAIMED_HOST, handle.caCertPem);
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
        tlsSock.write('POST /v1/chat/completions HTTP/1.1\r\nHost: claims-e2e.test\r\nContent-Length: 2\r\n\r\n{}');
      });
      assert.match(body, /200 OK/);
      assert.equal(intercepted, 1, 'a claimed host must reach the interceptor');

      // An unclaimed host under the same passthrough catch-all never decrypts.
      const blocked = await connectViaProxy(handle.port, UNCLAIMED_HOST, 443);
      blocked.on('error', () => {});
      await new Promise<void>((resolve) => {
        blocked.on('close', () => resolve());
        setTimeout(resolve, 1000);
      });
      assert.equal(intercepted, 1, 'an unclaimed host must never be decrypted');
      blocked.destroy();
    } finally {
      try {
        tlsSock?.destroy();
      } catch {}
      await handle.close();
    }
  });
});
