import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import {
  PROVIDER_DEFS_IMPORT_VERSION,
  getProviderDefsPath,
  importProviderDefsAtBoot,
  readProviderDefsFile,
  writeProviderDefs,
} from '../src/opencode/provider-defs.js';
import { getOpenCodeConfigPath } from '../src/opencode/user-config.js';
import { opencodeConfigCandidates, resolveDefaultPaths, resolveOpencodeConfigPath } from '../src/opencode/credentials/paths.js';
/**
 * One-shot client→OCR provider import (def-ownership decoupling):
 * <ocrHome>/providers.json receives a verbatim copy of the jsonc
 * `providers` slot; the jsonc file itself is NEVER written; an unparsable
 * source defers the pass (no record); per-id upsert keeps unrelated defs-file
 * ids. Hermetic: XDG_CONFIG_HOME and OCR_HOME both point at the sandbox.
 */

let tmpDir = '';
let oldCfg: string | undefined;
let oldData: string | undefined;
let oldHome: string | undefined;

function configDir(): string {
  return path.join(tmpDir, 'config', 'opencode');
}

function retryRemove(target: string, tries = 6): void {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        /* busy-wait: Windows EBUSY right after writes */
      }
    }
  }
}

function writeJsonc(content: string): string {
  fs.mkdirSync(configDir(), { recursive: true });
  const p = path.join(configDir(), 'opencode.jsonc');
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function resetSandbox(): void {
  retryRemove(getProviderDefsPath());
  retryRemove(configDir());
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-provider-defs-'));
  oldCfg = process.env.XDG_CONFIG_HOME;
  oldData = process.env.XDG_DATA_HOME;
  oldHome = process.env.OCR_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.OCR_HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
});

afterAll(() => {
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  retryRemove(tmpDir);
});

beforeEach(() => {
  resetSandbox();
});

describe('importProviderDefsAtBoot', () => {
  it('ports the providers slot verbatim and leaves opencode.jsonc byte-identical', () => {
    const p = writeJsonc(
      [
        '{',
        '  // hand-written comment must survive on disk',
        '  "model": "x",',
        '  "providers": {',
        '    "zhipu": {',
        '      "name": "Zhipu",',
        '      "package": "@opencode/ai/providers/openai-compatible",',
        '      "settings": { "baseURL": "https://open.bigmodel.cn/api/paas/v4" }',
        '    }',
        '  }',
        '}',
      ].join('\n')
    );
    const before = fs.readFileSync(p);
    expect(getOpenCodeConfigPath()).toBe(p); // the sandbox config is the one addressed

    const rec = importProviderDefsAtBoot();
    expect(rec).toBeDefined();
    expect(rec!.imported).toBe(1);

    const defs = readProviderDefsFile();
    expect(defs).not.toBeNull();
    expect(getProviderDefsPath()).toContain(path.join(tmpDir, 'home')); // OCR-owned book, GLOBAL
    expect(defs!.version).toBe(1);
    expect(defs!.providers['zhipu']).toEqual({
      name: 'Zhipu',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    });
    expect(fs.readFileSync(p).equals(before)).toBe(true); // read-once: never a writer
  });

  it('is ADD-ONLY: an id already in the defs file is never overwritten by the client copy', () => {
    writeProviderDefs({ other: { name: 'Other', package: '@opencode/ai/providers/openai' } });
    writeJsonc(
      '{"providers": { "zhipu": { "name": "Zhipu", "package": "p" }, "other": { "name": "StaleClientCopy", "package": "q" } }}'
    );

    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1); // zhipu only
    expect(rec!.skipped).toBe(1);
    const providers = readProviderDefsFile()!.providers;
    // OCR is the truth after the first port: the client copy cannot reset it.
    expect(providers['other']).toEqual({ name: 'Other', package: '@opencode/ai/providers/openai' });
    expect(providers['zhipu']).toEqual({ name: 'Zhipu', package: 'p' });
  });

  it('v1 machine: translates its native npm/options node into package/settings', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'installed.version'), '1.4.2', 'utf8');
    writeJsonc(
      [
        '{',
        '  "provider": {',
        '    "maisuitx": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "name": "Maisui TX",',
        '      "options": { "baseURL": "https://relay.example/v1", "apiKey": "sk-inline-literal" },',
        '      "models": { "m1": { "name": "M1" } }',
        '    }',
        '  }',
        '}',
      ].join('\n')
    );
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1);
    expect(rec!.converted).toBe(1);
    const node = readProviderDefsFile()!.providers['maisuitx'];
    // The defs file stores the current spelling; a verbatim copy would be dropped.
    expect(node.package).toBe('@opencode/ai/providers/openai-compatible');
    expect(node.npm).toBeUndefined();
    expect(node.options).toBeUndefined();
    expect(node.name).toBe('Maisui TX');
    expect(node.settings).toEqual({ baseURL: 'https://relay.example/v1', apiKey: 'sk-inline-literal' });
    expect(node.models).toEqual({ m1: { name: 'M1' } });
  });

  it('`{env:VAR}` credentials become env names, never a literal key', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'installed.version'), '1.4.2', 'utf8');
    writeJsonc(
      '{"provider": { "relay": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://r.example/v1", "apiKey": "{env:MY_TOKEN}" } } }}'
    );
    importProviderDefsAtBoot();
    const node = readProviderDefsFile()!.providers['relay'];
    expect(node.env).toEqual(['MY_TOKEN']);
    expect(node.settings?.apiKey).toBeUndefined();
  });

  it('a v2 machine never reads the retired singular `provider` slot', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'installed.version'), '2.0.29', 'utf8');
    writeJsonc(
      '{"providers": { "relay": { "package": "canonical-pkg" } }, "provider": { "relic": { "npm": "legacy-pkg", "options": {} } }}'
    );
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1);
    expect(Object.keys(readProviderDefsFile()!.providers)).toEqual(['relay']);
  });

  it('a retired-shaped node in the canonical slot is refused loudly, never half-imported', () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(path.join(configDir(), 'installed.version'), '2.0.29', 'utf8');
    writeJsonc('{"providers": { "relic": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://r.test/v1" } } }}');
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(0);
    expect(rec!.failed).toBe(1);
    expect(readProviderDefsFile()).toBeNull();
  });

  it('records the port version so a newer port re-arms on the next boot', () => {
    writeJsonc('{ "model": "x" }');
    const rec = importProviderDefsAtBoot();
    expect(rec!.version).toBe(PROVIDER_DEFS_IMPORT_VERSION);
  });

  it('missing config completes with imported 0 and creates no defs file', () => {
    const rec = importProviderDefsAtBoot();
    expect(rec).toBeDefined();
    expect(rec!.imported).toBe(0);
    expect(readProviderDefsFile()).toBeNull();
  });

  it('empty providers slot completes with imported 0 and creates no defs file', () => {
    writeJsonc('{ "model": "x" }');
    const rec = importProviderDefsAtBoot();
    expect(rec).toBeDefined();
    expect(rec!.imported).toBe(0);
    expect(readProviderDefsFile()).toBeNull();
  });

  it('unparsable config defers the pass: no record, no defs file', () => {
    writeJsonc('{ corrupt');
    expect(importProviderDefsAtBoot()).toBeUndefined();
    expect(readProviderDefsFile()).toBeNull();
  });

  it('imports the hook-owned omnicell-router node verbatim (the router def is defs truth)', () => {
    writeJsonc(
      '{"providers": { "omnicell-router": { "name": "OmniCellRouter", "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": "http://127.0.0.1:3000/v1", "apiKey": "ocr-local-token" } } }}'
    );
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1);
    const node = readProviderDefsFile()!.providers['omnicell-router'];
    expect(node.settings.baseURL).toBe('http://127.0.0.1:3000/v1');
    expect(node.name).toBe('OmniCellRouter');
  });
});

describe('per-flavor def adapters (the client version decides the slot)', () => {
  it('v1-flavored machine: reads the singular `provider` slot only, ignores `providers`', () => {
    writeJsonc(
      '{"provider": { "v1relay": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://a.example/v1" } } },' +
        ' "providers": { "v2node": { "package": "@opencode/ai/providers/openai" } }}'
    );
    fs.writeFileSync(path.join(tmpDir, 'config', 'opencode', 'installed.version'), '1.4.2', 'utf8');
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1);
    const providers = readProviderDefsFile()!.providers;
    expect(Object.keys(providers)).toEqual(['v1relay']);
    expect(providers['v1relay'].package).toBe('@opencode/ai/providers/openai-compatible');
  });

  it('v2-flavored machine: reads the canonical `providers` slot only, ignores the retired singular slot', () => {
    writeJsonc(
      '{"provider": { "legacyrelay": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://b.example/v1" } } },' +
        ' "providers": { "v2node": { "package": "@opencode/ai/providers/openai" } }}'
    );
    fs.writeFileSync(path.join(tmpDir, 'config', 'opencode', 'installed.version'), '2.0.29', 'utf8');
    const rec = importProviderDefsAtBoot();
    expect(rec!.imported).toBe(1);
    expect(rec!.converted).toBe(0);
    expect(Object.keys(readProviderDefsFile()!.providers)).toEqual(['v2node']);
  });
});

describe('config dir resolution', () => {
  const env = { XDG_CONFIG_HOME: '/xdg', XDG_DATA_HOME: '/data', HOME: '/home' } as const;

  it('defaults to <XDG_CONFIG_HOME>/opencode', () => {
    const paths = resolveDefaultPaths({ ...env }, '/home');
    expect(paths.configDir).toBe(path.join('/xdg', 'opencode'));
    expect(paths.dataDir).toBe(path.join('/data', 'opencode'));
  });

  it('honours OPENCODE_CONFIG_DIR for the config tree only (never the data dir)', () => {
    const paths = resolveDefaultPaths({ ...env, OPENCODE_CONFIG_DIR: '/profiles/opencode2' }, '/home');
    expect(paths.configDir).toBe(path.resolve('/profiles/opencode2'));
    expect(paths.installedVersionPath).toBe(path.join(path.resolve('/profiles/opencode2'), 'installed.version'));
    expect(opencodeConfigCandidates(paths)[0]).toBe(path.join(path.resolve('/profiles/opencode2'), 'opencode.jsonc'));
    // data dir (db / auth.json) is NOT relocated by the config override
    expect(paths.dataDir).toBe(path.join('/data', 'opencode'));
  });

  it('an empty/whitespace override is treated as unset', () => {
    const paths = resolveDefaultPaths({ ...env, OPENCODE_CONFIG_DIR: '   ' }, '/home');
    expect(paths.configDir).toBe(path.join('/xdg', 'opencode'));
  });

  it('resolves the config file inside the overridden tree', () => {
    const dir = path.join(tmpDir, 'profile-tree');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), '{}', 'utf8');
    const paths = resolveDefaultPaths({ ...env, OPENCODE_CONFIG_DIR: dir }, '/home');
    expect(resolveOpencodeConfigPath(paths)).toBe(path.join(dir, 'opencode.jsonc'));
  });
});
