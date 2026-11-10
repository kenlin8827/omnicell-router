import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGatewayHostSdk } from '../src/plugins/host.js';
import { registerRuntimeConfigRef } from '../src/config/index.js';
import type { RouterConfig } from '../src/config/types.js';
import { setGatewayChatServices, type GatewayChatServices } from '../src/surfaces/gateway-chat.js';
import { writePluginConfig } from '../src/plugins/config.js';
import { runWithProxyCaller } from '../src/forward-proxy/caller-context.js';
import type { PluginManifest } from '../src/plugins/types.js';

/**
 * The gateway binding fallback vs `forwardProxy.requireCredential` (ADR-0017).
 *
 * Admission-side strict mode only guards NEW tunnels. A tunnel admitted before
 * the operator flipped the switch still exists, and the CONNECT credential was
 * hop-by-hop — so the identity decision must be re-read at the gateway seam or
 * that tunnel keeps spending the bound key. The three cases below are the whole
 * precedence rule: caller > bound (strict off) > nobody (strict on).
 */

/** Only `id` and `configSchema` are read by the chat seam. */
const MANIFEST = {
  id: 'cursor-gateway',
  name: 'Cursor Gateway',
  version: '0.0.0-test',
  apiVersion: 1,
  type: 'client-gateway',
  configSchema: [{ key: 'accountKeyId', type: 'string', default: '' }],
} as unknown as PluginManifest;

const seen: Array<string | undefined> = [];

function installServices(): void {
  const services: GatewayChatServices = {
    catalog: () => ({ tiers: [], models: [] }),
    run: async (_body, _sink, _signal, opts) => {
      seen.push(opts?.keyId);
    },
  };
  setGatewayChatServices(services);
}

function useStrict(on: boolean): void {
  // Only `forwardProxy.requireCredential` is read by the seam.
  registerRuntimeConfigRef({ forwardProxy: { requireCredential: on } } as unknown as RouterConfig);
}

describe('gateway binding: strict credential mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-gw-binding-'));

  after(() => {
    setGatewayChatServices(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strict off: a credential-less turn falls back to the bound key', async () => {
    writePluginConfig(MANIFEST.id, MANIFEST.configSchema, { accountKeyId: 'key-bound' });
    installServices();
    useStrict(false);
    const sdk = buildGatewayHostSdk(MANIFEST, dir);
    await sdk.chat({}, {} as never, undefined);
    assert.equal(seen.at(-1), 'key-bound');
  });

  it('strict on: the same turn is refused identity instead of borrowing the binding', async () => {
    useStrict(true);
    const sdk = buildGatewayHostSdk(MANIFEST, dir);
    await sdk.chat({}, {} as never, undefined);
    assert.equal(seen.at(-1), '');
  });

  it('strict on: a CONNECT credential still wins at dispatch', async () => {
    useStrict(true);
    const sdk = buildGatewayHostSdk(MANIFEST, dir);
    await runWithProxyCaller({ keyId: 'key-connect', name: 'Cursor' }, () =>
      sdk.chat({}, {} as never, undefined)
    );
    assert.equal(seen.at(-1), 'key-connect');
  });
});
