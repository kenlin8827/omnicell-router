import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProviderNodeById,
  getProviderModelDefs,
  upsertProviderDef,
  upsertProviderModel,
} from '../../src/opencode/user-config.js';
import { resolveDefaultPaths } from '../../src/opencode/credentials/paths.js';
import { readProviderDefsFile, writeProviderDefs, getProviderDefsPath } from '../../src/opencode/provider-defs.js';
import { wireFor } from '../../src/providers/wire.js';

/**
 * Provider-definition WRITES.
 * upsertProviderDef emits exactly one shape: the OCR node (protocols/settings/
 * headers/env/canonical/body) into the defs file's `providers` slot. The retired
 * singular protocol spellings (npm/package/protocol) and the opencode-v1 options
 * bag are refused, not converted. Fixtures follow user-config-v2-read.test.ts:
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
  fs.rmSync(getProviderDefsPath(), { force: true });
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
  // The defs file replaced opencode.jsonc: tests still speak "providers map"
  // payloads, so unwrap the envelope and seed the defs store.
  writeProviderDefs(JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')).providers ?? {});
  return getProviderDefsPath();
}

function readRaw(): any {
  // Same surface the old jsonc reads had: { providers: {...} }
  return { providers: readProviderDefsFile()?.providers ?? {} };
}

describe('upsertProviderDef — opencode v2 shape emission', () => {
  it('writes protocols/settings/headers/env — no npm/package/options slots, no auth.json', () => {
    const file = writeConfig('{}');
    const res = upsertProviderDef({
      id: 'acme',
      name: 'Acme',
      protocols: ['@ai-sdk/openai-compatible'],
      baseURL: 'https://acme.test/v1',
      apiKey: '{env:ACME_TOKEN}',
      apiKeyInline: true,
      headers: { 'X-Tenant': 't' },
      options: { timeoutMs: 30000 },
      models: { 'm-1': { limit: { context: 128000 } } },
    });
    expect(res.success).toBe(true);
    const node = readRaw().providers.acme;
    expect(node.protocols).toEqual(['openai-chat']);
    expect(node.settings).toEqual({ baseURL: 'https://acme.test/v1', timeoutMs: 30000 });
    expect(node.headers).toEqual({ 'X-Tenant': 't' });
    expect(node.env).toEqual(['ACME_TOKEN']);
    expect(node.name).toBe('Acme');
    expect(node.models['m-1']).toEqual({ limit: { context: 128000 } });
    // retired singular slots never appear
    expect(node.npm).toBeUndefined();
    expect(node.package).toBeUndefined();
    expect(node.protocol).toBeUndefined();
    expect(node.options).toBeUndefined();
    // {env:X} translated to env:["X"], the fake inline key dropped (task test c)
    expect(node.settings.apiKey).toBeUndefined();
    expect(JSON.stringify(node)).not.toContain('{env:');
    expect(fs.existsSync(resolveDefaultPaths().authJsonPath)).toBe(false);
  });

  it('preserves sibling defs map-level — the defs file is pure JSON (jsonc byte semantics died with the jsonc truth)', () => {
    writeConfig(
      JSON.stringify({
        providers: {
          headroom: {
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: 'http://127.0.0.1:8787/v1' },
          },
        },
      })
    );
    const res = upsertProviderDef({
      id: 'acmev2',
      protocols: ['@ai-sdk/anthropic'],
      baseURL: 'https://acme.test/v1',
    });
    expect(res.success).toBe(true);
    const parsed = readRaw();
    expect(parsed.providers.acmev2.protocols).toEqual(['anthropic-messages']);
    expect(parsed.providers.acmev2.settings.baseURL).toBe('https://acme.test/v1');
    // the untouched sibling is preserved structurally, with its retired client
    // package normalized to the OCR protocol id
    expect(parsed.providers.headroom).toEqual({
      protocols: ['openai-chat'],
      settings: { baseURL: 'http://127.0.0.1:8787/v1' },
    });
  });

  it('refuses apiKey without apiKeyInline — no secret in jsonc, no auth.json write (task test b)', () => {
    const file = writeConfig('{}');
    const res = upsertProviderDef({
      id: 'acme',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-live-secret-0001',
      apiKeyInline: false,
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('credential store');
    expect(JSON.stringify(readProviderDefsFile() ?? {})).not.toContain('sk-live-secret-0001');
    expect(readRaw().providers.acme).toBeUndefined();
    expect(fs.existsSync(resolveDefaultPaths().authJsonPath)).toBe(false);
  });

  it('explicit apiKeyInline=true opts the literal INTO settings.apiKey (and nowhere else)', () => {
    const file = writeConfig('{}');
    const res = upsertProviderDef({
      id: 'acme',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-explicit-inline-2',
      apiKeyInline: true,
    });
    expect(res.success).toBe(true);
    const node = readRaw().providers.acme;
    expect(node.settings.apiKey).toBe('sk-explicit-inline-2');
    expect(fs.existsSync(resolveDefaultPaths().authJsonPath)).toBe(false);
  });

  it('options passthrough: template apiKey → env translation, literal apiKey preserved, headers hoisted', () => {
    const file = writeConfig('{}');
    upsertProviderDef({
      id: 'tpl',
      baseURL: 'https://tpl.test/v1',
      options: { apiKey: '{env:LEGACY_TOKEN}', timeoutMs: 5 },
    });
    upsertProviderDef({
      id: 'lit',
      baseURL: 'https://lit.test/v1',
      options: { apiKey: 'sk-existing-inline', headers: { 'X-From': 'options' } },
    });
    const parsed = readRaw();
    // migration NEVER drops an inline credential already living in the file,
    // but a {env:X} string is translated to the opencode v2 env declaration.
    expect(parsed.providers.tpl.env).toEqual(['LEGACY_TOKEN']);
    expect(parsed.providers.tpl.settings.apiKey).toBeUndefined();
    expect(parsed.providers.tpl.settings.timeoutMs).toBe(5);
    expect(parsed.providers.lit.settings.apiKey).toBe('sk-existing-inline');
    expect(parsed.providers.lit.headers).toEqual({ 'X-From': 'options' });
    expect(parsed.providers.lit.settings.headers).toBeUndefined();
  });

  it('emits canonical/env/body and model provider protocols — no npm/package remains', () => {
    const file = writeConfig('{}');
    const res = upsertProviderDef({
      id: 'acme',
      protocols: ['@ai-sdk/openai-compatible'],
      baseURL: 'https://acme.test/v1',
      env: ['FOO_TOKEN', 'bad name!'],
      canonical: 'openai',
      body: { stream_options: { include_usage: true } },
      models: {
        'm1': { provider: { npm: '@ai-sdk/anthropic' }, limit: { context: 1 } },
        'm2': { provider: { package: '@opencode/ai/providers/anthropic' } },
        'm3': { name: 'Plain' },
      },
    });
    expect(res.success).toBe(true);
    const node = readRaw().providers.acme;
    expect(node.canonical).toBe('openai');
    expect(node.env).toEqual(['FOO_TOKEN']); // invalid names filtered
    expect(node.body).toEqual({ stream_options: { include_usage: true } });
    expect(node.models.m1.provider).toEqual({ protocols: ['anthropic-messages'] });
    expect(node.models.m2.provider).toEqual({ protocols: ['anthropic-messages'] });
    expect(node.models.m3).toEqual({ name: 'Plain' });
  });

  it('round-trip through the P1 reader: the normalized def view converges on protocols', () => {
    writeConfig('{}');
    const common = {
      name: 'Eq',
      baseURL: 'https://eq.test/v1',
      headers: { 'X-T': '1' },
      models: { m1: { provider: { npm: '@ai-sdk/anthropic' } } },
    };
    const r1 = upsertProviderDef({ id: 'eq1', ...common, protocols: ['@ai-sdk/openai-compatible'] });
    const r2 = upsertProviderDef({ id: 'eq2', ...common, protocols: ['@ai-sdk/openai-compatible'] });
    expect(r1.success && r2.success).toBe(true);
    const d1 = getProviderNodeById('eq1');
    const d2 = getProviderNodeById('eq2');
    // getProviderNodeById normalizes to the internal view: both must agree on
    // every slot boot reads (protocols/baseURL/headers).
    expect(d2.protocols).toEqual(['openai-chat']);
    expect(d2.options.baseURL).toBe(d1.options.baseURL);
    expect(d2.options.headers).toEqual(d1.options.headers);
    expect(wireFor(d1.protocols[0])).toBe(wireFor(d2.protocols[0]));
    const m1 = getProviderModelDefs('eq1')!.m1;
    const m2 = getProviderModelDefs('eq2')!.m1;
    expect(m2.provider.protocols).toEqual(['anthropic-messages']); // normalizeModelDef reverses the write; the protocol id round-trips verbatim
    expect(wireFor(m2.provider.protocols[0])).toBe(wireFor(m1.provider.protocols[0])); // boot consumes it through wireFor — same wire both shapes
  });
});

describe('upsertProviderModel — model defs are accepted, protocol slots normalized', () => {
  // Regression: an earlier model-level gate flagged flat snake_case cost cache keys
  // (and keyed variants / provider.npm) as 'legacy-shaped' and refused the write —
  // every cache-priced model (e.g. glm-4.5) failed pull and editor save. Verified
  // against opencode v2.0.15's embedded config decoder: this IS the file spelling;
  // the nested/array forms are opencode's internal domain shape only.
  it('writes flat cost cache keys and keyed variants; provider.npm becomes protocols[]', () => {
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
    const model = readRaw().providers.zhipu.models['glm-4.5'];
    expect(model.cost).toEqual({ input: 0.6, output: 1.8, cache_read: 0.13 });
    expect(model.variants).toEqual({ fast: { reasoningEffort: 'low' } });
    expect(model.provider).toEqual({ protocols: ['openai-chat'] });
  });
});
