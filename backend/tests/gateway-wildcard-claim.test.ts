import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitGateways,
  findGateway,
  claimsWildcard,
  listGatewayHosts,
  removeGateway,
  stageGateway,
  WILDCARD_HOST_CLAIM,
} from '../src/plugins/gateways.js';
import { createBuiltinModelGateway } from '../src/plugins/builtin/model-gateway.js';
import type { ClientGatewayPlugin } from '../src/plugins/types.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

/**
 * Claim ordering and the ACCEPT hook (ADR-0026).
 *
 * The registry is where "who owns this request" is decided, so the ordering it
 * enforces is contractual: exact SNI claims are consulted before wildcard
 * ones, and `match()` is the per-request accept step that makes a wildcard
 * (`hosts: ['*']`) safe — willingness to answer is not a capture of
 * everything. These tests pin the ordering, not the vendored wires.
 */

function gateway(
  hosts: string[],
  accept: (path: string) => boolean = () => true
): ClientGatewayPlugin {
  return {
    hosts,
    match: (info) => accept(String(info.url ?? '')),
    handle: async () => {},
  };
}

const request = (host: string, url = '/v1/chat/completions') => ({
  method: 'POST',
  url,
  headers: { host },
});

beforeEach(() => {
  // The registry is module-level and rebuilt by the plugin host; each test
  // starts from a clean staging + live set, and without a built-in row (the
  // interceptor factory installs it in production).
  commitGateways();
  for (const id of ['vendor', 'universal', 'lazy']) removeGateway(id);
});

describe('gateway claim ordering (ADR-0026)', () => {
  it('an exact host claim beats a wildcard claim regardless of stage order', () => {
    const universal = gateway([WILDCARD_HOST_CLAIM]);
    const vendor = gateway(['api2.cursor.sh']);
    // Wildcard staged FIRST — ordering must come from the registry, not from
    // the order plugins happened to load in.
    stageGateway('universal', universal);
    stageGateway('vendor', vendor);
    commitGateways();

    assert.equal(findGateway(request('api2.cursor.sh')), vendor);
    assert.equal(findGateway(request('api.anthropic.com')), universal);
  });

  it('the wildcard is skipped by exact-host lookups and never listed as a host', () => {
    stageGateway('universal', gateway([WILDCARD_HOST_CLAIM]));
    commitGateways();
    assert.equal(claimsWildcard(findGateway(request('anything.example'))!), true);
    // listGatewayHosts is the CLAIM vocabulary, verbatim — consumers filter.
    assert.deepEqual([...listGatewayHosts()], [WILDCARD_HOST_CLAIM]);
  });

  it('match() is the accept step: a declining wildcard yields no gateway', () => {
    stageGateway(
      'universal',
      gateway([WILDCARD_HOST_CLAIM], (path) => path.endsWith('/v1/chat/completions'))
    );
    commitGateways();

    assert.ok(findGateway(request('api.anthropic.com', '/v1/chat/completions')));
    // Declined → undefined, which is what lets the interceptor forward the
    // request transparently instead of swallowing it.
    assert.equal(findGateway(request('cdn.example.com', '/assets/logo.png')), undefined);
  });

  it('a throwing match() is a decline, never a broken proxy leg', () => {
    stageGateway('universal', {
      hosts: [WILDCARD_HOST_CLAIM],
      match: () => {
        throw new Error('boom');
      },
      handle: async () => {},
    });
    commitGateways();
    assert.equal(findGateway(request('api.anthropic.com')), undefined);
  });

  it('a declining exact claim hands the request to the wildcard', () => {
    const vendor = gateway(['api2.cursor.sh'], () => false);
    const universal = gateway([WILDCARD_HOST_CLAIM]);
    stageGateway('vendor', vendor);
    stageGateway('universal', universal);
    commitGateways();

    // The exact claim exists but declines this request: the wildcard is the
    // next in line, which is the documented order.
    assert.equal(findGateway(request('api2.cursor.sh')), universal);
  });
});

/**
 * The built-in universal gateway (ADR-0026 revision 2). It occupies the
 * wildcard slot when no package does, so the interceptor never dispatches a
 * canonical surface itself — but it must remain the LAST row, and it must
 * decline everything that is not canonical inference traffic.
 */
describe('built-in model gateway row', () => {
  const orchestrator = {
    process: async () => {
      throw new Error('dispatch is exercised in forward-proxy.test.ts');
    },
  } as unknown as PipelineOrchestrator;

  /** The row the INTERCEPTOR passes to `findGateway` — a per-caller fallback,
   *  never module state (two interceptors may exist in one process). */
  const builtinRow = (): ClientGatewayPlugin => createBuiltinModelGateway(orchestrator);

  it('answers canonical POSTs on hosts nobody claimed', () => {
    const builtin = builtinRow();
    for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
      assert.equal(findGateway(request('api.anthropic.com', path), builtin), builtin, path);
    }
    // `:path` on the h2 compat layer — no `url` field at all.
    assert.equal(
      findGateway({ method: 'POST', headers: { ':authority': 'api.openai.com', ':path': '/v1/messages' } }, builtin),
      builtin
    );
  });

  it('declines everything that is not canonical inference traffic', () => {
    const builtin = builtinRow();
    // Vendors expose plenty of other POSTs on the same hosts; nothing but the
    // surface table may be swallowed, or the proxy stops being transparent.
    assert.equal(findGateway(request('api.anthropic.com', '/v1/messages/count_tokens'), builtin), undefined);
    assert.equal(findGateway(request('cdn.example.com', '/upload'), builtin), undefined);
    assert.equal(findGateway({ method: 'GET', url: '/v1/models', headers: { host: 'api.openai.com' } }, builtin), undefined);
  });

  it('an installed wildcard package pre-empts the built-in row', () => {
    const builtin = builtinRow();
    const installed = gateway([WILDCARD_HOST_CLAIM]);
    stageGateway('universal', installed);
    commitGateways();

    assert.equal(findGateway(request('api.anthropic.com'), builtin), installed);
    assert.notEqual(findGateway(request('api.anthropic.com'), builtin), builtin);
  });

  it('takes over when an installed wildcard declines', () => {
    const builtin = builtinRow();
    stageGateway('universal', gateway([WILDCARD_HOST_CLAIM], () => false));
    commitGateways();

    assert.equal(findGateway(request('api.anthropic.com'), builtin), builtin);
  });
});
