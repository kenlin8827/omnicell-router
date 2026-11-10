import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, registerRuntimeConfigRef } from '../src/config/index.js';
import type { RouterConfig } from '../src/config/types.js';
import { createServer } from '../src/server.js';
import { CursorProxyClientAdapter } from '../src/cli/clients/cursor-proxy.js';
import { QoderProxyClientAdapter } from '../src/cli/clients/qoder-proxy.js';
import { ensureCa, resolveCaDir } from '../src/forward-proxy/ca.js';
import { probeCaTrusted, probeCaTrustedCached, setCaTrustCommandRunner } from '../src/forward-proxy/ca-trust.js';

/**
 * The console's CA-trust chip is only useful if its verdict is honest:
 * a store hit must be the EXACT certificate (fingerprint / PEM body, never the
 * CN), a store that cannot be READ is `unknown` rather than a false alarm, and
 * an operator re-check must never replay a cached pre-install answer.
 *
 * Isolation: this file pins `OCR_CA_DIR` into its own temp tree BEFORE anything
 * resolves the default CA root, so no probe (and no setup) can adopt or mint
 * the operator's machine-wide CA. The two setup suites pin `OCR_HOME` the same
 * way — they write launchers.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-ca-trust-'));
const pinnedEnv = { OCR_CA_DIR: process.env.OCR_CA_DIR, OCR_HOME: process.env.OCR_HOME };
process.env.OCR_CA_DIR = path.join(sandbox, 'ca');

after(() => {
  setCaTrustCommandRunner(undefined);
  registerRuntimeConfigRef(undefined);
  for (const [key, value] of Object.entries(pinnedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('CA trust probe decision table (injected runner)', () => {
  const caDir = path.join(sandbox, 'win-ca');
  const ca = ensureCa(caDir);
  const caPath = path.join(caDir, 'ca.pem');
  const thumbprint = new crypto.X509Certificate(ca.caCertPem).fingerprint.replace(/:/g, '');

  it('Windows: a store hit by EXACT thumbprint is trusted', async () => {
    const calls: string[][] = [];
    setCaTrustCommandRunner(async (_cmd, args) => {
      calls.push(args);
      return { ok: true, stdout: 'ok', stderr: '' };
    });
    assert.equal(await probeCaTrusted(caPath, 'win32'), true);
    assert.deepEqual(calls[0], ['-store', 'Root', thumbprint], 'the machine store is asked for this exact certificate');
  });

  it('Windows: NTE_NOT_FOUND in both stores is a definite false', async () => {
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'NTE_NOT_FOUND' }));
    assert.equal(await probeCaTrusted(caPath, 'win32'), false);
  });

  it('Windows: a tool that could not run stays unknown', async () => {
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'Access is denied.' }));
    assert.equal(await probeCaTrusted(caPath, 'win32'), 'unknown');
  });

  it('Windows: an unreadable CA file is unknown — never a CN witness', async () => {
    let called = false;
    setCaTrustCommandRunner(async () => {
      called = true;
      return { ok: true, stdout: 'CN=OmniCellRouter Forward Proxy CA', stderr: '' };
    });
    assert.equal(await probeCaTrusted(path.join(caDir, 'missing.pem'), 'win32'), 'unknown');
    assert.equal(called, false, 'no store is consulted without a certificate identity');
  });

  it('caches the verdict for 60s and force bypasses it', async () => {
    let trusted = false;
    setCaTrustCommandRunner(async (_cmd, args) => ({
      ok: trusted && args.includes(thumbprint),
      stdout: '',
      stderr: trusted ? '' : 'NTE_NOT_FOUND',
    }));
    const first = await probeCaTrustedCached(caPath, { force: true });
    assert.equal(first.trusted, false);
    trusted = true;
    const cached = await probeCaTrustedCached(caPath);
    assert.equal(cached.trusted, false, 'TTL cache keeps the pre-install verdict');
    assert.equal(cached.checkedAt, first.checkedAt, 'a cache hit reports the ORIGINAL probe time');
    assert.equal((await probeCaTrustedCached(caPath, { force: true })).trusted, true, 'force re-runs the probe');
  });
});

describe('CA trust probe — Linux stores', () => {
  const caDir = path.join(sandbox, 'linux-ca');
  const ca = ensureCa(caDir);
  const caPath = path.join(caDir, 'ca.pem');
  const caPem = ca.caCertPem;
  const otherCaPem = ensureCa(path.join(sandbox, 'other-ca')).caCertPem;
  const readableEmpty = path.join(sandbox, 'anchors-empty');
  fs.mkdirSync(readableEmpty, { recursive: true });

  it('an anchor file carrying the exact body is trusted', async () => {
    const anchors = path.join(sandbox, 'anchors-hit');
    fs.mkdirSync(anchors, { recursive: true });
    fs.copyFileSync(caPath, path.join(anchors, 'omnicell-router.crt'));
    assert.equal(await probeCaTrusted(caPath, 'linux', { dirs: [anchors], bundles: [], nssDbs: [] }), true);
  });

  it('a merged bundle carrying the exact body is trusted', async () => {
    const bundle = path.join(sandbox, 'ca-certificates.crt');
    fs.writeFileSync(bundle, caPem);
    assert.equal(await probeCaTrusted(caPath, 'linux', { dirs: [], bundles: [bundle], nssDbs: [] }), true);
  });

  it('readable stores without the certificate are a definite false', async () => {
    const bundle = path.join(sandbox, 'other-ca-bundle.crt');
    fs.writeFileSync(bundle, otherCaPem);
    assert.equal(
      await probeCaTrusted(caPath, 'linux', { dirs: [readableEmpty], bundles: [bundle], nssDbs: [] }),
      false,
    );
  });

  it('a store that exists but cannot be read stays unknown', async () => {
    // A regular FILE where a directory is expected: existence passes, the
    // listing throws — the same shape as a permission-denied anchor dir.
    const notADir = path.join(sandbox, 'not-a-dir');
    fs.writeFileSync(notADir, 'x');
    assert.equal(
      await probeCaTrusted(caPath, 'linux', { dirs: [notADir], bundles: [], nssDbs: [] }),
      'unknown',
    );
  });

  it('an NSS listing that carries the certificate is trusted', async () => {
    const db = path.join(sandbox, 'nss-hit.db');
    fs.writeFileSync(db, 'x');
    setCaTrustCommandRunner(async () => ({ ok: true, stdout: caPem, stderr: '' }));
    assert.equal(await probeCaTrusted(caPath, 'linux', { dirs: [], bundles: [], nssDbs: [db] }), true);
  });

  it('an NSS database that cannot be listed stays unknown', async () => {
    const db = path.join(sandbox, 'nss-broken.db');
    fs.writeFileSync(db, 'x');
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'SEC_ERROR_BAD_DATABASE' }));
    assert.equal(await probeCaTrusted(caPath, 'linux', { dirs: [], bundles: [], nssDbs: [db] }), 'unknown');
  });
});

describe('CA trust probe — macOS store', () => {
  const caDir = path.join(sandbox, 'darwin-ca');
  ensureCa(caDir);
  const caPath = path.join(caDir, 'ca.pem');

  it('verify-cert rejecting the certificate is a definite false', async () => {
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'CSSMERR_TP_NOT_TRUSTED' }));
    assert.equal(await probeCaTrusted(caPath, 'darwin'), false);
  });

  it('a missing verifier tool stays unknown', async () => {
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'ENOENT' }));
    assert.equal(await probeCaTrusted(caPath, 'darwin'), 'unknown');
  });

  it('a missing PEM is unknown without spawning a tool', async () => {
    let called = false;
    setCaTrustCommandRunner(async () => {
      called = true;
      return { ok: true, stdout: '', stderr: '' };
    });
    assert.equal(await probeCaTrusted(path.join(sandbox, 'missing.pem'), 'darwin'), 'unknown');
    assert.equal(called, false, 'nothing to identify = no probe');
  });
});

/**
 * Contract test for GET /api/admin/proxy/ca/trust: it must resolve the SAME
 * CA path the meta endpoint describes, answer a tri-state verdict (never key
 * material), and stamp the answer with the probe time. The platform verdict
 * itself is environment-dependent, so it is exercised above with a seam.
 */
describe('GET /api/admin/proxy/ca/trust', () => {
  const baseConfig = loadConfig();
  baseConfig.host = '127.0.0.1';
  baseConfig.webAuth = { enabled: false };
  const { app } = createServer(baseConfig, true);

  it('reports a tri-state trust answer for the live CA path', async () => {
    const meta = (await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/meta' })).json();
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'NTE_NOT_FOUND' }));

    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/trust?force=1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.equal(body.status, 'ok');
    assert.equal(body.caPath, meta.path, 'trust is probed for the CA the meta card describes');
    assert.ok([true, false, 'unknown'].includes(body.trusted), `tri-state verdict: ${JSON.stringify(body.trusted)}`);
    assert.ok(Number.isFinite(body.checkedAt));
    assert.doesNotMatch(res.body, /PRIVATE KEY/, 'the endpoint must never ship key material');
  });

  it('answers unknown with no probe time when the CA file does not exist', async () => {
    // A re-check right after the operator deletes/rotates the dir must not
    // report a probe time that no probe produced.
    const pinnedDir = process.env.OCR_CA_DIR;
    const empty = path.join(sandbox, 'no-ca-yet');
    fs.mkdirSync(empty, { recursive: true });
    process.env.OCR_CA_DIR = empty;
    try {
      const body = (await app.inject({ method: 'GET', url: '/api/admin/proxy/ca/trust?force=1' })).json();
      assert.equal(body.trusted, 'unknown');
      assert.equal(body.caPath, path.join(empty, 'ca.pem'));
      assert.equal(body.checkedAt, undefined, 'no probe ran, so no probe time is reported');
    } finally {
      process.env.OCR_CA_DIR = pinnedDir;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

/**
 * Hooking Cursor must SUCCEED even when the CA is not trusted yet (the
 * operator imports it right after setup), but the result must carry the
 * advisories so the console can warn instead of pretending the client works.
 */
describe('Cursor setup advisories', () => {
  const originalBin = process.env.CURSOR_BIN;
  const originalHome = process.env.OCR_HOME;

  before(() => {
    process.env.OCR_HOME = path.join(sandbox, 'home-cursor');
  });

  after(() => {
    if (originalBin === undefined) delete process.env.CURSOR_BIN;
    else process.env.CURSOR_BIN = originalBin;
    if (originalHome === undefined) delete process.env.OCR_HOME;
    else process.env.OCR_HOME = originalHome;
  });

  it('reports an untrusted CA and a stopped listener without failing the setup', async () => {
    const caDir = resolveCaDir();
    ensureCa(caDir);
    const cfg = {
      forwardProxy: { enabled: true, port: 4555, caDir, requireCredential: false },
    } as unknown as RouterConfig;
    registerRuntimeConfigRef(cfg);
    // Any existing executable stands in for the Cursor binary: the adapter
    // only records its path in the launcher.
    process.env.CURSOR_BIN = process.execPath;
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'NTE_NOT_FOUND' }));

    const result = await new CursorProxyClientAdapter().setup();

    assert.equal(result.success, true, 'the launcher is written regardless of trust state');
    const codes = (result.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes('proxy_not_running'), `listener advisory: ${JSON.stringify(codes)}`);
    assert.ok(
      codes.includes('ca_not_trusted') || codes.includes('ca_trust_unknown'),
      `CA-trust advisory: ${JSON.stringify(codes)}`,
    );
  });
});

/**
 * Qoder's launcher only disables TLS verification for the Node/grpc SDK; its
 * Chromium legs still read the OS store. The hook must therefore carry the
 * same advisories as Cursor instead of silently pretending it is ready.
 */
describe('Qoder setup advisories', () => {
  const originalBin = process.env.QODER_BIN;
  const originalHome = process.env.OCR_HOME;

  before(() => {
    process.env.OCR_HOME = path.join(sandbox, 'home-qoder');
  });

  after(() => {
    if (originalBin === undefined) delete process.env.QODER_BIN;
    else process.env.QODER_BIN = originalBin;
    if (originalHome === undefined) delete process.env.OCR_HOME;
    else process.env.OCR_HOME = originalHome;
  });

  it('reports an untrusted CA and a stopped listener without failing the setup', async () => {
    const caDir = resolveCaDir();
    ensureCa(caDir);
    registerRuntimeConfigRef({
      forwardProxy: { enabled: true, port: 4555, caDir, requireCredential: false },
    } as unknown as RouterConfig);
    process.env.QODER_BIN = process.execPath;
    setCaTrustCommandRunner(async () => ({ ok: false, stdout: '', stderr: 'NTE_NOT_FOUND' }));

    const result = await new QoderProxyClientAdapter().setup();

    assert.equal(result.success, true, 'the launcher is written regardless of trust state');
    const codes = (result.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes('proxy_not_running'), `listener advisory: ${JSON.stringify(codes)}`);
    assert.ok(
      codes.includes('ca_not_trusted') || codes.includes('ca_trust_unknown'),
      `CA-trust advisory: ${JSON.stringify(codes)}`,
    );
  });
});
