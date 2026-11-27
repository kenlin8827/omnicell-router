import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProviderNodeById,
  getProviderModelDefs,
  listConfigProviders,
  legacyShapedSlotEntries,
  upsertProviderDef,
  deleteProviderDef,
} from '../../src/opencode/user-config.js';
import { writeProviderDefs, getProviderDefsPath } from '../../src/opencode/provider-defs.js';

/**
 * Provider-shape READ normalization in user-config.ts.
 * OCR truth is `protocols`/`settings`. Client `package`/`settings` lifts into
 * protocols on write; a retired npm/options node is REFUSED from the OCR book
 * rather than passed through.
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

describe('normalizeProviderDef — OCR protocols/settings on read', () => {
  it('lifts client package→protocols and settings→options, carries top-level headers', () => {
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
    expect(def.protocols).toEqual(['openai-chat']);
    expect(def.package).toBeUndefined();
    expect(def.options.baseURL).toBe('https://acme.test/v1');
    expect(def.options.apiKey).toBe('{env:ACME_KEY}');
    expect(def.options.timeoutMs).toBe(30000);
    expect(def.options.headers).toEqual({ 'X-Tenant': 't' });
    expect(def.env).toEqual(['ACME_KEY']);
    expect(def.canonical).toBe('https://acme.test');
    expect(def.body).toEqual({ extra: true });
    expect(def.name).toBe('Acme');
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
    // writeProviderDefs lifts npm→protocols but leaves options; the reader then
    // drops the node for the retired options bag.
    expect(getProviderNodeById('legacy')).toBeUndefined();
    expect(listConfigProviders().map((p) => p.id)).not.toContain('legacy');
    expect(legacyShapedSlotEntries()).toEqual([{ id: 'legacy', paths: ['options'] }]);
  });

  it('a partially migrated def (protocols + retired options) is refused, not merged', () => {
    writeConfig({
      migrating: {
        package: '@opencode/ai/providers/anthropic',
        options: { baseURL: 'https://explicit.test/v1' },
        settings: { baseURL: 'https://ignored.test/v1', temperature: 0.5 },
      },
    });
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
    expect(def.options).toBeUndefined();
    expect(legacyShapedSlotEntries()).toEqual([]);
  });
});

describe('normalizeModelDef — per-model protocol lift', () => {
  it('provider.package→provider.protocols; model settings pass through untouched', () => {
    writeConfig({
      mix: {
        protocols: ['openai-chat'],
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
    expect(defs['opencode v2-model'].provider.protocols).toEqual(['anthropic-messages']);
    expect(defs['opencode v2-model'].provider.package).toBeUndefined();
    expect(defs['opencode v2-model'].settings.reasoningEffort).toBe('high');
    expect(defs['opencode v2-model'].options).toBeUndefined();
    expect(defs['opencode v1-model']).toEqual({
      options: { temperature: 0.9 },
      settings: { effort: 'low' },
      limit: { context: 8000 },
    });
  });
});

describe('management view + write side', () => {
  it('listConfigProviders shows protocols/baseURL/inline-key for OCR defs', () => {
    writeConfig({
      acmev2: {
        name: 'Acme V2',
        package: '@opencode/ai/providers/google',
        settings: { baseURL: 'https://acmev2.test/v1', apiKey: 'sk-inline-secret-1234' },
      },
    });
    const view = listConfigProviders().find((p) => p.id === 'acmev2')!;
    expect(view.protocols).toEqual(['google-gemini']);
    expect(view.baseURL).toBe('https://acmev2.test/v1');
    expect(view.auth.inline).toBe(true);
    expect(view.auth.keyMasked).toContain('••••');
  });

  it('every write lands protocols/settings — package/npm never stored in OCR', () => {
    const file = writeConfig({
      acmev2: { package: '@opencode/ai/providers/google', settings: { baseURL: 'https://acmev2.test/v1' } },
    });
    const res = upsertProviderDef({
      id: 'newprov',
      protocols: ['openai-chat'],
      baseURL: 'https://new.test/v1',
      apiKey: 'sk-x',
      apiKeyInline: true,
    });
    expect(res.success).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.providers.acmev2.protocols).toEqual(['google-gemini']);
    expect(raw.providers.acmev2.package).toBeUndefined();
    expect(raw.providers.acmev2.npm).toBeUndefined();
    expect(raw.providers.newprov.protocols).toEqual(['openai-chat']);
    expect(raw.providers.newprov.settings.apiKey).toBe('sk-x');
    expect(raw.providers.newprov.npm).toBeUndefined();
    expect(raw.providers.newprov.options).toBeUndefined();
    expect(raw.provider).toBeUndefined();
  });

  it('deleteProviderDef removes an OCR-shaped node', () => {
    writeConfig({
      acmev2: { protocols: ['google-gemini'], settings: { baseURL: 'https://acmev2.test/v1' } },
    });
    const res = deleteProviderDef('acmev2');
    expect(res.success).toBe(true);
    expect(getProviderNodeById('acmev2')).toBeUndefined();
  });
});
