import { getOcrHomeDir } from '../../src/cli/paths.js';
import {
  probeClientVersion,
  resolveForwardProxyEndpoint,
  resolveGatewayBaseUrl,
} from '../../src/cli/clients/base.js';
import { CA_CN, caCertPath } from '../../src/forward-proxy/ca.js';
import { getForwardProxyStatus } from '../../src/forward-proxy/status.js';
import { probeCaTrustedCached } from '../../src/forward-proxy/ca-trust.js';
import { createApiKey, listApiKeys } from '../../src/auth/api-keys.js';
import type { ClientAdapterHost } from '../../src/plugins/types.js';

/**
 * A `ClientAdapterHost` wired to the REAL core seams — the same modules
 * `buildClientAdapterHostSdk()` (backend/src/plugins/host.ts) wires for a
 * package loaded at runtime.
 *
 * Deliberately not a mock: package code is exercised against the live config
 * snapshot, the live proxy singleton and the real CA probes, so a test can
 * only pass when the seam behaves as the host would make it behave. Callers
 * override single seams (`config`, `forwardProxy`) to pin a scenario.
 */
export function testAdapterHost(overrides: Partial<ClientAdapterHost> = {}): ClientAdapterHost {
  return {
    log: () => {},
    ocrHome: () => getOcrHomeDir(),
    pluginDir: () => '',
    config: () => ({}),
    forwardProxy: () => resolveForwardProxyEndpoint(),
    caCertPath: () => caCertPath(),
    forwardProxyStatus: () => getForwardProxyStatus(),
    caTrust: (caPath?: string, opts?: { force?: boolean }) =>
      probeCaTrustedCached(caPath || caCertPath(), opts).then((r) => ({ trusted: r.trusted })),
    caCommonName: () => CA_CN,
    probeVersion: (cmd: string[]) => probeClientVersion(cmd),
    gatewayBaseUrl: (apiKey?: string) => resolveGatewayBaseUrl(apiKey),
    apiKeys: () =>
      listApiKeys().map((k) => ({ name: k.name, key: k.key, enabled: k.enabled, expiresAt: k.expiresAt })),
    createApiKey: (opts) => {
      const created = createApiKey(opts);
      return created.success && created.data?.key ? { key: created.data.key } : null;
    },
    ...overrides,
  };
}
