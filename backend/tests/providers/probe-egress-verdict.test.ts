import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import Fastify from 'fastify';
import { loadConfig } from '../../src/config/index.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FinOpsTracker } from '../../src/metrics/finops-tracker.js';
import { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';
import { registerConsoleRoutes } from '../../src/routes/console.js';

/**
 * The console "Test" verdict must carry the egress stamp on a GREEN probe too.
 *
 * Regression: the egress capture used to sit AFTER the inner model loop, but a
 * successful probe exits BOTH loops with `break probes` — skipping the capture.
 * The operator's question ("did my include/exclude split apply to this call?")
 * was answered only when the rotation happened to fall through, never on the
 * success path that matters most. The stamp is now taken the moment the probe
 * answers, before any break.
 *
 * Loopback stays direct by rule (ADR-0018), so the asserted stamp is `direct`
 * — the point is that it is PRESENT on success, not which direction it names.
 */

const PROVIDER = 'egress-probe-test';
const node = {
  options: { baseURL: '', apiKey: 'sk-test' },
  models: {},
};

let upstream: ReturnType<typeof Bun.serve> | null = null;

// The probe route resolves everything through these seams; stub them so the
// test needs no disk, no credential store and no catalog repository.
import { mock } from 'bun:test';

mock.module('../../src/opencode/user-config.js', () => ({
  ROUTER_PROVIDER_ID: 'omnicell-router',
  getProviderNodeById: (id: string) => (id === PROVIDER ? node : undefined),
  getProviderModelDefs: (id: string) => (id === PROVIDER ? { 'm1': {} } : {}),
  expandEnvTemplate: (v: unknown) => v,
  legacyShapedSlotEntries: () => [],
  getOpenCodeConfigPath: () => '<memory>/opencode.jsonc',
}));

mock.module('../../src/opencode/credentials/index.js', () => ({
  getCredentialStore: async () => ({
    resolveKeyChain: () => [],
    listCredentials: () => [],
    resolveKey: () => null,
  }),
  getCredentialStoreStatus: async () => ({ excluded: [] }),
}));

mock.module('../../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => [],
    ensureOcrStore: async () => {},
  },
}));

const config = loadConfig();
const registry = new ProviderRegistry(config, true);
const orchestrator = new PipelineOrchestrator(config, registry, new FinOpsTracker());
const app = Fastify();
registerConsoleRoutes(app, registry, orchestrator);

beforeAll(() => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(JSON.stringify({ id: 'x', choices: [{ message: { content: 'pong' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  node.options.baseURL = `http://127.0.0.1:${upstream.port}/v1`;
});

afterAll(async () => {
  upstream?.stop(true);
  await app.close();
});

describe('console provider test — egress stamp rides the verdict', () => {
  it('a SUCCESSFUL probe reports the egress it took (break probes must not skip the stamp)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/opencode/providers/${PROVIDER}/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // The regression: this field was undefined on the success path because the
    // capture lived after the loop the green verdict breaks out of.
    expect(body.egress).toBe('direct');
  });
});