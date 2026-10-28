import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CredentialPaths, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { resetCredentialStoreForTests, writeCredentialStoreState } from '../src/opencode/credentials/factory.js';

/**
 * GET /api/admin/credential-store — the badge data source and the fix for
 * touchpoint gap #1 (boot excluded[] served over API, not just logged).
 * The bound store is ALWAYS the OCR file; masked-only contract asserted with
 * a real-looking key in the fixture. Harness follows admin-logs-clear.test.ts:
 * real server, webAuth off, the isolated runner's sandboxed OCR_HOME.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-cred-endpoint-'));
  const paths: CredentialPaths = {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.serviceJsonCandidates![0]!, JSON.stringify({ password: 'pw', port: 4100 }));
  return paths;
}

const OCR_CAPS = {
  multiCredential: true,
  activate: true,
  reorder: true,
  weight: true,
  rename: true,
  oauth: false,
  envVisible: false,
  integrationScoped: false,
};

function seedOcrFile(paths: CredentialPaths, providers: Record<string, unknown[]>): void {
  fs.mkdirSync(paths.ocrHome, { recursive: true });
  fs.writeFileSync(ocrCredentialsFile(paths), JSON.stringify({ version: 1, providers }));
}

describe('GET /api/admin/credential-store', () => {
  it('serves the bound OCR store verbatim, masked-only, with per-provider credential detail', async () => {
    const paths = sandboxPaths();
    seedOcrFile(paths, {
      anthropic: [
        { credentialId: 'a-secret', label: 'work', key: 'sk-SUPER-SECRET-000111222', timeCreated: 1, timeUpdated: 1, active: true },
      ],
    });
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 1234 });

    const res = await app.inject({ method: 'GET', url: '/api/admin/credential-store' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.store.kind).toBe('ocr');
    expect(body.store.capabilities).toEqual(OCR_CAPS);
    expect(body.store.degradedCode).toBeNull();
    expect(body.store.evidence.used).toBe('none');
    expect(body.store.probeResult.state).toBe('ready');
    expect(body.store.credentialFile).toBe(ocrCredentialsFile(paths));
    expect(body.reconcile).toBeNull(); // no legacy marker

    // per-provider detail: masked metadata only
    const anthropic = body.store.credentials.find((a: { providerId: string }) => a.providerId === 'anthropic');
    expect(anthropic.routable).toBe(1);
    expect(anthropic.credentials[0]).toMatchObject({ id: 'a-secret', type: 'api', active: true, routable: true });
    expect(anthropic.credentials[0].maskedKey).toContain('••••');

    // THE masking assertion — no raw key anywhere in the wire payload
    expect(res.body).not.toContain('sk-SUPER-SECRET-000111222');
  });

  it('surfaces a LEGACY reconcile marker from credential-store.json (old-boot files stay readable)', async () => {
    const paths = sandboxPaths();
    writeCredentialStoreState(paths, {
      bound: 'ocr',
      version: null,
      evidence: { cli: null, file: null, used: 'none', lastKnownGood: null },
      degradedCode: null,
      updatedAt: 1,
      reconcile: {
        doneAt: 42,
        authWriteDisabled: true,
        entries: [{ provider: 'anthropic', action: 'pushed' }],
      },
    });
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 2 });

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    expect(body.reconcile).toMatchObject({ doneAt: 42, authWriteDisabled: true });
    expect(body.reconcile.entries).toEqual([{ provider: 'anthropic', action: 'pushed' }]);
  });

  it('serves the unbadged standalone landing', async () => {
    const paths = sandboxPaths();
    resetCredentialStoreForTests(paths, undefined, undefined, { env: {}, now: () => 1 });

    const body = (await app.inject({ method: 'GET', url: '/api/admin/credential-store' })).json();
    expect(body.store.kind).toBe('ocr');
    expect(body.store.degradedCode).toBeNull();
    expect(body.store.evidence.used).toBe('none');
    expect(body.reconcile).toBeNull();
  });
});
