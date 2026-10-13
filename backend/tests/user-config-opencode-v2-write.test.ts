import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProviderNodeById,
  getProviderModelDefs,
  upsertCustomProvider,
  upsertProviderModel,
  opencodeV2PackageFor,
  getOpenCodeConfigPath,
  getOpenCodeAuthPath,
} from '../src/opencode/user-config.js';
import { wireFor } from '../src/providers/wire.js';

/**
 * ADR-0019 P4 + Decision 11 — provider-definition WRITES.
 * upsertCustomProvider emits exactly one shape: the v2 node (package/settings/headers/
 * env/canonical/body) into opencode's native `providers` slot. There is no second
 * generation to select and no legacy npm/options emission left; requests that carry a
 * legacy-shaped node are refused, not converted. Fixtures follow user-config-v2-read.test.ts:
 * per-test XDG_* sandbox, raw-file assertions (text level) + normalized read-back assertions.
 */

let tmpDir: string;
let oldConfigHome: string | undefined;
let oldDataHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-v2write-'));
  oldConfigHome = process.env.XDG_CONFIG_HOME;
  oldDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
});

afterEach(() => {
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function writeConfig(text: string): string {
  const file = getOpenCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function parseJsonc(raw: string): any {
  // comment-stripping parse (user-config.test.ts:96 precedent — line comments only)
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

describe('upsertCustomProvider — opencode v2 shape emission', () => {
  it('writes package/settings/headers/env — no npm/options slots, no auth.json', () => {
    const file = writeConfig('{}');
    const res = upsertCustomProvider({
      id: 'acme',
      name: 'Acme',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://acme.test/v1',
      apiKey: '{env:ACME_TOKEN}',
      apiKeyInline: true,
      headers: { 'X-Tenant': 't' },
      options: { timeoutMs: 30000 },
      models: { 'm-1': { limit: { context: 128000 } } },
      generation: 'opencode-v2',
    });
    expect(res.success).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    const node = parseJsonc(raw).providers.acme;
    expect(node.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(node.settings).toEqual({ baseURL: 'https://acme.test/v1', timeoutMs: 30000 });
    expect(node.headers).toEqual({ 'X-Tenant': 't' });
    expect(node.env).toEqual(['ACME_TOKEN']);
    expect(node.name).toBe('Acme');
    expect(node.models['m-1']).toEqual({ limit: { context: 128000 } });
    // opencode-v1-only slots never appear
    expect(node.npm).toBeUndefined();
    expect(node.options).toBeUndefined();
    // {env:X} translated to env:["X"], the fake inline key dropped (task test c)
    expect(node.settings.apiKey).toBeUndefined();
    expect(raw).not.toContain('{env:');
    expect(fs.existsSync(getOpenCodeAuthPath())).toBe(false);
  });

  it('preserves JSONC comments and sibling bytes — text-level edit, not a rewrite (task test a)', () => {
    const file = writeConfig(
      [
        '{',
        '  // Top comment: keep me!',
        '  "providers": {',
        '    // headroom proxy, tuned by hand',
        '    "headroom": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "http://127.0.0.1:8787/v1" }',
        '    }',
        '  }',
        '}',
      ].join('\n')
    );
    const res = upsertCustomProvider({
      id: 'acmev2',
      npm: '@ai-sdk/anthropic',
      baseURL: 'https://acme.test/v1',
      generation: 'opencode-v2',
    });
    expect(res.success).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('// Top comment: keep me!');
    expect(raw).toContain('// headroom proxy, tuned by hand');
    // untouched sibling keeps its exact opencode v1 bytes
    expect(raw).toContain('"options": { "baseURL": "http://127.0.0.1:8787/v1" }');
    const parsed = parseJsonc(raw);
    expect(parsed.providers.acmev2.package).toBe('@opencode/ai/providers/anthropic');
    expect(parsed.providers.acmev2.settings.baseURL).toBe('https://acme.test/v1');
    expect(parsed.providers.headroom.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('refuses apiKey without apiKeyInline — no secret in jsonc, no auth.json write (task test b)', () => {
    const file = writeConfig('{}');
    const res = upsertCustomProvider({
      id: 'acme',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-live-secret-0001',
      apiKeyInline: false,
      generation: 'opencode-v2',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('credential store');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-live-secret-0001');
    expect(parseJsonc(raw).provider?.acme).toBeUndefined();
    expect(fs.existsSync(getOpenCodeAuthPath())).toBe(false);
  });

  it('explicit apiKeyInline=true opts the literal INTO settings.apiKey (and nowhere else)', () => {
    const file = writeConfig('{}');
    const res = upsertCustomProvider({
      id: 'acme',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-explicit-inline-2',
      apiKeyInline: true,
      generation: 'opencode-v2',
    });
    expect(res.success).toBe(true);
    const node = parseJsonc(fs.readFileSync(file, 'utf8')).providers.acme;
    expect(node.settings.apiKey).toBe('sk-explicit-inline-2');
    expect(fs.existsSync(getOpenCodeAuthPath())).toBe(false);
  });

  it('options passthrough: template apiKey → env translation, literal apiKey preserved, headers hoisted', () => {
    const file = writeConfig('{}');
    upsertCustomProvider({
      id: 'tpl',
      baseURL: 'https://tpl.test/v1',
      options: { apiKey: '{env:LEGACY_TOKEN}', timeoutMs: 5 },
      generation: 'opencode-v2',
    });
    upsertCustomProvider({
      id: 'lit',
      baseURL: 'https://lit.test/v1',
      options: { apiKey: 'sk-existing-inline', headers: { 'X-From': 'options' } },
      generation: 'opencode-v2',
    });
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    // migration NEVER drops an inline credential already living in the file,
    // but a {env:X} string is translated to the opencode v2 env declaration.
    expect(parsed.providers.tpl.env).toEqual(['LEGACY_TOKEN']);
    expect(parsed.providers.tpl.settings.apiKey).toBeUndefined();
    expect(parsed.providers.tpl.settings.timeoutMs).toBe(5);
    expect(parsed.providers.lit.settings.apiKey).toBe('sk-existing-inline');
    expect(parsed.providers.lit.headers).toEqual({ 'X-From': 'options' });
    expect(parsed.providers.lit.settings.headers).toBeUndefined();
  });

  it('emits canonical/env/body opencode v2 slots and models provider.npm→provider.package (reverse of normalizeModelDef)', () => {
    const file = writeConfig('{}');
    const res = upsertCustomProvider({
      id: 'acme',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://acme.test/v1',
      env: ['FOO_TOKEN', 'bad name!'],
      canonical: 'openai',
      body: { stream_options: { include_usage: true } },
      models: {
        'm1': { provider: { npm: '@ai-sdk/anthropic' }, limit: { context: 1 } },
        'm2': { provider: { package: '@opencode/ai/providers/anthropic' } },
        'm3': { name: 'Plain' },
      },
      generation: 'opencode-v2',
    });
    expect(res.success).toBe(true);
    const node = parseJsonc(fs.readFileSync(file, 'utf8')).providers.acme;
    expect(node.canonical).toBe('openai');
    expect(node.env).toEqual(['FOO_TOKEN']); // invalid names filtered
    expect(node.body).toEqual({ stream_options: { include_usage: true } });
    expect(node.models.m1.provider).toEqual({ package: '@opencode/ai/providers/anthropic' });
    expect(node.models.m2.provider).toEqual({ package: '@opencode/ai/providers/anthropic' });
    expect(node.models.m3).toEqual({ name: 'Plain' });
  });

  it('round-trip through the P1 reader: normalized opencode v2 view == equivalent opencode v1 view', () => {
    writeConfig('{}');
    const common = {
      name: 'Eq',
      baseURL: 'https://eq.test/v1',
      headers: { 'X-T': '1' },
      models: { m1: { provider: { npm: '@ai-sdk/anthropic' } } },
    };
    const r1 = upsertCustomProvider({ id: 'eq1', ...common, npm: '@ai-sdk/openai-compatible', generation: 'opencode-v1' });
    const r2 = upsertCustomProvider({
      id: 'eq2',
      ...common,
      npm: '@ai-sdk/openai-compatible', // writer maps it to the opencode v2 compatible-runtime package
      generation: 'opencode-v2',
    });
    expect(r1.success && r2.success).toBe(true);
    const d1 = getProviderNodeById('eq1');
    const d2 = getProviderNodeById('eq2');
    // getProviderNodeById normalizes opencode v2 → internal view: both must agree on
    // every slot boot reads (npm/baseURL/headers), the two shapes converge.
    expect(d2.npm).toBe('@opencode/ai/providers/openai-compatible');
    expect(d2.options.baseURL).toBe(d1.options.baseURL);
    expect(d2.options.headers).toEqual(d1.options.headers);
    expect(wireFor(d1.npm)).toBe(wireFor(d2.npm));
    const m1 = getProviderModelDefs('eq1')!.m1;
    const m2 = getProviderModelDefs('eq2')!.m1;
    expect(m2.provider.npm).toBe('@opencode/ai/providers/anthropic'); // normalizeModelDef reverses the write; opencodeV2PackageFor mapped the value
    expect(wireFor(m2.provider.npm)).toBe(wireFor(m1.provider.npm)); // boot consumes it through wireFor — same wire both shapes
  });
});

describe('upsertProviderModel — model defs are the current v2 FILE shape, not refused', () => {
  // Regression: an earlier model-level gate flagged flat snake_case cost cache keys
  // (and keyed variants / provider.npm) as 'legacy-shaped' and refused the write —
  // every cache-priced model (e.g. glm-4.5) failed pull and editor save. Verified
  // against opencode v2.0.15's embedded config decoder: this IS the file spelling;
  // the nested/array forms are opencode's internal domain shape only.
  it('writes flat cost cache keys, keyed variants, and model provider.npm verbatim', () => {
    writeConfig(
      '{"providers":{"zhipu":{"package":"@opencode/ai/providers/openai-compatible","settings":{"baseURL":"https://z.test/v1"}}}}'
    );
    const res = upsertProviderModel('zhipu', 'glm-4.5', {
      name: 'glm-4.5',
      cost: { input: 0.6, output: 1.8, cache_read: 0.13 },
      variants: { fast: { reasoningEffort: 'low' } },
      provider: { npm: '@ai-sdk/openai-compatible' },
    });
    expect(res.success).toBe(true);
    const model = parseJsonc(fs.readFileSync(getOpenCodeConfigPath(), 'utf8')).providers.zhipu.models['glm-4.5'];
    expect(model.cost).toEqual({ input: 0.6, output: 1.8, cache_read: 0.13 });
    expect(model.variants).toEqual({ fast: { reasoningEffort: 'low' } });
    expect(model.provider).toEqual({ npm: '@ai-sdk/openai-compatible' });
  });
});

describe('opencodeV2PackageFor — the write-side package vocabulary', () => {
  // Task test (e) is really the PARITY claim: every mapped opencode v2 package must
  // resolve to the SAME wire as the opencode v1 npm it replaced (wireFor is the shared
  // decision function used by boot-direct and probe.probeKindFor alike).
  const PAIRS: [string, string][] = [
    ['@ai-sdk/openai-compatible', '@opencode/ai/providers/openai-compatible'],
    ['@ai-sdk/openai', '@opencode/ai/providers/openai'],
    ['@ai-sdk/anthropic', '@opencode/ai/providers/anthropic'],
    ['@ai-sdk/google', '@opencode/ai/providers/google'],
    ['@ai-sdk/azure', '@opencode/ai/providers/azure'],
    ['@ai-sdk/vertex', '@opencode/ai/providers/vertex'],
    ['@ai-sdk/google-vertex', '@opencode/ai/providers/google-vertex'],
    ['@ai-sdk/bedrock', '@opencode/ai/providers/bedrock'],
    ['@ai-sdk/amazon-bedrock', '@opencode/ai/providers/amazon-bedrock'],
  ];

  it('maps each known opencode v1 npm to its read-side opencode v2 package with wire parity', () => {
    for (const [legacyNpm, aiPackage] of PAIRS) {
      expect(opencodeV2PackageFor(legacyNpm)).toBe(aiPackage);
      expect(wireFor(aiPackage)).toBe(wireFor(legacyNpm));
    }
  });

  it('passes already-v2 packages and unknown npm strings through verbatim', () => {
    expect(opencodeV2PackageFor('@opencode/ai/providers/openai-compatible')).toBe(
      '@opencode/ai/providers/openai-compatible'
    );
    // Unmapped: never fabricate an unprobed opencode v2 segment — the opencode v1 string keeps
    // resolving through the classic heuristic (mistral → openai wire).
    expect(opencodeV2PackageFor('@ai-sdk/mistral')).toBe('@ai-sdk/mistral');
    expect(wireFor(opencodeV2PackageFor('@ai-sdk/mistral'))).toBe(wireFor('@ai-sdk/mistral'));
    expect(opencodeV2PackageFor('@ai-sdk/mantle-sdk')).toBe('@ai-sdk/mantle-sdk');
  });
});

