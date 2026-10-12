import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import Fastify, { FastifyInstance } from 'fastify';
import {
  registerEnvironmentRoutes,
  type EnvironmentRouteDeps,
} from '../src/routes/environments.js';
import {
  DEFAULT_ENV_NAME,
  __resetEnvResolutionForTests,
  createEnv,
  ensureEnvScaffold,
  getEnvMeta,
  getEnvPaths,
  readPointer,
} from '../src/config/env.js';
import { loadConfig } from '../src/config/index.js';
import { hashPassword } from '../src/auth/web-auth.js';
import { createServer } from '../src/server.js';
import { parseZipArchiveAsync } from '../src/config/env-archive.js';

/**
 * Phase-2 environment admin API. Every test runs on a bare Fastify instance
 * with the routes mounted and FAKE spawn/exit deps — the switch contract
 * (pointer write → spawn → rollback, NEVER exit on failure) is asserted
 * without ever restarting the test process. Isolation follows the
 * env-resolution suite: a fresh temp OCR_HOME per test (config and every
 * state path resolve inside it, so the process cwd is never consulted).
 */

let HOME = '';
const prevOcrEnv = process.env.OCR_ENV;
const prevOcrHome = process.env.OCR_HOME;
const created: string[] = [];

let app: FastifyInstance | null = null;
let spawnCalls: Array<{ envName: string }> = [];
let exitCalls = 0;

function makeApp(deps: EnvironmentRouteDeps = {}): FastifyInstance {
  spawnCalls = [];
  exitCalls = 0;
  app = Fastify();
  registerEnvironmentRoutes(app, deps);
  return app;
}

beforeEach(() => {
  delete process.env.OCR_ENV;
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-envapi-home-'));
  process.env.OCR_HOME = HOME;
  __resetEnvResolutionForTests(); // path cache must rebind to the new HOME before any write
  // The bootstrap default gets a real directory + config — exactly what the
  // gateway boot does via ensureEnvScaffold() + ensureDefaultConfigFile().
  ensureEnvScaffold('default');
  fs.writeFileSync(getEnvPaths('default').configPath, 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n', 'utf8');
  created.push(HOME);
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

afterAll(() => {
  if (prevOcrEnv === undefined) delete process.env.OCR_ENV;
  else process.env.OCR_ENV = prevOcrEnv;
  if (prevOcrHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = prevOcrHome;
  __resetEnvResolutionForTests();
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Mark env "booted" for the running-guards: OCR_ENV + cache reset. */
function bootAs(name: string): void {
  process.env.OCR_ENV = name;
  __resetEnvResolutionForTests();
}

const json = (res: { payload: string }) => JSON.parse(res.payload);

/* ─── Listing / current ──────────────────────────────────────────────────── */

describe('GET /api/admin/environments (+ /current)', () => {
  it('fresh home: the bootstrapped default only, running+current true', async () => {
    const a = makeApp();
    const res = await a.inject({ method: 'GET', url: '/api/admin/environments' });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.current).toBe('default');
    expect(body.running).toBe('default');
    expect(body.environments.length).toBe(1);
    const def = body.environments[0];
    expect(def).toMatchObject({ name: 'default', current: true, running: true, active: true });
    expect(def.dir).toBe(path.join(HOME, 'envs', 'default'));
    expect(typeof def.sizeBytes).toBe('number');
    expect(def.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  it('created envs listed with type/createdAt; sizeBytes counts payload files', async () => {
    await createEnv({ name: 'alpha', type: 'sandbox' });
    fs.mkdirSync(path.join(HOME, 'envs', 'alpha', 'data'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'envs', 'alpha', 'data', 'flywheel.jsonl'), 'x'.repeat(120), 'utf8');
    const a = makeApp();
    const body = json(await a.inject({ method: 'GET', url: '/api/admin/environments' }));
    const alpha = body.environments.find((e: any) => e.name === 'alpha');
    expect(alpha.type).toBe('sandbox');
    expect(alpha.current).toBe(false);
    expect(typeof alpha.createdAt).toBe('string');
    // config + env.json + 120-byte payload — well above the default's bare dirs
    expect(alpha.sizeBytes).toBeGreaterThanOrEqual(120);
  });

  it('/current returns resolved paths + pointer + real default metadata', async () => {
    const a = makeApp();
    const body = json(await a.inject({ method: 'GET', url: '/api/admin/environments/current' }));
    expect(body.name).toBe('default');
    expect(body.configPath).toBe(getEnvPaths(DEFAULT_ENV_NAME).configPath);
    expect(body.pointer).toBeNull();
    expect(body.meta).toMatchObject({ name: 'default', type: 'regular', schemaVersion: 1 });
  });
});

/* ─── POST create ────────────────────────────────────────────────────────── */

describe('POST /api/admin/environments', () => {
  it('blank template → env dir + env.json + annotated default config', async () => {
    const a = makeApp();
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'dev' } });
    expect(res.statusCode).toBe(201);
    const p = getEnvPaths('dev');
    expect(fs.existsSync(p.configPath)).toBe(true);
    expect(fs.readFileSync(p.configPath, 'utf8')).toContain('port:');
    expect(getEnvMeta('dev')).toMatchObject({ name: 'dev', type: 'regular', schemaVersion: 1 });
  });

  it('copy-current seeds ONLY config.yaml (data starts empty)', async () => {
    const a = makeApp();
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'cp', template: 'copy-current' } });
    expect(res.statusCode).toBe(201);
    expect(fs.readFileSync(getEnvPaths('cp').configPath, 'utf8')).toBe(fs.readFileSync(getEnvPaths(DEFAULT_ENV_NAME).configPath, 'utf8'));
    expect(fs.existsSync(path.join(HOME, 'envs', 'cp', 'data', 'flywheel.jsonl'))).toBe(false);
  });

  it('copy-default reads the default env config even while booted on a named env', async () => {
    await createEnv({ name: 'boot' });
    fs.writeFileSync(getEnvPaths('default').configPath.replace('config.yaml', 'sentinel.txt'), 'x', 'utf8'); // ensure default chain alive
    process.env.OCR_ENV = 'boot';
    __resetEnvResolutionForTests();
    const a = makeApp();
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'cd', template: 'copy-default' } });
    expect(res.statusCode).toBe(201);
    expect(fs.readFileSync(getEnvPaths('cd').configPath, 'utf8')).toBe(fs.readFileSync(getEnvPaths(DEFAULT_ENV_NAME).configPath, 'utf8'));
  });

  it('rejects invalid/reserved name (400) and duplicates (409), bad template 400', async () => {
    const a = makeApp();
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'bad name' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'default' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'ok1' } })).statusCode).toBe(201);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'ok1' } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments', payload: { name: 'ok2', template: 'zip' } })).statusCode).toBe(400);
  });
});

/* ─── PATCH / DELETE / RESET guards ──────────────────────────────────────── */

describe('PATCH /api/admin/environments/:name', () => {
  it('renames a non-running env (dir + env.json follow)', async () => {
    await createEnv({ name: 'old' });
    await createEnv({ name: 'dup' });
    const a = makeApp();
    const res = await a.inject({ method: 'PATCH', url: '/api/admin/environments/old', payload: { name: 'new' } });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(HOME, 'envs', 'new', 'env.json'))).toBe(true);
    expect(fs.existsSync(path.join(HOME, 'envs', 'old'))).toBe(false);
    expect(getEnvMeta('new')?.name).toBe('new');
    // collision with an existing env → 409
    await createEnv({ name: 'src' });
    expect((await a.inject({ method: 'PATCH', url: '/api/admin/environments/src', payload: { name: 'dup' } })).statusCode).toBe(409);
  });

  it('rejects the RUNNING env (409), default (400), missing (404), duplicate target (409)', async () => {
    await createEnv({ name: 'boot' });
    bootAs('boot');
    const a = makeApp();
    expect((await a.inject({ method: 'PATCH', url: '/api/admin/environments/boot', payload: { name: 'x' } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'PATCH', url: '/api/admin/environments/default', payload: { description: 'nope' } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'PATCH', url: '/api/admin/environments/ghost', payload: { description: 'x' } })).statusCode).toBe(404);
    await createEnv({ name: 'dup' });
    expect((await a.inject({ method: 'PATCH', url: '/api/admin/environments/ghost2', payload: {} })).statusCode).toBe(404);
  });

  it('description set + clear', async () => {
    await createEnv({ name: 'd' });
    const a = makeApp();
    await a.inject({ method: 'PATCH', url: '/api/admin/environments/d', payload: { description: 'hello' } });
    expect(getEnvMeta('d')?.description).toBe('hello');
    await a.inject({ method: 'PATCH', url: '/api/admin/environments/d', payload: { description: null } });
    expect(getEnvMeta('d')?.description).toBeUndefined();
  });
});

describe('DELETE /api/admin/environments/:name', () => {
  it('moves to trash: needs confirm, never running/default, contents preserved', async () => {
    await createEnv({ name: 'gone' });
    fs.writeFileSync(path.join(HOME, 'envs', 'gone', 'marker.txt'), 'keep', 'utf8');
    const a = makeApp();
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/environments/gone' })).statusCode).toBe(400);
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/environments/gone', payload: { confirm: false } })).statusCode).toBe(400);
    const res = await a.inject({ method: 'DELETE', url: '/api/admin/environments/gone', payload: { confirm: true } });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.status).toBe('trashed');
    expect(body.trashPath).toContain(path.join('.trash', 'gone-'));
    expect(fs.existsSync(path.join(HOME, 'envs', 'gone'))).toBe(false);
    expect(fs.readFileSync(path.join(body.trashPath, 'marker.txt'), 'utf8')).toBe('keep');
  });

  it('rejects default (400), running (409), missing (404)', async () => {
    await createEnv({ name: 'boot' });
    bootAs('boot');
    const a = makeApp();
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/environments/default', payload: { confirm: true } })).statusCode).toBe(400);
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/environments/boot', payload: { confirm: true } })).statusCode).toBe(409);
    expect((await a.inject({ method: 'DELETE', url: '/api/admin/environments/ghost', payload: { confirm: true } })).statusCode).toBe(404);
  });
});

describe('POST /api/admin/environments/:name/reset', () => {
  it('sandbox: wipes state dirs, keeps config; regular rejected 400; running 409; default 400; missing 404', async () => {
    await createEnv({ name: 'sb', type: 'sandbox' });
    await createEnv({ name: 'reg' });
    fs.mkdirSync(path.join(HOME, 'envs', 'sb', 'data'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'envs', 'sb', 'data', 'flywheel.jsonl'), 'wipe', 'utf8');
    fs.writeFileSync(path.join(HOME, 'envs', 'sb', 'config.yaml'), 'port: 4321\n', 'utf8');

    const a = makeApp();
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments/sb/reset', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(HOME, 'envs', 'sb', 'data', 'flywheel.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(HOME, 'envs', 'sb', 'config.yaml'), 'utf8')).toBe('port: 4321\n');

    expect((await a.inject({ method: 'POST', url: '/api/admin/environments/reg/reset', payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments/default/reset', payload: {} })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments/ghost/reset', payload: {} })).statusCode).toBe(404);
  });

  it('refuses the running sandbox env', async () => {
    await createEnv({ name: 'sb', type: 'sandbox' });
    bootAs('sb');
    const a = makeApp();
    expect((await a.inject({ method: 'POST', url: '/api/admin/environments/sb/reset', payload: {} })).statusCode).toBe(409);
  });
});

/* ─── SWITCH: pointer + spawn + rollback (fakes only) ────────────────────── */

describe('POST /api/admin/environments/:name/switch', () => {
  it('unknown env → 404 BEFORE the pointer is touched', async () => {
    writePointerPre('alpha'); // pre-existing pointer
    const a = makeApp({ spawnChild: () => true, scheduleExit: () => {} });
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments/nosuch/switch', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(readPointer()).toBe('alpha'); // untouched
    expect(spawnCalls.length).toBe(0);
  });

  it('happy path: pin pointer, spawn with ONLY envName, schedule exit, report restarting', async () => {
    await createEnv({ name: 'dev' });
    fs.writeFileSync(getEnvPaths('dev').configPath, 'port: 4321\n', 'utf8'); // differs from current 3000
    const a = makeApp({ spawnChild: (o) => { spawnCalls.push(o); return true; }, scheduleExit: () => { exitCalls++; } });
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.status).toBe('restarting');
    expect(body.env).toBe('dev');
    expect(body.newPort).toBe(4321);
    expect(spawnCalls).toEqual([{ envName: 'dev' }]);
    expect(exitCalls).toBe(1);
    expect(readPointer()).toBe('dev');
  });

  it('same port → no newPort field', async () => {
    await createEnv({ name: 'same' });
    fs.writeFileSync(getEnvPaths('same').configPath, 'port: 3000\n', 'utf8');
    const a = makeApp({ spawnChild: () => true, scheduleExit: () => {} });
    const body = json(await a.inject({ method: 'POST', url: '/api/admin/environments/same/switch', payload: {} }));
    expect(body.status).toBe('restarting');
    expect(body.newPort).toBeUndefined();
  });

  it('spawn failure: pointer ROLLED BACK, exit NEVER scheduled, process keeps running', async () => {
    await createEnv({ name: 'dev' });
    writePointerPre('alpha0');
    await createEnv({ name: 'alpha0' });
    const a = makeApp({ spawnChild: () => false, scheduleExit: () => { exitCalls++; } });
    const res = await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} });
    const body = json(res);
    expect(body.status).toBe('failed');
    expect(body.error).toMatch(/keeps running/);
    expect(readPointer()).toBe('alpha0'); // restored
    expect(exitCalls).toBe(0);
  });

  it('spawn throwing also rolls back (no exit)', async () => {
    await createEnv({ name: 'dev' });
    const a = makeApp({
      spawnChild: () => {
        throw new Error('boom');
      },
      scheduleExit: () => {
        exitCalls++;
      },
    });
    const body = json(await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }));
    expect(body.status).toBe('failed');
    expect(readPointer()).toBeNull(); // previous was absent → cleared
    expect(exitCalls).toBe(0);
  });

  it('switch to default = explicit pointer pin (documented choice)', async () => {
    await createEnv({ name: 'dev' });
    bootAs('dev');
    const a = makeApp({ spawnChild: (o) => { spawnCalls.push(o); return true; }, scheduleExit: () => {} });
    const body = json(await a.inject({ method: 'POST', url: `/api/admin/environments/${DEFAULT_ENV_NAME}/switch`, payload: {} }));
    expect(body.status).toBe('restarting');
    expect(readPointer()).toBe('default');
    expect(spawnCalls).toEqual([{ envName: 'default' }]);
  });

  it('switch to the running env: no spawn, no exit, pointer pinned', async () => {
    await createEnv({ name: 'dev' });
    bootAs('dev');
    const a = makeApp({ spawnChild: (o) => { spawnCalls.push(o); return true; }, scheduleExit: () => { exitCalls++; } });
    const body = json(await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }));
    expect(body.status).toBe('ok');
    expect(spawnCalls.length).toBe(0);
    expect(exitCalls).toBe(0);
    expect(readPointer()).toBe('dev');
  });
});

function writePointerPre(name: string): void {
  // pointer before the test's env existed — write file directly (pre boot)
  fs.mkdirSync(path.join(HOME, 'envs'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'envs', 'current'), `${name}\n`, 'utf8');
}

/* ─── EXPORT / IMPORT through routes ─────────────────────────────────────── */

const sha = (s: string) => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const IMPORT_DEFAULT_CFG =
  'port: 3000\nadminApiKey: __REDACTED__\nwebAuth:\n  username: admin\n  passwordHash: scrypt$aa$bb\n';

/** Build an .orc_env.zip body. manifest fields overridable; checksums derive
 * from the GIVEN config/payload unless overridden (for tamper tests). */
function zipOf(
  opts: {
    config?: string;
    payload?: Record<string, string>;
    manifest?: Record<string, unknown>;
    checksums?: Record<string, string>;
  } = {}
): Buffer {
  const config = opts.config ?? IMPORT_DEFAULT_CFG;
  const payload = opts.payload ?? { 'data/flywheel.jsonl': 'row\n' };
  const manifest: Record<string, unknown> = {
    format: 'ocr-env',
    version: 1,
    source: { name: 'alpha', type: 'regular', appVersion: '9.9.9' },
    secrets: 'redacted',
    redactedPaths: ['adminApiKey'],
    checksums: { config: sha(config), ...Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, sha(v)])) },
    // LAST: manifest overrides win — `checksums: undefined` here drops the
    // key via JSON.stringify (the unsigned-archive case).
    ...opts.manifest,
  };
  // Explicit checksums win over everything (tamper tests sign the OLD text).
  if (opts.checksums) manifest.checksums = opts.checksums;
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'config.yaml': strToU8(config),
    ...Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, strToU8(v)])),
  };
  return Buffer.from(zipSync(entries));
}

describe('GET /api/admin/environments/:name/export', () => {
  it('serves a .orc_env.zip attachment: manifest + redacted config.yaml + payload entries', async () => {
    await createEnv({ name: 'alpha' });
    fs.writeFileSync(
      getEnvPaths('alpha').configPath,
      'adminApiKey: sk-live\nproviders:\n  - { name: p, apiKey: sk-prov }\n',
      'utf8'
    );
    const a = makeApp();
    const res = await a.inject({ method: 'GET', url: '/api/admin/environments/alpha/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="alpha-\d{8}\.orc_env\.zip"$/);
    const bytes = new Uint8Array(res.rawPayload!);
    expect(bytes[0]).toBe(0x50); // PK magic — it IS a zip
    expect(bytes[1]).toBe(0x4b);
    const entries = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(manifest.format).toBe('ocr-env');
    expect(manifest.secrets).toBe('redacted');
    expect(manifest.source.name).toBe('alpha');
    const config = strFromU8(entries['config.yaml']);
    expect(config).not.toContain('sk-live');
    expect(config).toContain('__REDACTED__');
    const inclRes = await a.inject({ method: 'GET', url: '/api/admin/environments/alpha/export?secrets=include' });
    const incl = JSON.parse(strFromU8(unzipSync(new Uint8Array(inclRes.rawPayload!))['manifest.json']));
    expect(incl.secrets).toBe('included');
    expect(strFromU8(unzipSync(new Uint8Array(inclRes.rawPayload!))['config.yaml'])).toContain('sk-live');
  });

  it('?include= selects a payload subset (unknown keys ignored)', async () => {
    await createEnv({ name: 'sel' });
    fs.mkdirSync(path.dirname(path.join(getEnvPaths('sel').dataDir, 'flywheel.jsonl')), { recursive: true });
    fs.writeFileSync(path.join(getEnvPaths('sel').dataDir, 'flywheel.jsonl'), 'row\n', 'utf8');
    const a = makeApp();
    const res = await a.inject({
      method: 'GET',
      url: '/api/admin/environments/sel/export?include=data/flywheel.jsonl,not/a/key',
    });
    const entries = unzipSync(new Uint8Array(res.rawPayload!));
    expect(entries['data/flywheel.jsonl']).toBeDefined();
    expect(entries['models/layer1-classifier.json']).toBeUndefined();
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(Object.keys(manifest.checksums)).toEqual(['config', 'data/flywheel.jsonl']);
  });

  it('unknown env → 404; default env exports fine', async () => {
    const a = makeApp();
    expect((await a.inject({ method: 'GET', url: '/api/admin/environments/ghost/export' })).statusCode).toBe(404);
    const def = await a.inject({ method: 'GET', url: '/api/admin/environments/default/export' });
    expect(def.statusCode).toBe(200);
    const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(def.rawPayload!))['manifest.json']));
    expect(manifest.source.name).toBe('default');
  });
});

describe('POST /api/admin/environments/import', () => {
  const postZip = (a: any, body: Buffer, query = '') =>
    a.inject({
      method: 'POST',
      url: `/api/admin/environments/import${query}`,
      headers: { 'content-type': 'application/zip' },
      payload: body,
    });

  it('round-trip: creates a NEW env, strips sentinels + passwordHash, lands payload files', async () => {
    const a = makeApp();
    const overrides = JSON.stringify({ version: 1, updated: 0, models: { 'p||m': { disabled: true } } });
    const res = await postZip(
      a,
      zipOf({ payload: { 'data/flywheel.jsonl': 'row\n', 'catalog/overrides.json': overrides } }),
      '?name=imported1'
    );
    expect(res.statusCode).toBe(201);
    const cfg = fs.readFileSync(getEnvPaths('imported1').configPath, 'utf8');
    expect(cfg).not.toContain('__REDACTED__'); // stripped entirely, not imported as literal
    expect(cfg).not.toContain('passwordHash');
    expect(cfg).toContain('username: admin');
    expect(fs.readFileSync(path.join(HOME, 'envs', 'imported1', 'data', 'flywheel.jsonl'), 'utf8')).toBe('row\n');
    // Catalog overrides (hide flags etc.) survive the import — the next boot's
    // aggregation reads them from the new env's catalog dir.
    const landed = JSON.parse(
      fs.readFileSync(path.join(HOME, 'envs', 'imported1', 'catalog', 'overrides.json'), 'utf8')
    );
    expect(landed.models['p||m'].disabled).toBe(true);
    expect(getEnvMeta('imported1')?.description).toMatch(/imported from "alpha"/);
  });

  it('collision with an existing env → 409 + suggestion, existing env untouched', async () => {
    await createEnv({ name: 'taken' });
    const before = fs.readFileSync(getEnvPaths('taken').configPath, 'utf8');
    const a = makeApp();
    const res = await postZip(a, zipOf(), '?name=taken');
    expect(res.statusCode).toBe(409);
    expect(json(res).suggestion).toBe('taken-imported');
    expect(fs.readFileSync(getEnvPaths('taken').configPath, 'utf8')).toBe(before);
  });

  it('?mode=replace overwrites an existing env — old content lands in .trash', async () => {
    await createEnv({ name: 'restore' });
    fs.writeFileSync(getEnvPaths('restore').configPath, 'port: 1111\nmark: OLD\n', 'utf8');
    const a = makeApp();
    const res = await postZip(a, zipOf(), '?name=restore&mode=replace');
    expect(res.statusCode).toBe(201);
    // New content is in place…
    const cfg = fs.readFileSync(getEnvPaths('restore').configPath, 'utf8');
    expect(cfg).toContain('username: admin');
    expect(cfg).not.toContain('mark: OLD');
    // …and the old book-set is recoverable from trash.
    const trash = path.join(HOME, 'envs', '.trash');
    const trashed = fs.readdirSync(trash).find((d) => d.startsWith('restore-'));
    expect(trashed).toBeDefined();
    expect(fs.readFileSync(path.join(trash, trashed!, 'config.yaml'), 'utf8')).toContain('mark: OLD');
  });

  it('?mode=replace guards: nonexistent → 404; RUNNING → 409 (default included)', async () => {
    await createEnv({ name: 'live' });
    writePointerPre('live'); // running = live, so `default` is NOT running here
    const a = makeApp();
    expect((await postZip(a, zipOf(), '?name=ghost&mode=replace')).statusCode).toBe(404);
    expect((await postZip(a, zipOf(), '?name=live&mode=replace')).statusCode).toBe(409);
  });

  it('?mode=replace CAN overwrite the bootstrap default when it is not running — old book-set lands in .trash', async () => {
    // Simulate the new-machine restore: default exists with OLD content, the
    // gateway runs elsewhere (pointer pinned to another env).
    fs.mkdirSync(path.join(HOME, 'envs', 'default'), { recursive: true });
    fs.writeFileSync(getEnvPaths(DEFAULT_ENV_NAME).configPath, 'port: 1111\nmark: OLD-DEFAULT\n', 'utf8');
    await createEnv({ name: 'live' });
    writePointerPre('live');
    const a = makeApp();
    const res = await postZip(a, zipOf(), '?name=default&mode=replace');
    expect(res.statusCode).toBe(201);
    // New content in place, default still EXISTS (never vanished)…
    const cfg = fs.readFileSync(getEnvPaths(DEFAULT_ENV_NAME).configPath, 'utf8');
    expect(cfg).toContain('username: admin');
    expect(cfg).not.toContain('mark: OLD-DEFAULT');
    // …and the old default book-set is recoverable from trash.
    const trashed = fs.readdirSync(path.join(HOME, 'envs', '.trash')).find((d) => d.startsWith('default-'));
    expect(trashed).toBeDefined();
    expect(fs.readFileSync(path.join(HOME, 'envs', '.trash', trashed!, 'config.yaml'), 'utf8')).toContain('mark: OLD-DEFAULT');
  });

  it('zip-only: JSON body / non-zip binary → 400, nothing created', async () => {
    const a = makeApp();
    const jsonBody = await a.inject({
      method: 'POST',
      url: '/api/admin/environments/import',
      headers: { 'content-type': 'application/json' },
      payload: { format: 'ocr-env', version: 1 },
    });
    expect(jsonBody.statusCode).toBe(400);
    expect(jsonBody.error).toBeUndefined(); // route answered, not the framework
    const nonZip = await postZip(a, Buffer.from('hello world, definitely not a zip'));
    expect(nonZip.statusCode).toBe(400);
    const listing = json(await a.inject({ method: 'GET', url: '/api/admin/environments' }));
    expect(listing.environments.map((e: any) => e.name)).toEqual(['default']);
  });

  it('traversal / reserved zip entries are SKIPPED — never extracted, never written', async () => {
    const a = makeApp();
    // Realistic attack shape: the manifest signs ONLY the legit content; the
    // smuggled entries exist in the zip but are signed by nothing.
    const res = await postZip(
      a,
      zipOf({
        payload: { '../escape.txt': 'x', 'webauth-secret': 'planted-secret' },
        checksums: { config: sha(IMPORT_DEFAULT_CFG) },
      }),
      '?name=evil'
    );
    // Non-whitelisted entries are ignored wholesale; the import itself succeeds.
    expect(res.statusCode).toBe(201);
    expect(fs.existsSync(path.join(HOME, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(HOME, 'webauth-secret'))).toBe(false);
    // The planted 'webauth-secret' entry never landed inside the env either
    // (that file only appears on a real gateway boot — its absence here IS
    // the proof the archive entry was skipped, not written).
    expect(fs.existsSync(path.join(HOME, 'envs', 'evil', 'webauth-secret'))).toBe(false);
    // …and the import itself was complete: config.yaml landed verbatim.
    const cfg = fs.readFileSync(getEnvPaths('evil').configPath, 'utf8');
    expect(cfg).toContain('username: admin');
  });

  it('config.yaml entry with a planted payload → 400 checksum mismatch', async () => {
    const a = makeApp();
    // 'config.yaml' IS whitelisted as the config entry, so the defense here is
    // the checksum: the manifest signs the REAL config, the entry carries a
    // backdoor — mismatch, refused, nothing written.
    const res = await postZip(
      a,
      zipOf({ config: 'backdoor: true\n', checksums: { config: sha(IMPORT_DEFAULT_CFG) } }),
      '?name=cfgatk'
    );
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/Checksum mismatch/);
    expect(fs.existsSync(path.join(HOME, 'envs', 'cfgatk'))).toBe(false);
  });

  it('tampered config → 400 checksum mismatch; missing checksums → 400', async () => {
    const a = makeApp();
    const tampered = zipOf({
      config: 'port: 9999\n',
      checksums: { config: sha(IMPORT_DEFAULT_CFG), 'data/flywheel.jsonl': sha('row\n') },
    });
    expect((await postZip(a, tampered, '?name=t')).statusCode).toBe(400);
    const unsigned = zipOf({ manifest: { checksums: undefined } });
    expect((await postZip(a, unsigned, '?name=u')).statusCode).toBe(400);
  });

  it('version 2 → 400 "newer OCR"; wrong format → 400; not a zip → 400', async () => {
    const a = makeApp();
    expect(json(await postZip(a, zipOf({ manifest: { version: 2 } }), '?name=v')).error).toMatch(/newer OCR/i);
    expect((await postZip(a, zipOf({ manifest: { format: 'nope' } }), '?name=f')).statusCode).toBe(400);
    // A zip that carries NO manifest.json entry at all.
    const noManifest = Buffer.from(zipSync({ 'config.yaml': strToU8('port: 1\n') }));
    expect((await postZip(a, noManifest, '?name=n')).statusCode).toBe(400);
  });
});

/* ─── Encrypted archive through routes (AE-2, zip.js) ────────────────────── */

describe('GET /api/admin/environments/:name/export — encrypted', () => {
  it('requires the password header; plaintext keys live INSIDE the encrypted entries', async () => {
    await createEnv({ name: 'sec' });
    fs.writeFileSync(getEnvPaths('sec').configPath, 'adminApiKey: sk-live\n', 'utf8');
    const a = makeApp();
    const noPw = await a.inject({ method: 'GET', url: '/api/admin/environments/sec/export?encrypt=1' });
    expect(noPw.statusCode).toBe(400);
    expect(json(noPw).error).toMatch(/x-ocr-archive-password/);

    const res = await a.inject({
      method: 'GET',
      url: '/api/admin/environments/sec/export?encrypt=1',
      headers: { 'x-ocr-archive-password': 'pw-123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/.orc_env.zip"$/);
    expect(res.headers['content-type']).toContain('application/zip');
    const bytes = new Uint8Array(res.rawPayload!);
    expect(bytes[0]).toBe(0x50); // a REAL zip — generic tools can open it
    expect(bytes[1]).toBe(0x4b);
    const v = await parseZipArchiveAsync(bytes, undefined, 'pw-123456');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // secrets=include is IMPLIED by encryption: the config inside carries the
    // plaintext key, no sentinel anywhere.
    expect(v.config).toContain('sk-live');
  });
});

describe('POST /api/admin/environments/import — encrypted archive (round-trip)', () => {
  it('no password → 400 needs; wrong password → 400; correct password → 201 with keys intact', async () => {
    await createEnv({ name: 'src' });
    fs.writeFileSync(getEnvPaths('src').configPath, 'adminApiKey: sk-live\n', 'utf8');
    const a = makeApp();
    // The encrypted body comes from the EXPORT route itself — a true
    // export → import round-trip through two separate gateways.
    const enc = await a.inject({
      method: 'GET',
      url: '/api/admin/environments/src/export?encrypt=1',
      headers: { 'x-ocr-archive-password': 'pw-123456' },
    });
    const post = (name: string, pw?: string) =>
      a.inject({
        method: 'POST',
        url: `/api/admin/environments/import?name=${name}`,
        headers: { 'content-type': 'application/zip', ...(pw ? { 'x-ocr-archive-password': pw } : {}) },
        payload: Buffer.from(enc.rawPayload!),
      });

    const noPw = await post('enc1');
    expect(noPw.statusCode).toBe(400);
    expect(json(noPw).error).toMatch(/encrypted/i);

    const wrong = await post('enc2', 'not-the-password');
    expect(wrong.statusCode).toBe(400);
    expect(json(wrong).error).toMatch(/decryption failed/i);

    const ok = await post('enc3', 'pw-123456');
    expect(ok.statusCode).toBe(201);
    const cfg = fs.readFileSync(getEnvPaths('enc3').configPath, 'utf8');
    expect(cfg).toContain('sk-live'); // full backup: keys intact, no re-entry
    expect(cfg).not.toContain('__REDACTED__');
  });
});
/* ─── Wiring: routes exist inside the real server + auth gate coverage ───── */

describe('createServer integration (registration + gate)', () => {
  it('GET /api/admin/environments resolves through the full server', async () => {
    const { app: server } = createServer(loadConfig(), true);
    const res = await server.inject({ method: 'GET', url: '/api/admin/environments' });
    expect(res.statusCode).toBe(200);
    expect(json(res).environments.length).toBeGreaterThanOrEqual(1);
    const cur = await server.inject({ method: 'GET', url: '/api/admin/environments/current' });
    expect(cur.statusCode).toBe(200);
    await server.close();
  });
});

/* ─── Zip entry whitelist (route level): reserved entries never reach disk ── */

describe('POST /api/admin/environments/import — entry whitelist', () => {
  it('env.json entry → skipped by the whitelist; import succeeds without it', async () => {
    const a = makeApp();
    const config = 'port: 3000\n';
    const manifest = {
      format: 'ocr-env',
      version: 1,
      source: { name: 'alpha', type: 'regular', appVersion: '9.9.9' },
      secrets: 'redacted',
      redactedPaths: [],
      checksums: { config: 'sha256:' + crypto.createHash('sha256').update(config, 'utf8').digest('hex') },
    };
    const entries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'config.yaml': strToU8(config),
      'env.json': strToU8('{"type":"sandbox"}'),
    };
    const res = await a.inject({
      method: 'POST',
      url: '/api/admin/environments/import?name=entryatk',
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from(zipSync(entries)),
    });
    expect(res.statusCode).toBe(201);
    const meta = fs.readFileSync(path.join(HOME, 'envs', 'entryatk', 'env.json'), 'utf8');
    expect(JSON.parse(meta).type).toBe('regular'); // createEnv wrote it, NOT the archive entry
  });
});

/* ─── L3 P2-2: concurrent switch guard ───────────────────────────────────── */

describe('POST /:name/switch — in-flight guard', () => {
  it('second concurrent switch → 409, exactly one child spawned', async () => {
    await createEnv({ name: 'dev' });
    const a = makeApp({
      spawnChild: (o) => {
        spawnCalls.push(o);
        return true;
      },
      scheduleExit: () => {
        exitCalls++;
      },
    });
    const [r1, r2] = await Promise.all([
      a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }),
      a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const denied = r1.statusCode === 409 ? json(r1) : json(r2);
    expect(denied.error).toMatch(/switch already in progress/i);
    expect(spawnCalls.length).toBe(1);
  });

  it('guard releases on spawn failure — immediate retry succeeds', async () => {
    await createEnv({ name: 'dev' });
    const results = [false, true];
    const a = makeApp({
      spawnChild: (o) => {
        spawnCalls.push(o);
        return results.shift() ?? true;
      },
      scheduleExit: () => {
        exitCalls++;
      },
    });
    const first = json(await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }));
    expect(first.status).toBe('failed');
    const retry = json(await a.inject({ method: 'POST', url: '/api/admin/environments/dev/switch', payload: {} }));
    expect(retry.status).toBe('restarting');
    expect(spawnCalls.length).toBe(2);
    expect(readPointer()).toBe('dev');
  });
});

/* ─── L3 P3-1: newPort clamped to a valid TCP range ──────────────────────── */

describe('POST /:name/switch — newPort validity', () => {
  it('out-of-range target port omits newPort instead of advertising it', async () => {
    await createEnv({ name: 'wild' });
    fs.writeFileSync(getEnvPaths('wild').configPath, 'port: 99999\n', 'utf8');
    const a = makeApp({ spawnChild: () => true, scheduleExit: () => {} });
    const body = json(await a.inject({ method: 'POST', url: '/api/admin/environments/wild/switch', payload: {} }));
    expect(body.status).toBe('restarting');
    expect(body.newPort).toBeUndefined();
  });
});

/* ─── Reviewer-flagged: webAuth gate actually covers the env routes ──────── */

describe('webAuth gate on /api/admin/environments', () => {
  it('unauthenticated GET → 401 when webAuth is active', async () => {
    const gated = createServer(
      {
        ...loadConfig(),
        host: '0.0.0.0',
        webAuth: { enabled: true, username: 't', passwordHash: hashPassword('gate-test-pass') },
        apiKeys: [],
      },
      true
    );
    const res = await gated.app.inject({ method: 'GET', url: '/api/admin/environments' });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe('console_auth_required');
    await gated.app.close();
  });
});
