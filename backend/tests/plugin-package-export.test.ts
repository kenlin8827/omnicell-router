import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { bundlePluginDir, externalSpecifiers, PACKAGE_ENTRY } from '../src/plugins/pack.js';
import { installPluginPackage, loadInstalledPlugins } from '../src/plugins/host.js';

/**
 * Console package export (`GET /api/admin/plugins/:id/package`, ADR-0017 §6).
 *
 * The contract: a packaged plugin returns its installed zip VERBATIM (the zip
 * file name is free-form — discovery matches the manifest id), while a dev
 * tree source is BUNDLED then zipped by the SAME deterministic packer
 * `plugins:build` uses, so a download round-trips through Install. The bundle
 * is self-contained: third-party imports are inlined and sources, tests,
 * node_modules and stale package copies never ship.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const MANIFEST = {
  id: 'e2e-export',
  name: 'E2E Export',
  version: '1.0.0',
  apiVersion: 1,
  type: 'model-service',
  wires: ['e2e'],
};

let tmpHome = '';
let oldHome: string | undefined;

function writeSource(dir: string): void {
  fs.mkdirSync(path.join(dir, 'sub', 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub', 'tests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(MANIFEST));
  // A source package.json is DEV-ONLY: its deps are bundled and its `type`
  // would contradict the ESM entry, so the packager replaces it with the
  // module-type marker.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'e2e-export', type: 'commonjs' }));
  fs.writeFileSync(
    path.join(dir, 'index.ts'),
    "import { MARKER } from './dep.js';\nexport const createPlugin = (): unknown => ({ marker: MARKER });\n"
  );
  fs.writeFileSync(path.join(dir, 'dep.ts'), "export const MARKER = 'inlined-marker';\n");
  fs.writeFileSync(path.join(dir, 'sub', 'data.txt'), 'nested asset');
  fs.writeFileSync(path.join(dir, 'sub', 'node_modules', 'dep', 'index.js'), 'module.exports = 2;');
  fs.writeFileSync(path.join(dir, 'sub', 'tests', 'x.test.ts'), 'test');
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, 'tests', 'index.test.ts'), 'test');
  fs.writeFileSync(path.join(dir, 'e2e-export.zip'), 'old package copy');
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
  it('bundles deterministically, inlines sources and skips dev-only files', async () => {
    const src = path.join(tmpHome, 'src');
    writeSource(src);
    const a = await bundlePluginDir(src);
    const b = await bundlePluginDir(src);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);

    // Bun renders its module path headers relative to the process cwd; the
    // packager normalizes them so the same sources never package to different
    // bytes depending on where the host was launched.
    const cwd = process.cwd();
    try {
      process.chdir(src);
      const c = await bundlePluginDir(src);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(c))).toBe(0);
    } finally {
      process.chdir(cwd);
    }

    // A plugin path containing a SPACE (a very common Windows user directory)
    // must package to the SAME bytes: Bun renders its module headers relative
    // to the cwd, and a header left unstripped makes the artifact — and hence
    // `plugins:check` — depend on where the build ran.
    const spaced = path.join(tmpHome, 'space dir', 'plugin');
    writeSource(spaced);
    const spacedBytes = await bundlePluginDir(spaced);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(spacedBytes))).toBe(0);

    const entries = Object.keys(unzipSync(a));
    expect(entries.sort()).toEqual(['index.js', 'package.json', 'plugin.json', 'sub/data.txt']);
    // The package carries the module-type marker: the entry is ESM, and Node's
    // syntax detection only defaults to ESM from 20.19/22.7 on — the Node >= 18
    // releases the README supports would otherwise parse `export` as CJS.
    expect(JSON.parse(new TextDecoder().decode(unzipSync(a)['package.json']))).toEqual({ type: 'module' });
    // Entry ORDER is part of the bytes: it must come from a sorted walk, never
    // from the filesystem's enumeration order (`plugins:check` compares bytes).
    expect(entries).toEqual([...entries].sort());
    // `node_modules` / `tests` are dev-only at ANY depth (deps are bundled).
    expect(entries.some((e) => /(^|\/)node_modules\//.test(e))).toBe(false);
    expect(entries.some((e) => /(^|\/)tests\//.test(e))).toBe(false);
    const bundle = new TextDecoder().decode(unzipSync(a)[PACKAGE_ENTRY]);
    expect(bundle).toContain('inlined-marker');
    expect(bundle).not.toMatch(/from\s*['"]\.\/dep/);
  });

  it('bundles for the NODE target, so one artifact runs on both runtimes', async () => {
    // CJS interop is where the two runtimes diverge: a `bun` target emits
    // `var __require = import.meta.require` — a BUN-ONLY API — so such a
    // package loaded in the compiled sidecar and died on `node
    // backend/dist/index.js` with `__require is not a function`. A real
    // in-tree plugin hit this through an inlined CJS dependency.
    const src = path.join(tmpHome, 'cjs-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ ...MANIFEST, id: 'e2e-cjs' }));
    fs.writeFileSync(
      path.join(src, 'index.ts'),
      "import legacy from './legacy.cjs';\nexport const createPlugin = (): unknown => ({ legacy });\n"
    );
    fs.writeFileSync(
      path.join(src, 'legacy.cjs'),
      "const fs = require('node:fs');\nmodule.exports = { ok: typeof fs.readFileSync === 'function' };\n"
    );

    const bundle = new TextDecoder().decode(unzipSync(await bundlePluginDir(src))[PACKAGE_ENTRY]);
    expect(bundle).not.toContain('import.meta.require');
    expect(bundle).toContain('legacy');
  });

  it('flags packages the bundle would still resolve at runtime', () => {
    const bundle = [
      'import { readFileSync } from "node:fs";',
      'import { join } from "./local.js";',
      'var zlib = __require("zlib");',
      'import { grpc } from "@grpc/grpc-js";',
      'var fflate = __require("fflate");',
    ].join('\n');
    expect(externalSpecifiers(bundle).sort()).toEqual(['@grpc/grpc-js', 'fflate']);
    expect(externalSpecifiers('import { x } from "./x.js";\n__require("node:net");')).toEqual([]);
  });

  it('flags wrapped import lists and dynamic imports too', () => {
    // Bun emits a long import list across lines; the specifier then sits on a
    // bare `} from "pkg"` line. A dynamic import has no from-clause at all.
    const wrapped = 'import {\n  a,\n  b,\n} from "wrapped-pkg";\n';
    expect(externalSpecifiers(wrapped)).toEqual(['wrapped-pkg']);
    const dynamic = 'const mod = await import("dynamic-pkg");\n';
    expect(externalSpecifiers(dynamic)).toEqual(['dynamic-pkg']);
    expect(externalSpecifiers('const fs = await import("node:fs");\n')).toEqual([]);
  });

  it('returns a packaged zip verbatim even when its file name is free-form', async () => {
    const src = path.join(tmpHome, 'src');
    writeSource(src);
    const zip = await bundlePluginDir(src);
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
    const { id } = installPluginPackage(await bundlePluginDir(src));
    expect(id).toBe('e2e-export');

    const res = await app.inject({ method: 'GET', url: '/api/admin/plugins/e2e-export/package' });
    expect(res.statusCode).toBe(200);
    const entries = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
    expect(entries).toContain('plugin.json');
    expect(entries).toContain(PACKAGE_ENTRY);
    expect(entries).not.toContain('index.ts');
  });

  it('refuses a source-only package with the repack instruction', async () => {
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(MANIFEST)),
      'index.ts': strToU8('export const createPlugin = (): unknown => ({});\n'),
    });
    installPluginPackage(zip);
    const views = await loadInstalledPlugins();
    const view = views.find((v) => v.id === 'e2e-export');
    expect(view?.loaded).toBe(false);
    expect(view?.error ?? '').toMatch(/source-only/);
    expect(view?.error ?? '').toMatch(/bun run plugins:build/);
  });

  it('rejects an unknown or non-canonical id', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins/nope/package' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/admin/plugins/%2E%2E/package' })).statusCode).toBe(404);
  });
});
