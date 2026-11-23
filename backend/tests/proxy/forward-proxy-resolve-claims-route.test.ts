import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/server.js';
import { commitGateways, removeGateway, stageGateway } from '../../src/plugins/gateways.js';
import type { ClientGatewayPlugin, PluginClaimEgress } from '../../src/plugins/types.js';

/**
 * POST /api/admin/forward-proxy/rules/resolve — the CLAIM half of the answer
 * (ADR-0018 Revision 5, and the contract the console's claims dialog is built
 * on).
 *
 * The dialog is READ-ONLY: it reports, per claimed host, what the SAME resolver
 * the relay calls decides — the exit, the tier of the claim that owns it
 * (`egressClaim`), and whether a row has blinded the gateway (`tunnel`). It
 * lives here, and not in the browser, because glob matching re-implemented in
 * the browser is a second resolver, and a second resolver is a preview that can
 * disagree with the relay.
 */
const GW_ID = 'resolve-claims-route';
const HOST_A = 'pa.resolve-claims.test';
const HOST_B = 'quota.resolve-claims.test';

const gateway = (
  tiers?: { manifest?: PluginClaimEgress; operator?: PluginClaimEgress },
  code?: 'proxy' | 'direct',
): void => {
  const gw: ClientGatewayPlugin = { hosts: [HOST_A, HOST_B], match: () => true, handle: async () => {} };
  if (code) gw.egressFor = () => code;
  stageGateway(GW_ID, gw, tiers);
  commitGateways();
};

const resolve = async (rules: unknown[], intercept?: 'all' | 'claims') => {
  const cfg = loadConfig();
  cfg.host = '127.0.0.1';
  cfg.webAuth = { enabled: false };
  const { app } = createServer(cfg);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/forward-proxy/rules/resolve',
      payload: { rules, ...(intercept ? { intercept } : {}) },
    });
    assert.equal(res.statusCode, 200);
    return res.json();
  } finally {
    await app.close();
  }
};

const source = (body: any) => body.claimSources.find((s: { pluginId: string }) => s.pluginId === GW_ID);

describe('POST /api/admin/forward-proxy/rules/resolve — claim outcomes', () => {
  before(() => gateway({ manifest: 'proxy' }));
  after(() => removeGateway(GW_ID));

  it('attributes a declaration over the catch-all, host by host', async () => {
    const body = await resolve([{ match: '*', ingress: 'passthrough', egress: 'direct' }]);
    const src = source(body);
    assert.deepEqual(src.egress, ['proxy'], 'the declaration itself');
    assert.deepEqual(
      src.outcomes.map((o: any) => [o.host, o.action, o.tunnel, o.reason, o.egressClaim]),
      [
        // The claim outranks the catch-all's `direct` (step 4), and the host
        // stays DECRYPTED — a claim is what parses it.
        [HOST_A, 'proxy', false, 'claim', 'manifest'],
        [HOST_B, 'proxy', false, 'claim', 'manifest'],
      ],
    );
  });

  it("keeps a specific row's ingress and lets the claim own the exit", async () => {
    const body = await resolve([
      { match: HOST_A, ingress: 'intercept', egress: 'direct' },
      { match: '*', ingress: 'passthrough', egress: 'proxy' },
    ]);
    const [a, b] = source(body).outcomes;
    // The row decrypts THIS host (its ingress is read verbatim), and the
    // claim's leg is what the relay dials — the row's `egress` routes nothing.
    assert.deepEqual(
      [a.host, a.action, a.tunnel, a.reason, a.ruleIndex, a.egressClaim],
      [HOST_A, 'proxy', false, 'rule', 0, 'manifest'],
    );
    assert.deepEqual(
      [b.host, b.action, b.reason, b.egressClaim],
      [HOST_B, 'proxy', 'claim', 'manifest'],
    );
  });

  it('says out loud when a row blinds a claimed host', async () => {
    const body = await resolve([
      { match: HOST_B, ingress: 'passthrough', egress: 'direct' },
      { match: '*', ingress: 'passthrough', egress: 'direct' },
    ]);
    const blinded = source(body).outcomes.find((o: any) => o.host === HOST_B);
    // `tunnel: true` on a host a gateway claims is the silent failure: the exit
    // resolves as asked, and nothing parses the bytes. The dialog prints this
    // flag as the reason the exit answer must not be trusted alone.
    assert.equal(blinded.tunnel, true);
    assert.equal(blinded.reason, 'rule');
    assert.equal(blinded.action, 'proxy', 'the claim still owns the leg the relay dials');
  });

  it('reads the ladder top-down: the operator switch outranks code and manifest', async () => {
    gateway({ manifest: 'proxy', operator: 'direct' }, 'proxy');
    try {
      const body = await resolve([{ match: '*', ingress: 'passthrough', egress: 'proxy' }]);
      const src = source(body);
      assert.deepEqual(src.egress, ['direct']);
      assert.deepEqual(
        src.outcomes.map((o: any) => [o.action, o.egressClaim]),
        [['direct', 'operator'], ['direct', 'operator']],
      );
    } finally {
      gateway({ manifest: 'proxy' });
    }
  });

  it('leaves a gateway that declares nothing to the catch-all', async () => {
    gateway(undefined);
    try {
      const body = await resolve([{ match: '*', ingress: 'passthrough', egress: 'proxy' }]);
      const src = source(body);
      assert.deepEqual(src.egress, []);
      assert.deepEqual(
        src.outcomes.map((o: any) => [o.action, o.reason, o.egressClaim]),
        [['proxy', 'claim', undefined], ['proxy', 'claim', undefined]],
        'the claim still decrypts; only the exit came from the table',
      );
    } finally {
      gateway({ manifest: 'proxy' });
    }
  });
});