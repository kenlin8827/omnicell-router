import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import {
  getProviderDefsPath,
  migrateJsoncProviderDefs,
  readProviderDefsFile,
  writeProviderDefs,
} from '../src/opencode/provider-defs.js';
import { getOpenCodeConfigPath } from '../src/opencode/user-config.js';
/**
 * One-shot jsonc provider-def port (def-ownership decoupling):
 * <ocrHome>/providers.json receives a verbatim copy of the jsonc
 * `providers` slot; the jsonc file itself is NEVER written; an unparsable
 * source defers the pass (no record); per-id upsert keeps unrelated defs-file
 * ids. Hermetic: XDG_CONFIG_HOME and OCR_HOME both point at the sandbox.
 */

let tmpDir = '';
let oldCfg: string | undefined;
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
  oldHome = process.env.OCR_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.OCR_HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
});

afterAll(() => {
  if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldCfg;
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  retryRemove(tmpDir);
});

beforeEach(() => {
  resetSandbox();
});

describe('migrateJsoncProviderDefs', () => {
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

    const rec = migrateJsoncProviderDefs();
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

  it('upserts by id: existing defs-file ids survive, the jsonc node wins its own id', () => {
    writeProviderDefs({ other: { name: 'Other', package: '@opencode/ai/providers/openai' } });
    writeJsonc(
      '{"providers": { "zhipu": { "name": "Zhipu", "package": "p" }, "other": { "name": "Replaced", "package": "q" } }}'
    );

    const rec = migrateJsoncProviderDefs();
    expect(rec!.imported).toBe(2);
    const providers = readProviderDefsFile()!.providers;
    expect(providers['other']).toEqual({ name: 'Replaced', package: 'q' }); // jsonc wins its id
    expect(providers['zhipu']).toEqual({ name: 'Zhipu', package: 'p' });
  });

  it('missing config completes with imported 0 and creates no defs file', () => {
    const rec = migrateJsoncProviderDefs();
    expect(rec).toBeDefined();
    expect(rec!.imported).toBe(0);
    expect(readProviderDefsFile()).toBeNull();
  });

  it('empty providers slot completes with imported 0 and creates no defs file', () => {
    writeJsonc('{ "model": "x" }');
    const rec = migrateJsoncProviderDefs();
    expect(rec).toBeDefined();
    expect(rec!.imported).toBe(0);
    expect(readProviderDefsFile()).toBeNull();
  });

  it('unparsable config defers the pass: no record, no defs file', () => {
    writeJsonc('{ corrupt');
    expect(migrateJsoncProviderDefs()).toBeUndefined();
    expect(readProviderDefsFile()).toBeNull();
  });

  it('imports the hook-owned onecast-router node verbatim (the router def is defs truth)', () => {
    writeJsonc(
      '{"providers": { "onecast-router": { "name": "OneCastRouter", "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": "http://127.0.0.1:3000/v1", "apiKey": "ocr-local-token" } } }}'
    );
    const rec = migrateJsoncProviderDefs();
    expect(rec!.imported).toBe(1);
    const node = readProviderDefsFile()!.providers['onecast-router'];
    expect(node.settings.baseURL).toBe('http://127.0.0.1:3000/v1');
    expect(node.name).toBe('OneCastRouter');
  });
});
