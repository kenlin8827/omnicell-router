import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProviderNodeById,
  getProviderModelDefs,
  listConfigProviders,
  legacyShapedSlotEntries,
  upsertCustomProvider,
  deleteCustomProvider,
} from '../src/opencode/user-config.js';
import { writeProviderDefs, getProviderDefsPath } from '../src/opencode/provider-defs.js';

/**
 * Provider-shape READ normalization in user-config.ts.
 * The v2 shape `package`/`settings`/`headers`/`env`/`canonical`/`body` normalizes to the
 * internal view (`npm`/`options`); a retired-shape node is REFUSED rather than passed
 * through, using the same guard the writer refuses with — reader and writer accept one shape.
 *
 * XDG sandbox per test (user-config.test.ts:25-43 precedent).
 */

let tmpDir: string;
let oldConfigHome: string | undefined;
let oldDataHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-v2read-'));
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

function writeConfig(node: Record<string, unknown>): string {
  writeProviderDefs(node as Record<string, any>);
  return getProviderDefsPath();
}

describe('normalizeProviderDef — opencode v2 provider shape on read', () => {
  it('maps package→npm and settings→options, carries top-level headers', () => {
    writeConfig({
      acme: {
        name: 'Acme',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'https://acme.test/v1', apiKey: '{env:ACME_KEY}', timeoutMs: 30000 },
        headers: { 'X-Tenant': 't' },
        env: ['ACME_KEY'],
        canonical: 'https://acme.test',
        body: { extra: true },
      },
    });
    const def = getProviderNodeById('acme');
    expect(def.npm).toBe('@opencode/ai/providers/openai-compatible');
    expect(def.options.baseURL).toBe('https://acme.test/v1');
    expect(def.options.apiKey).toBe('{env:ACME_KEY}');
    expect(def.options.timeoutMs).toBe(30000);
    expect(def.options.headers).toEqual({ 'X-Tenant': 't' });
    // informational / no internal slot yet — carried through untouched
    expect(def.env).toEqual(['ACME_KEY']);
    expect(def.canonical).toBe('https://acme.test');
    expect(def.body).toEqual({ extra: true });
    expect(def.name).toBe('Acme');
    // raw settings stay on the def (model path reads settings.reasoningEffort)
    expect(def.settings.baseURL).toBe('https://acme.test/v1');
  });

  it('a retired-shape def is dropped from the slot view and reported', () => {
    const retired = {
      legacy: {
        npm: '@ai-sdk/anthropic',
        options: { baseURL: 'https://legacy.test/v1', apiKey: 'sk-1' },
        models: { 'm-a': { limit: { context: 100 } } },
      },
    };
    writeConfig(retired);
    // Not routed, not normalized — and not silently: the same guard the writer uses
    // names the node and the offending paths (Decision 11).
    expect(getProviderNodeById('legacy')).toBeUndefined();
    expect(listConfigProviders().map((p) => p.id)).not.toContain('legacy');
    expect(legacyShapedSlotEntries()).toEqual([
      { id: 'legacy', paths: ['npm', 'options'] },
    ]);
  });

  it('a partially migrated def (package + retired options) is refused, not merged', () => {
    writeConfig({
      migrating: {
        package: '@opencode/ai/providers/anthropic',
        options: { baseURL: 'https://explicit.test/v1' },
        settings: { baseURL: 'https://ignored.test/v1', temperature: 0.5 },
      },
    });
    // opencode decodes this node against the v2 schema; a retired key inside it makes
    // the WHOLE node invalid. OCR matches: refuse and tell, never guess a merge.
    expect(getProviderNodeById('migrating')).toBeUndefined();
    expect(legacyShapedSlotEntries()).toEqual([{ id: 'migrating', paths: ['options'] }]);
  });

  it('`env`/`headers` alone do NOT trigger normalization, but are not a retired shape either', () => {
    writeConfig({
      bare: {
        baseURL: 'https://h.test/v1',
        headers: { 'X-Only': '1' },
        env: ['SOMETHING'],
      },
    });
    const def = getProviderNodeById('bare');
    expect(def.options).toBeUndefined(); // no package/settings → no v2 aliasing applied
    expect(legacyShapedSlotEntries()).toEqual([]); // nothing retired about it
  });
});

describe('normalizeModelDef — per-model opencode v2 fields', () => {
  it('provider.package→provider.npm; opencode v1 model slots (settings/options) pass through untouched', () => {
    writeConfig({
      mix: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'https://mix.test/v1' },
        models: {
          'opencode v2-model': {
            provider: { package: '@opencode/ai/providers/anthropic' },
            settings: { reasoningEffort: 'high' },
          },
          'opencode v1-model': { options: { temperature: 0.9 }, settings: { effort: 'low' }, limit: { context: 8000 } },
        },
      },
    });
    const defs = getProviderModelDefs('mix')!;
    expect(defs['opencode v2-model'].provider.npm).toBe('@opencode/ai/providers/anthropic');
    // boot reads the RAW settings slot for defaultEffort — settings is the
    // opencode v1 model-level slot name too, so normalization must not overlay it.
    expect(defs['opencode v2-model'].settings.reasoningEffort).toBe('high');
    expect(defs['opencode v2-model'].options).toBeUndefined();
    // opencode v1 model untouched, byte-identical
    expect(defs['opencode v1-model']).toEqual({ options: { temperature: 0.9 }, settings: { effort: 'low' }, limit: { context: 8000 } });
  });
});

describe('management view + write side', () => {
  it('listConfigProviders shows normalized npm/baseURL/inline-key for opencode v2 ', () => {
    writeConfig({
      acmev2: {
        name: 'Acme V2',
        package: '@opencode/ai/providers/google',
        settings: { baseURL: 'https://acmev2.test/v1', apiKey: 'sk-inline-secret-1234' },
      },
    });
    const view = listConfigProviders().find((p) => p.id === 'acmev2')!;
    expect(view.npm).toBe('@opencode/ai/providers/google');
    expect(view.baseURL).toBe('https://acmev2.test/v1');
    expect(view.auth.inline).toBe(true);
    expect(view.auth.keyMasked).toContain('••••');
  });

  it('every write lands in the native slot in the v2 shape — the legacy spelling is gone', () => {
    const file = writeConfig({
      acmev2: { package: '@opencode/ai/providers/google', settings: { baseURL: 'https://acmev2.test/v1' } },
    });
    const res = upsertCustomProvider({
      id: 'newprov',
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://new.test/v1',
      apiKey: 'sk-x',
      apiKeyInline: true,
    });
    expect(res.success).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The untouched neighbor keeps its bytes.
    expect(raw.providers.acmev2.package).toBe('@opencode/ai/providers/google');
    expect(raw.providers.acmev2.npm).toBeUndefined();
    // The new node: v2 shape, native slot, npm mapped to a v2 package.
    expect(raw.providers.newprov.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(raw.providers.newprov.settings.apiKey).toBe('sk-x');
    expect(raw.providers.newprov.npm).toBeUndefined();
    expect(raw.providers.newprov.options).toBeUndefined();
    // No legacy slot is ever created.
    expect(raw.provider).toBeUndefined();
  });

  it('deleteCustomProvider removes a opencode-v2 shaped node (jsonPath addresses ids, not shapes)', () => {
    writeConfig({
      acmev2: { package: '@opencode/ai/providers/google', settings: { baseURL: 'https://acmev2.test/v1' } },
    });
    const res = deleteCustomProvider('acmev2');
    expect(res.success).toBe(true);
    expect(getProviderNodeById('acmev2')).toBeUndefined();
  });
});
