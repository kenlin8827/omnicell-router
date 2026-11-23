import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createForwardProxyServer } from '../../src/forward-proxy/server.js';
import { currentInterceptPosture, currentRules, ruleDecision, setBootRules, transitEgressFor } from '../../src/forward-proxy/egress.js';
import { lintRules, RULE_WARNING_CODES, resolveHost, type ResolveOptions } from '../../src/forward-proxy/rules.js';
import { commitGateways, listClaimedEgress, removeGateway, stageGateway } from '../../src/plugins/gateways.js';
import type { ClientGatewayPlugin } from '../../src/plugins/types.js';

/**
 * The claims posture (ADR-0018 Revision 4) plus the claim's exit ladder
 * (Revision 5): interception is DECIDED, not a blank-machine default, and a
 * claimed host's exit belongs to the claim.
 *
 * Three inputs decide one host's decrypt/tunnel half, in this order: a SPECIFIC
 * row (the operator outranks every claim on the INGRESS axis), the live
 * client-gateway claim set (the capability the gateway declares), and finally
 * the `intercept` posture (`claims` = nothing else decrypts, `all` = the audit
 * posture). The catch-all row supplies `egress` for hosts nothing decides,
 * which is why a catch-all carrying `intercept` under `claims` is a lint
 * finding rather than a silent no-op. On a CLAIMED host the exit axis is the
 * claim's (Revision 5): a specific row keeps its ingress, but its `egress` is
 * read only when neither the operator's switch, the plugin's code nor the
 * manifest spoke.
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

  it('a specific row decides the ingress axis — reject and passthrough both override the claim', () => {
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

  it('with no claim opinion, the row decides the exit', () => {
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

/**
 * The claim's outbound-leg declaration (ADR-0018 step 3). A claim has always
 * said who may PARSE a host; the declaration adds where that package's bytes
 * leave the machine, which is vendor knowledge the operator cannot guess ("this
 * endpoint is not reachable direct from here"). Three properties make it safe
 * rather than a second config plane:
 *
 *   - it names a LEG, never an address — `proxy` is still the operator's
 *     `config.proxy`, resolved by `outboundProxyUrl()`;
 *   - a specific row still outranks it, in both directions;
 *   - its reach is exactly the claim set, enforced by the lookup being exact
 *     (no glob) and by a wildcard claim never entering the map.
 */
/**
 * The claim's outbound-leg ladder (ADR-0018 Revision 5). A claim has always
 * said who may PARSE a host; the ladder says where that package's bytes leave
 * the machine, because "this endpoint is not reachable direct from here" is
 * vendor knowledge the operator cannot guess.
 *
 * The precedence is OWNERSHIP TRANSFER, not "the row wins": over a host a
 * gateway claims, the exit comes from the operator's plugin-level switch, then
 * the gateway's own `egressFor()`, then the manifest, and only a silent claim
 * lets the table decide. Three properties keep that from becoming a second
 * configuration plane:
 *
 *   - it names a LEG, never an address — `proxy` is still the operator's
 *     `config.proxy`, resolved by `outboundProxyUrl()`;
 *   - its reach is exactly the claim set (exact host match, never a glob);
 *   - `reject` and loopback are outside the ladder (an admission verdict and
 *     cycle safety, not legs).
 */
describe('resolveHost — the claim egress ladder', () => {
  const CATCH_ALL_DIRECT = [{ match: '*', ingress: 'passthrough' as const, egress: 'direct' as const }];
  /** A claim that answers for exactly one host. */
  const claims = (host: string, action: 'proxy' | 'direct', source: 'operator' | 'code' | 'manifest' = 'manifest') =>
    (h: string) => (h === host ? { action, source } : undefined);

  it("a claim's leg outranks the catch-all it sits under", () => {
    assert.deepEqual(resolveHost('claim.test', CATCH_ALL_DIRECT, opts({ claimEgress: claims('claim.test', 'proxy') })), {
      action: 'proxy',
      tunnel: false,
      reason: 'claim',
      egressClaim: 'manifest',
    });
  });

  it('a specific row keeps its ingress; the claim owns the exit, in both directions', () => {
    const pinDirect = [{ match: 'claim.test', ingress: 'intercept' as const, egress: 'direct' as const }];
    assert.deepEqual(
      resolveHost('claim.test', [...pinDirect, ...CATCH_ALL_DIRECT], opts({ claimEgress: claims('claim.test', 'proxy') })),
      { action: 'proxy', tunnel: false, reason: 'rule', ruleIndex: 0, match: 'claim.test', egressClaim: 'manifest' },
      'the row decrypts; the claim routes',
    );

    const pinProxy = [{ match: 'claim.test', ingress: 'intercept' as const, egress: 'proxy' as const }];
    assert.deepEqual(
      resolveHost('claim.test', [...pinProxy, ...CATCH_ALL_DIRECT], opts({ claimEgress: claims('claim.test', 'direct', 'operator') })),
      { action: 'direct', tunnel: false, reason: 'rule', ruleIndex: 0, match: 'claim.test', egressClaim: 'operator' },
      'the operator switch outranks the row in the other direction too',
    );
  });

  it('credits the claim even when the row happens to name the same leg', () => {
    // The row's `egress` is inert over a claimed host; saying "a rule decided"
    // would teach the operator that their row applies when removing it changes
    // nothing.
    const pinProxy = [{ match: 'claim.test', ingress: 'intercept' as const, egress: 'proxy' as const }];
    assert.deepEqual(
      resolveHost('claim.test', [...pinProxy, ...CATCH_ALL_DIRECT], opts({ claimEgress: claims('claim.test', 'proxy', 'code') })),
      { action: 'proxy', tunnel: false, reason: 'rule', ruleIndex: 0, match: 'claim.test', egressClaim: 'code' },
    );
  });

  it('a reject row is an admission verdict the claim cannot un-block', () => {
    const reject = [
      { match: 'claim.test', ingress: 'reject' as const, egress: 'direct' as const },
      ...CATCH_ALL_DIRECT,
    ];
    assert.deepEqual(resolveHost('claim.test', reject, opts({ claimEgress: claims('claim.test', 'proxy') })), {
      action: 'reject',
      tunnel: false,
      reason: 'rule',
      ruleIndex: 0,
      match: 'claim.test',
    });
  });

  it('a silent claim leaves the table in charge', () => {
    assert.deepEqual(resolveHost('claim.test', CATCH_ALL_DIRECT, opts({ claimEgress: () => undefined })), {
      action: 'direct',
      tunnel: false,
      reason: 'claim',
    });
  });

  it('reaches only the host it names', () => {
    // A leg for one host must not leak onto a sibling the same plugin claims,
    // nor onto a host nobody claims.
    const onlyClaimTest = claims('claim.test', 'proxy');
    assert.equal(resolveHost('other.example', CATCH_ALL_DIRECT, opts({ claimEgress: onlyClaimTest })).action, 'direct');
    assert.equal(resolveHost('api.ai.jetbrains.com.cn', CATCH_ALL_DIRECT, opts({ claimEgress: onlyClaimTest })).action, 'direct');
    assert.equal(
      resolveHost('claim.test', CATCH_ALL_DIRECT, opts({ claimed: new Set(), claimEgress: onlyClaimTest })).action,
      'direct',
      'a host nobody claims is never routed by a claim opinion',
    );
  });

  it('is case-insensitive on the host, because manifests are hand-written', () => {
    assert.equal(resolveHost('CLAIM.test', CATCH_ALL_DIRECT, opts({ claimEgress: claims('claim.test', 'proxy') })).action, 'proxy');
  });

  it('leaves the decrypt axis to the claim: a leg never turns a tunnel into a decrypt', () => {
    assert.equal(
      resolveHost('any.example', CATCH_ALL_DIRECT, opts({ claimed: new Set(), claimEgress: claims('any.example', 'proxy') })).tunnel,
      true,
    );
  });
});

describe('listClaimedEgress — the registry half of the ladder', () => {
  const gw = (hosts: string[], egressFor?: ClientGatewayPlugin['egressFor']): ClientGatewayPlugin => ({
    hosts,
    match: () => true,
    handle: async () => {},
    egressFor,
  });

  it('never lets a wildcard claim carry a declaration', () => {
    stageGateway('wild-egress', gw(['*']), { manifest: 'proxy' });
    commitGateways();
    assert.equal(listClaimedEgress().size, 0, 'a wildcard declaration would pin every host on the machine');
    removeGateway('wild-egress');
  });

  it('drops a host two gateways declare oppositely instead of picking a winner', () => {
    stageGateway('egress-a', gw(['shared.test']), { manifest: 'proxy' });
    stageGateway('egress-b', gw(['shared.test']), { manifest: 'direct' });
    commitGateways();
    assert.equal(listClaimedEgress().has('shared.test'), false, 'load order is not an operator decision');
    removeGateway('egress-a');
    removeGateway('egress-b');
  });

  it('keeps an agreement, and treats `inherit` as no opinion at all', () => {
    stageGateway('egress-c', gw(['Agree.TEST']), { manifest: 'proxy' });
    stageGateway('egress-d', gw(['agree.test']), { manifest: 'proxy' });
    stageGateway('egress-e', gw(['quiet.test']), { manifest: 'inherit' });
    commitGateways();
    assert.deepEqual([...listClaimedEgress().entries()], [['agree.test', 'proxy']]);
    removeGateway('egress-c');
    removeGateway('egress-d');
    removeGateway('egress-e');
  });

  it('reads the ladder top-down: operator, then code, then manifest', () => {
    stageGateway('egress-ladder', gw(['ladder.test'], () => 'direct'), { manifest: 'proxy' });
    commitGateways();
    assert.deepEqual([...listClaimedEgress().entries()], [['ladder.test', 'direct']], 'code outranks the manifest');
    stageGateway('egress-ladder', gw(['ladder.test'], () => 'direct'), { manifest: 'proxy', operator: 'proxy' });
    commitGateways();
    assert.deepEqual([...listClaimedEgress().entries()], [['ladder.test', 'proxy']], 'the operator outranks the code');
    removeGateway('egress-ladder');
  });

  it('treats a throwing egressFor as silence, not a routing decision', () => {
    stageGateway('egress-throw', gw(['throw.test'], () => { throw new Error('plugin bug'); }), { manifest: 'proxy' });
    commitGateways();
    assert.deepEqual([...listClaimedEgress().entries()], [['throw.test', 'proxy']], 'the manifest still speaks');
    removeGateway('egress-throw');
  });
});

describe('lintRules — claim-owns-egress', () => {
  const claimed = new Map([['claimed.test', 'proxy' as const]]);
  const codes = (raw: unknown): string[] => lintRules(raw, true, 'claims', claimed).map((w) => w.code);

  it('flags an explicit-egress row whose value the claim overrides', () => {
    const warned = lintRules(
      [
        { match: 'claimed.test', ingress: 'intercept', egress: 'direct' },
        { match: '*', ingress: 'passthrough', egress: 'direct' },
      ],
      true,
      'claims',
      claimed,
    );
    assert.deepEqual(warned.map((w) => w.code), ['claim-owns-egress']);
    assert.equal(warned[0]?.ruleIndex, 0);
    assert.match(warned[0]?.detail ?? '', /claimed\.test/);
  });

  it('stays quiet when the row agrees, when it is a reject, and for the catch-all', () => {
    assert.deepEqual(
      codes([
        { match: 'claimed.test', ingress: 'intercept', egress: 'proxy' },
        { match: '*', ingress: 'passthrough', egress: 'proxy' },
      ]),
      [],
      'a row that agrees with the claim is not reported',
    );
    assert.deepEqual(
      codes([
        { match: 'claimed.test', ingress: 'reject', egress: 'direct' },
        { match: '*', ingress: 'passthrough', egress: 'direct' },
      ]),
      [],
      'a reject row has no leg to shadow',
    );
    assert.deepEqual(
      codes([{ match: '*', ingress: 'passthrough', egress: 'direct' }]),
      [],
      '`*` still routes every unclaimed host',
    );
  });

  it('emits a code the console vocabulary owns', () => {
    // The frontend union is parity-checked separately; this pins the emitted
    // code to the runtime list that has a sentence behind it.
    assert.ok(RULE_WARNING_CODES.includes('claim-owns-egress'));
  });
});

/**
 * The parity bug this file exists to keep dead: `transitEgressFor` treats an
 * empty table as "no table installed → the historical direct". A claim's leg is
 * not a table row, so that escape must not swallow it — otherwise the relay
 * goes direct while every preview of the same host reads `proxy`.
 */
describe('transitEgressFor — a claim survives an empty table', () => {
  it('reports proxy for a declaring gateway with no rule table in force', () => {
    // Pinned, not assumed: an earlier e2e case in this file hands its rule
    // table to `createForwardProxyServer`, which installs it as the boot
    // snapshot — so "empty table" is a state this test has to create and undo.
    const prevRules = currentRules();
    const prevPosture = currentInterceptPosture();
    setBootRules([], 'claims');
    stageGateway(
      'parity-egress',
      { hosts: ['parity-egress.test'], match: () => true, handle: async () => {} },
      { manifest: 'proxy' },
    );
    commitGateways();
    try {
      assert.equal(ruleDecision('parity-egress.test').action, 'proxy');
      assert.deepEqual(transitEgressFor('parity-egress.test'), { proxy: true });
      // And an undeclared host still gets the historical no-op answer.
      assert.deepEqual(transitEgressFor('unrelated.test'), {});
    } finally {
      removeGateway('parity-egress');
      setBootRules(prevRules, prevPosture);
    }
  });
});