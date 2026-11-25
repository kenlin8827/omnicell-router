import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/server.js';
import { listInstalledPlugins, loadInstalledPlugins } from '../../src/plugins/host.js';
import { SUPPORTED_PLUGIN_API } from '../../src/plugins/manifest.js';

/**
 * The console plugin LOGO route (`GET /api/admin/plugins/:id/logo`).
 *
 * The brand mark is a package asset the manifest DECLARS (`logo`), so the route
 * has two contracts: it never reads outside the package (path escape), and it
 * serves the mark for every row the console lists. The second is the one that
 * broke quietly — resolution used to walk the provider registry, which holds
 * only packages with a model-service half, so a disabled/refused row (and a
 * pure client-gateway package) 404'd on a logo its own manifest advertises.
 *
 * A logo also ships inside operator-installed content, so it is untrusted:
 * `nosniff` plus a locked CSP must stay on the response, and a format outside
 * the image whitelist must not be served inline.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const ID = 'logo-route';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';

/** Installable package carrying `logo` (when `asset` is set) with the given
 *  manifest value for the field (`logoField`), so an escape or a dangling
 *  declaration is testable without a second fixture builder. */
async function install(opts: { logoField?: string; asset?: string } = {}): Promise<void> {
  const files: Record<string, [Uint8Array, { mtime: Date }] | Uint8Array> = {
    'plugin.json': strToU8(
      JSON.stringify({
        id: ID,
        name: 'Logo Route',
        version: '1.0.0',
        apiVersion: SUPPORTED_PLUGIN_API,
        type: 'model-service',
        wires: [ID],
        ...(opts.logoField !== undefined ? { logo: opts.logoField } : {}),
      })
    ),
    'index.js': strToU8(
      'export function createPlugin() { return { createProvider() { return { name: "logo-route" }; } }; }'
    ),
    'package.json': strToU8(JSON.stringify({ type: 'module' })),
  };
  if (opts.asset !== undefined) files[opts.asset] = strToU8(SVG);
  const bytes = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { mtime: new Date('2000-01-01T00:00:00Z') }]]))
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/admin/plugins/install',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(bytes),
  });
  expect(res.statusCode).toBe(200);
  await loadInstalledPlugins();
}

const logoGet = () => app.inject({ method: 'GET', url: `/api/admin/plugins/${ID}/logo` });

let tmpHome = '';
let oldHome: string | undefined;

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-plugin-logo-'));
  oldHome = process.env.OCR_HOME;
  process.env.OCR_HOME = tmpHome;
  await loadInstalledPlugins();
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('console plugin logo route', () => {
  it('serves the declared asset with the untrusted-content headers', async () => {
    await install({ logoField: 'logo.svg', asset: 'logo.svg' });
    expect(listInstalledPlugins().find((v) => v.id === ID)?.logo).toBe('logo.svg');
    const res = await logoGet();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
    expect(res.body).toBe(SVG);
  });

  it('serves the mark of a DISABLED package (a dormant row is still installed)', async () => {
    await install({ logoField: 'logo.svg', asset: 'logo.svg' });
    const off = await app.inject({ method: 'POST', url: `/api/admin/plugins/${ID}/disable` });
    expect(off.statusCode).toBe(200);
    const row = (JSON.parse(off.body) as { plugins: Array<{ id: string; disabled?: boolean; logo?: string }> })
      .plugins.find((p) => p.id === ID);
    expect(row?.disabled).toBe(true);
    // Pre-fix this answered 404: the provider registry drops the package as soon
    // as its code stops loading, and the logo was resolved through it.
    const res = await logoGet();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SVG);
  });

  it('404s when the manifest declares no logo', async () => {
    await install();
    expect((await logoGet()).statusCode).toBe(404);
  });

  it('404s when the declared asset is missing from the package', async () => {
    await install({ logoField: 'logo.svg' });
    expect((await logoGet()).statusCode).toBe(404);
  });

  it('refuses a manifest path that escapes the package directory', async () => {
    await install({ logoField: '../../escape.svg', asset: 'logo.svg' });
    expect((await logoGet()).statusCode).toBe(404);
  });

  it('refuses an asset whose extension is outside the image whitelist', async () => {
    await install({ logoField: 'logo.html', asset: 'logo.html' });
    // The file exists and resolves inside the package, so only the format gate
    // stands between an operator package and inline HTML on the gateway origin.
    const res = await app.inject({ method: 'GET', url: `/api/admin/plugins/${ID}/logo` });
    expect(res.statusCode).toBe(415);
  });
});
