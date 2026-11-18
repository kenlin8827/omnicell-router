import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { currentYaml } from './helpers/current-config.js';
import { ensurePluginClientAdapters, setupClient, teardownClient } from '../src/cli/clients/index.js';
import { registerPluginClientAdapter } from '../src/cli/clients/plugin-adapters.js';
import type { ClientAdapter } from '../src/cli/clients/base.js';

/**
 * Acting on a RUNNING client is a consent flow, and the consent has to survive
 * the whole way down: console body → route → `setupClient`/`teardownClient` →
 * adapter options. What breaks when it does not is subtle — the adapter refuses
 * with `ide_running`, the console shows a dialog, and the retry silently
 * carries nothing, so the operator is asked the same question forever.
 *
 * This test drives the REAL route with a fake adapter (a packaged hook, so no
 * IDE or process table is involved): the body flag must arrive as the adapter
 * option, and the refusal must come back as 400 + reasonCode + params.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-client-consent-'));
process.env.OCR_HOME = path.join(sandbox, 'home');
process.env.OCR_ENV = 'default';
const envDir = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(envDir, { recursive: true });
fs.writeFileSync(path.join(envDir, 'config.yaml'), currentYaml('schemaVersion: 3\nclient:\n  host: 127.0.0.1\n'));
fs.writeFileSync(path.join(envDir, 'env.json'), JSON.stringify({ name: 'default', type: 'regular', schemaVersion: 1 }));

const config = loadConfig();
config.host = '127.0.0.1';
config.webAuth = { enabled: false };
config.adminKey = undefined;
const { app } = createServer(config, true);

/** Every call the fake adapter received, in order. */
const calls: Array<{ action: 'setup' | 'teardown'; options: Record<string, unknown> }> = [];
const RUNNING_REFUSAL = {
  success: false,
  reasonCode: 'ide_running',
  params: { products: 'Fake IDE', action: 'setup' },
  message: 'Fake IDE is running — quit it and retry, or acknowledge to hook anyway.',
};

const fake = (): ClientAdapter =>
  ({
    name: 'consent-cli',
    displayName: 'Fake consent client',
    hookKind: 'proxy-config',
    getConfigPath: () => path.join(sandbox, 'none'),
    getStatus: async () => ({
      name: 'consent-cli',
      displayName: 'Fake consent client',
      configPath: path.join(sandbox, 'none'),
      exists: true,
      hooked: false,
      backupExists: false,
      details: '',
      modelSlots: [],
    }),
    setup: async (options?: Record<string, unknown>) => {
      calls.push({ action: 'setup', options: options ?? {} });
      if (options?.acknowledgeRunning !== true) return { ...RUNNING_REFUSAL };
      return { success: true, message: 'hooked' };
    },
    teardown: async (options?: Record<string, unknown>) => {
      calls.push({ action: 'teardown', options: options ?? {} });
      if (options?.acknowledgeRunning !== true) return { ...RUNNING_REFUSAL, params: { products: 'Fake IDE', action: 'teardown' } };
      return { success: true, message: 'unhooked' };
    },
  }) as unknown as ClientAdapter;

beforeAll(async () => {
  // The plugin host builds its adapter set ONCE per process; registering after
  // that keeps this fake in the live map (it is a packaged-hook stand-in).
  await ensurePluginClientAdapters();
  registerPluginClientAdapter('consent-test', fake());
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // A background writer (ledgers keep their sqlite handles) can still hold the
  // sandbox open; the OS temp dir is the fallback owner, never a test failure.
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* leave it to the OS temp cleaner */
  }
});

describe('running-client consent through the client routes', () => {
  it('refuses a setup without consent and names the running client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/client/consent-cli/setup',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.reasonCode).toBe('ide_running');
    expect(body.params.products).toBe('Fake IDE');
    expect(calls.at(-1)?.options.acknowledgeRunning).toBeUndefined();
  });

  it('carries `acknowledgeRunning` from the body into the adapter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/client/consent-cli/setup',
      payload: { acknowledgeRunning: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(calls.at(-1)?.options.acknowledgeRunning).toBe(true);
  });

  it('does the same for teardown', async () => {
    const refused = await app.inject({ method: 'POST', url: '/api/admin/client/consent-cli/teardown', payload: {} });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().reasonCode).toBe('ide_running');

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/admin/client/consent-cli/teardown',
      payload: { acknowledgeRunning: true },
    });
    expect(allowed.statusCode).toBe(200);
    expect(calls.at(-1)?.action).toBe('teardown');
    expect(calls.at(-1)?.options.acknowledgeRunning).toBe(true);
  });

  it('keeps the product selector alongside the consent flag', async () => {
    await setupClient('consent-cli', { acknowledgeRunning: true, product: 'goland' });
    expect(calls.at(-1)?.options).toMatchObject({ acknowledgeRunning: true, product: 'goland' });
  });
});
