import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Opencode v2 provider-definition READ normalization.
 *
 * Two layers:
 *  1. wireFor/probeKindFor units: `@opencode/ai/providers/<segment>` opencode v2
 *     packages map to the same wire kinds as their `@ai-sdk/*` opencode v1
 *     counterparts; unknown segments are 'unroutable' (exclusion with a
 *     reason, never a crash, never a guessed wire).
 *  2. end-to-end boot through the REAL user-config parser (no user-config
 *     mock): a mixed opencode v1+opencode v2 opencode.jsonc boots — opencode v2 `settings.baseURL`/
 *     top-level `headers`/`package` normalize, model-level
 *     `provider.package` feeds the npm precedence chain, and an unknown opencode v2
 *     package drops its provider with the unroutable reason.
 *
 * The config surface is sandboxed per-test via XDG_* (user-config.test.ts:25-43
 * precedent, restored in afterEach); the credential side uses
 * resetCredentialStoreForTests with injected paths — no env mutation there.
 */

// ---------------------------------------------------------------------------
// 1. wireFor — opencode v2 package forms (pure-function units)
// ---------------------------------------------------------------------------

import { wireFor, unroutableReason } from '../src/providers/wire.js';
import { probeKindFor } from '../src/opencode/probe.js';

describe('wireFor — opencode v2 @opencode/ai/providers/* forms', () => {
  it('maps known v2 package segments to their wire kinds', () => {
    expect(wireFor('@opencode/ai/providers/anthropic')).toBe('anthropic');
    expect(wireFor('@opencode/ai/providers/google')).toBe('google');
    expect(wireFor('@opencode/ai/providers/openai')).toBe('responses');
    expect(wireFor('@opencode/ai/providers/openai-compatible')).toBe('openai');
  });

  it('signing/URL-building v2 segments stay unroutable', () => {
    expect(wireFor('@opencode/ai/providers/azure')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/vertex')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/google-vertex')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/bedrock')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/amazon-bedrock')).toBe('unroutable');
  });

  it('unknown opencode v2 segment → unroutable with a package-shaped reason (never a guess)', () => {
    expect(wireFor('@opencode/ai/providers/mystery')).toBe('unroutable');
    expect(unroutableReason('@opencode/ai/providers/mystery')).toContain('mystery');
    expect(unroutableReason('@opencode/ai/providers/mystery')).toContain('opencode v2 SDK 包名');
    // signing segments keep the classic endpoint-construction/signing wording
    expect(unroutableReason('@opencode/ai/providers/azure')).toContain('签名');
  });

  it('prototype-member segments never masquerade as known wires (security P3-1)', () => {
    // OPENCODE_V2_SEGMENT_WIRES is a plain object — without Object.hasOwn, 'constructor'
    // resolves to Object's constructor function and the store would hand a
    // Function to callers typed as WireKind.
    expect(wireFor('@opencode/ai/providers/constructor')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/toString')).toBe('unroutable');
    expect(wireFor('@opencode/ai/providers/prototype')).toBe('unroutable');
    expect(typeof wireFor('@opencode/ai/providers/constructor')).toBe('string');
  });

  it('internal @ai-sdk/* catalog names still resolve (the reader aliases package→npm)', () => {
    expect(wireFor('@ai-sdk/anthropic')).toBe('anthropic');
    expect(wireFor('@ai-sdk/google')).toBe('google');
    expect(wireFor('@ai-sdk/openai')).toBe('responses');
    expect(wireFor('@ai-sdk/openai-compatible')).toBe('openai');
    expect(wireFor('@ai-sdk/azure')).toBe('unroutable');
    expect(wireFor('some-random-sdk')).toBe('openai'); // legacy heuristic fallback preserved
    expect(wireFor(undefined, 'https://api.anthropic.com')).toBe('anthropic');
  });

  it('probeKindFor delegates to wireFor for BOTH shapes (probe.ts:52-54)', () => {
    expect(probeKindFor('https://v2.example.test/v1', '@opencode/ai/providers/anthropic')).toBe('anthropic');
    expect(probeKindFor('https://v2.example.test/v1', '@opencode/ai/providers/openai-compatible')).toBe('openai');
    expect(probeKindFor('https://v2.example.test/v1', '@ai-sdk/anthropic')).toBe('anthropic');
    expect(probeKindFor('https://v2.example.test/v1', '@opencode/ai/providers/mystery')).toBe('unroutable');
  });
});

// ---------------------------------------------------------------------------
// 2. end-to-end boot with the real JSONC parser
// ---------------------------------------------------------------------------

let catalogRecs: any[] = [];

mock.module('../src/opencode/catalog/repository.js', () => ({
  catalogRepository: {
    list: async () => catalogRecs,
    lastSyncOrigin: 'test',
    ensureOcrStore: async () => {},
  },
}));

mock.module('../src/config/index.js', () => ({
  loadConfig: () => ({ tiers: {}, exclude: [] }),
  saveConfig: () => ({ success: true }),
  getConfigPath: () => '<memory>/config.yaml',
}));

const { buildDirectPool } = await import('../src/providers/boot-direct.js');
const { writeProviderDefs, getProviderDefsPath } = await import('../src/opencode/provider-defs.js');
const { resolveDefaultPaths } = await import('../src/opencode/credentials/paths.js');
const { resetCredentialStoreForTests } = await import('../src/opencode/credentials/factory.js');

function writeJsonc(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

const rec = (id: string, modelIds: string[]) => ({
  id,
  name: id,
  custom: true,
  connected: true,
  api: `https://${id}.test/v1`,
  models: modelIds.map((m) => ({ id: m })),
});

describe('boot-direct — mixed valid / retired-shape nodes in the defs file (real parser)', () => {
  let tmpDir: string;
  let oldConfigHome: string | undefined;
  let oldDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-boot-v2defs-'));
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    catalogRecs = [];
  });

  afterEach(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    resetCredentialStoreForTests();
    fs.rmSync(getProviderDefsPath(), { force: true }); // defs writes go to the shared env sandbox — never leak
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('normalizes v2 defs on read: settings→options, package→npm, headers carried; a retired-shape node is REFUSED', async () => {
    // Three shapes seeded straight into the defs file: a v2 provider, a retired
    // npm/options provider, a v2 unknown package.
    writeProviderDefs(
      JSON.parse(
        JSON.stringify(
        {
          providers: {
            v2prov: {
              name: 'V2 Provider',
              canonical: 'https://v2.example.test/docs',
              package: '@opencode/ai/providers/openai-compatible',
              env: ['V2PROV_TOKEN'],
              settings: { baseURL: 'https://v2.example.test/v1' },
              headers: { 'X-Tenant': 't2' },
              body: { custom: 'ignored-by-internal-model' },
              models: {
                m1: {},
                m2: { provider: { package: '@opencode/ai/providers/anthropic' } },
              },
            },
            v1prov: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'https://v1.example.test/v1', apiKey: 'sk-inline-v1' },
              models: { m4: {} },
            },
            v2unknown: {
              package: '@opencode/ai/providers/mystery',
              settings: { baseURL: 'https://v2u.example.test/v1' },
              models: { m3: {} },
            },
          },
        },
        null,
        2
        )
      ).providers
    );
    writeJsonc(resolveDefaultPaths().authJsonPath, {
      v2prov: { type: 'api', key: 'sk-opencode-v2-store' },
      v2unknown: { type: 'api', key: 'sk-v2u' },
      v1prov: { type: 'api', key: 'sk-opencode-v1-store' },
    });
    // V1-bound: paths resolve to the XDG tmp sandbox set by this harness
    resetCredentialStoreForTests(resolveDefaultPaths(), async () => 'v1.4.6', undefined, { env: {} });
    catalogRecs = [rec('v2prov', ['m1', 'm2']), rec('v1prov', ['m4']), rec('v2unknown', ['m3'])];

    const res = await buildDirectPool();
    const byName = new Map(res.instances.map((i) => [i.name, i]));

    // opencode v2 provider routable from normalized fields
    const v2Instance = byName.get('v2prov');
    expect(v2Instance).toBeDefined();
    expect(v2Instance!.config.baseUrl).toBe('https://v2.example.test/v1'); // settings.baseURL → options.baseURL
    expect(v2Instance!.config.apiKey).toBe('sk-opencode-v2-store'); // store segment (no inline in settings)
    expect(v2Instance!.config.headers).toEqual({ 'X-Tenant': 't2' }); // opencode v2 top-level headers → options.headers
    expect(v2Instance!.wires.sort()).toEqual(['anthropic', 'openai']); // model-level provider.package honored

    // Retired shape: not routed, and not silently either — the drop is reported with
    // the exact offending paths so the operator can migrate the node.
    expect(byName.has('v1prov')).toBe(false);
    const shapeEx = res.excluded.find((e) => e.provider === 'v1prov');
    expect(shapeEx?.reason).toContain('npm, options');
    expect(shapeEx?.reason).toContain('已废弃形状');

    // unknown opencode v2 package: model-level unroutable exclusion + provider drop, no crash
    expect(byName.has('v2unknown')).toBe(false);
    const modelEx = res.excluded.find((e) => e.model === 'v2unknown/m3');
    expect(modelEx).toBeDefined();
    expect(modelEx!.reason).toContain('mystery');
    expect(res.excluded).toContainEqual({
      provider: 'v2unknown',
      reason: '该 provider 全部模型不可直连路由',
    });

    // normalized models entered the routing pool
    const ids = res.models.map((m) => m.id);
    expect(ids).toContain('v2prov/m1');
    expect(ids).toContain('v2prov/m2');
    expect(ids).not.toContain('v1prov/m4'); // retired shape — never enters the pool
    expect(ids).not.toContain('v2unknown/m3');
  });
});
