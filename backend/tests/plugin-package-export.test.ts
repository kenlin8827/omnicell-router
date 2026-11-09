import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { zipPluginDir } from '../src/plugins/pack.js';
import { installPluginPackage } from '../src/plugins/host.js';

/**
 * Console package export (`GET /api/admin/plugins/:id/package`, ADR-0017 §6).
 *
 * The contract: a packaged plugin returns its installed zip VERBATIM (the zip
 * file name is free-form — discovery matches the manifest id), while a dev
 * tree source is zipped by the SAME deterministic packer `plugins:build`
 * uses, so a download round-trips through Install. Editor junk never ships.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const MANIFEST = {
  id: 'e2e-export',
  name: 'E2E Export',
  version: '1.0.0',
  type: 'model-service',
  wires: ['e2e'],
};

let tmpHome = '';
let oldHome: string | undefined;

function writeSource(dir: string): void {
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(MANIFEST));
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const createPlugin = (): unknown => ({});\n');
  fs.writeFileSync(path.join(dir, 'sub', 'data.txt'), 'nested asset');
  fs.writeFileSync(path.join(dir, '.hidden'), 'editor junk');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-plugin-export-'));
  oldHome = process.env.OCR_HOME;
  process.env.OCR_HOME = tmpHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('plugin package export', () => {
  it('packs deterministically and skips dot-entries', () => {
    const src = path.join(tmpHome, 'src');
    writeSource(src);
    const a = zipPluginDir(src);
    const b = zipPluginDir(src);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);

    const entries = Object.keys(unzipSync(a));
    expect(entries.sort()).toEqual(['index.ts', 'plugin.json', 'sub/data.txt']);
  });

  it('returns a packaged zip verbatim even when its file name is free-form', async () => {
    const src = path.join(tmpHome, 'src');
    writeSource(src);
    const zip = zipPluginDir(src);
    const packRoot = path.join(tmpHome, 'plugins');
    fs.mkdirSync(packRoot, { recursive: true });
    fs.writeFileSync(path.join(packRoot, 'anything-goes.zip'), zip);

    const res = await app.inject({ method: 'GET', url: '/api/admin/plugins/e2e-export/package' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="e2e-export.zip"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(Buffer.from(res.rawPayload), Buffer.from(zip))).toBe(0);
  });

  it('exports an installed package that installs again', async () => {
    const src = path.join(tmpHome, 'src');
    writeSource(src);
    const { id } = installPluginPackage(zipPluginDir(src));
    expect(id).toBe('e2e-export');

    const res = await app.inject({ method: 'GET', url: '/api/admin/plugins/e2e-export/package' });
    expect(res.statusCode).toBe(200);
    const entries = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
    expect(entries).toContain('plugin.json');
    expect(entries).toContain('index.ts');
  });

  it('rejects an unknown or non-canonical id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins/nope/package' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins/%2E%2E/package' })).statusCode).toBe(404);
  });
});
