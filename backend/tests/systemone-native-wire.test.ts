import { afterAll, describe, expect, test } from 'bun:test';
import { serve, type Server } from 'bun';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wireFor } from '../src/providers/wire.js';
import { probeKindFor } from '../src/opencode/probe.js';
import { opencodeV2PackageFor } from '../src/opencode/user-config.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { RouterConfig, ModelRegistration } from '../src/config/types.js';
import { runSystemoneDecision } from '../src/protocols/systemone/decide.js';
import { __resetEnvResolutionForTests } from '../src/config/env.js';

// ---------------------------------------------------------------------------
// Isolation: the registry re-reads disk config for tier policies; point
// OCR_HOME at a throwaway sandbox like the other registry-touching tests.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-systemone-native-'));
process.env.OCR_HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.OCR_HOME, { recursive: true });
process.chdir(sandbox);
__resetEnvResolutionForTests();

afterAll(() => {
  process.chdir(originalCwd);
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// npm → wire vocabulary: @ai-sdk/typesafe-ai and the opencode v2 segment
// 'typesafe' both resolve to wire 'systemone' (ADR-0008 §7).
// ---------------------------------------------------------------------------
describe('typesafe npm → systemone wire', () => {
  test('@ai-sdk/typesafe-ai resolves to the decision wire', () => {
    expect(wireFor('@ai-sdk/typesafe-ai')).toBe('systemone');
    expect(wireFor('@AI-SDK/TypeSafe-AI')).toBe('systemone');
  });

  test('opencode v2 segment typesafe resolves to the decision wire', () => {
    expect(wireFor('@opencode/ai/providers/typesafe')).toBe('systemone');
    expect(wireFor('@opencode/ai/providers/unknown-segment')).toBe('unroutable');
  });

  test('the v2 write side maps the npm onto the same segment the read side knows', () => {
    expect(opencodeV2PackageFor('@ai-sdk/typesafe-ai')).toBe('@opencode/ai/providers/typesafe');
    expect(wireFor(opencodeV2PackageFor('@ai-sdk/typesafe-ai'))).toBe('systemone');
  });

  test('the console probe infers the same wire (test ≡ inference)', () => {
    expect(probeKindFor(undefined, '@ai-sdk/typesafe-ai')).toBe('systemone');
  });
});

// ---------------------------------------------------------------------------
// Pool discipline: decision-wire models never enter a chat pool, but the
// decision surface's explicit opt-in sees them.
// ---------------------------------------------------------------------------
describe('decision-wire pool exclusion', () => {
  const model: ModelRegistration = {
    id: 'ts/d1',
    provider: 'ts',
    upstreamModel: 'd1',
    tier: 'lite',
    wire: 'systemone',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };

  function makeRegistry(): ProviderRegistry {
    const config = {
      port: 3000,
      host: '127.0.0.1',
      fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
      circuitBreaker: { enabled: false },
      models: [model],
      tiers: { lite: { members: [{ pattern: 'ts/*' }] } },
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, false);
    registry.setAutoRefreshTierMatch(false);
    return registry;
  }

  test('chat pools exclude the decision wire; the decision surface opt-in includes it', () => {
    const registry = makeRegistry();
    expect(registry.getCandidateModelsForTier('lite', false)).toHaveLength(0);
    const decisionPool = registry.getCandidateModelsForTier('lite', false, { decisionSurface: true });
    expect(decisionPool.map((m) => m.id)).toEqual(['ts/d1']);
  });

  test('chat dispatch on a decision-wire model fails honestly, never guesses a wire', async () => {
    // The constructor path (providerConfigs with type 'systemone') registers
    // the honest placeholder — no chat executor is invented for the wire.
    const config = {
      port: 3000,
      host: '127.0.0.1',
      fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
      circuitBreaker: { enabled: false },
      models: [model],
      tiers: { lite: { members: [{ pattern: 'ts/*' }] } },
    } as unknown as RouterConfig;
    const registry = new ProviderRegistry(config, false, [
      { name: 'ts', type: 'systemone', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk' },
    ]);
    registry.setAutoRefreshTierMatch(false);
    registry.registerModel(model);
    await expect(
      registry.execute({ model: 'ts/d1', messages: [] } as any, model)
    ).rejects.toThrow(/decision wire/);
  });
});

// ---------------------------------------------------------------------------
// Native passthrough: the client's decision body rides verbatim to
// POST {base}/systemone with the chain-head Bearer credential and the model
// id rewritten to upstreamModel; the vendor answer passes through unmodified
// and upstreamKind is 'native'.
// ---------------------------------------------------------------------------
describe('native systemone passthrough', () => {
  let server: Server;
  let lastRequest: { url: string; auth?: string; betaHeader?: string | null; body: any } | undefined;

  const vendorResponse = {
    model: 'd1',
    answers: { q: { type: 'noul', noul: 0.7 } },
    usage: { input_tokens: 3, output_tokens: 1 },
  };

  afterAll(() => {
    server?.stop(true);
  });

  const model: ModelRegistration = {
    id: 'ts/d1',
    provider: 'ts',
    upstreamModel: 'd1',
    tier: 'lite',
    wire: 'systemone',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };

  function registryAgainst(baseUrl: string): ProviderRegistry {
    const config = {
      port: 3000,
      host: '127.0.0.1',
      fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
      circuitBreaker: { enabled: false },
      models: [model],
      tiers: {},
    } as unknown as RouterConfig;
    // The BOOT path feeds the provider config through registerProvider (not
    // the constructor) — the native limb reads baseUrl + custom headers from
    // exactly this registration, so the test mirrors it.
    const registry = new ProviderRegistry(config, false);
    registry.registerProvider('ts', {
      name: 'ts',
      createCompletion: async () => {
        throw new Error('chat must never reach a decision-wire provider');
      },
    }, [{ key: 'sk-chain-head', keyHashPrefix: 'sk-ch', label: 'head' }], {
      name: 'ts',
      type: 'systemone',
      baseUrl,
      apiKey: 'sk-test-key',
      headers: { 'ark-beta-systemone-api': 'true' },
    });
    registry.registerModel(model);
    return registry;
  }

  test('body, auth and model rewrite ride the vendor wire; answer passes through', async () => {
    server = serve({
      port: 0,
      fetch: async (req) => {
        lastRequest = {
          url: req.url,
          auth: req.headers.get('authorization'),
          betaHeader: req.headers.get('ark-beta-systemone-api'),
          body: await req.json(),
        };
        return Response.json(vendorResponse);
      },
    });
    const registry = registryAgainst(`http://127.0.0.1:${server.port}/v1`);
    const decision = await runSystemoneDecision(
      registry,
      { model: 'ts/d1', state: 'the state', questions: { q: { type: 'noul' } } },
      model
    );
    expect(decision.upstreamKind).toBe('native');
    expect(lastRequest?.url).toBe(`http://127.0.0.1:${server.port}/v1/systemone`);
    expect(lastRequest?.auth).toBe('Bearer sk-chain-head');
    expect(lastRequest?.betaHeader).toBe('true'); // def custom headers ride the native call
    expect(lastRequest?.body.model).toBe('d1'); // rewritten to upstreamModel
    expect(lastRequest?.body.state).toBe('the state');
    expect(lastRequest?.body.questions).toEqual({ q: { type: 'noul' } });
    expect(decision.response).toEqual(vendorResponse); // verbatim passthrough
  });

  test('a non-2xx vendor head surfaces as an UpstreamError with the vendor status', async () => {
    server = serve({
      port: 0,
      fetch: () => Response.json({ message: 'bad model' }, { status: 404 }),
    });
    const registry = registryAgainst(`http://127.0.0.1:${server.port}/v1`);
    try {
      await runSystemoneDecision(registry, { model: 'ts/d1', state: 's' }, model);
      throw new Error('expected the call to fail');
    } catch (err: any) {
      expect(err.status).toBe(404);
      expect(String(err.message)).toContain('bad model');
    }
  });
});
