import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import {
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  EnvArchiveError,
  ZIP_MAX_ENTRY_BYTES,
  buildEncryptedZipArchive,
  buildEnvelope,
  buildZipArchive,
  parseAndValidateEnvelope,
  parseZipArchiveAsync,
  safeResolveWithin,
} from '../src/config/env-archive.js';
import {
  DEFAULT_ENV_NAME,
  __resetEnvResolutionForTests,
  createEnv,
  ensureEnvScaffold,
  getEnvPaths,
} from '../src/config/env.js';

/**
 * Archive envelope v1 unit tests (export shape / redaction / checksums /
 * import guards). Route-level behavior lives in environments-api.test.ts.
 */

const sha = (s: string) => 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const originalCwd = process.cwd();
let HOME = '';
const created: string[] = [];

beforeEach(() => {
  delete process.env.OCR_ENV;
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-archive-home-'));
  process.env.OCR_HOME = HOME;
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-archive-cwd-'));
  fs.writeFileSync(path.join(fresh, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n', 'utf8');
  process.chdir(fresh);
  created.push(fresh, HOME);
  __resetEnvResolutionForTests();
});

afterAll(() => {
  process.chdir(originalCwd);
  delete process.env.OCR_HOME;
  __resetEnvResolutionForTests();
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Fully populated env 'alpha': all three redaction paths + passwordHash + payload files. */
async function seedAlpha(): Promise<void> {
  await createEnv({ name: 'alpha' });
  const dir = path.join(HOME, 'envs', 'alpha');
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'port: 3000',
      'adminApiKey: sk-ocr-secret-admin',
      'providers:',
      '  - { name: p1, apiKey: sk-provider-real }',
      'apiKeys:',
      '  - { name: c1, key: sk-ocr-client }',
      'webAuth:',
      '  enabled: true',
      '  username: admin',
      '  passwordHash: scrypt$aabb$ccdd',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'flywheel.jsonl'), '{"v":1}\n{"v":2}\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'layer1-classifier.json'), '{"isBaseModel":true}', 'utf8');
  fs.mkdirSync(path.join(dir, 'catalog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'catalog', 'custom.json'), '{"version":1}', 'utf8');
}

/** Sign an envelope in-place (config + every payload entry). */
function sign(env: Record<string, any>): Record<string, any> {
  env.checksums = {
    config: sha(env.config),
    ...Object.fromEntries(Object.entries(env.payload as Record<string, string>).map(([k, v]) => [k, sha(v)])),
  };
  return env;
}

/* ─── buildEnvelope ──────────────────────────────────────────────────────── */

describe('buildEnvelope', () => {
  it('redacts the three secret paths, drops passwordHash, checksums every entry', async () => {
    await seedAlpha();
    const env = buildEnvelope('alpha', { includeSecrets: false });
    expect(env.format).toBe(ENVELOPE_FORMAT);
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.secrets).toBe('redacted');
    expect(env.source).toEqual({ name: 'alpha', type: 'regular', appVersion: expect.any(String) });
    expect(env.redactedPaths.sort()).toEqual(
      ['adminApiKey', 'apiKeys[0].key', 'providers[0].apiKey'].sort()
    );

    const cfg = parse(env.config);
    expect(cfg.adminApiKey).toBe('__REDACTED__');
    expect(cfg.providers[0].apiKey).toBe('__REDACTED__');
    expect(cfg.apiKeys[0].key).toBe('__REDACTED__');
    // passwordHash NEVER leaves, even redacted — and real values are gone.
    expect(env.config).not.toContain('scrypt$aabb');
    expect(env.config).not.toContain('sk-provider-real');
    expect(cfg.webAuth.passwordHash).toBeUndefined();
    expect(cfg.webAuth.username).toBe('admin'); // non-secret fields ride along

    expect(Object.keys(env.payload).sort()).toEqual([
      'catalog/custom.json',
      'data/flywheel.jsonl',
      'models/layer1-classifier.json',
    ]);
    expect(env.payload['data/flywheel.jsonl']).toContain('{"v":2}');
    expect(env.checksums.config).toBe(sha(env.config));
    expect(env.checksums['data/flywheel.jsonl']).toBe(sha(env.payload['data/flywheel.jsonl']));
    expect(env.checksums['data/layer2-decisions.jsonl']).toBeUndefined(); // only files that exist
  });

  it('secrets=include keeps real values but STILL drops passwordHash', async () => {
    await seedAlpha();
    const env = buildEnvelope('alpha', { includeSecrets: true });
    expect(env.secrets).toBe('included');
    expect(env.redactedPaths).toEqual([]);
    expect(env.config).toContain('sk-provider-real');
    expect(env.config).toContain('sk-ocr-secret-admin');
    expect(env.config).not.toContain('scrypt$aabb');
    expect(env.config).not.toContain('passwordHash');
  });

  it('default env exports from its scaffolded envs/default tree, writing NOTHING', () => {
    // New book-sets world (post-Phase-2 external rebinding): 'default' is a
    // real env under <home>/envs/default, materialized at boot by
    // ensureEnvScaffold — its config.yaml by ensureDefaultConfigFile.
    const paths = ensureEnvScaffold(DEFAULT_ENV_NAME);
    fs.writeFileSync(paths.configPath, 'port: 3000\nhost: 127.0.0.1\n', 'utf8');
    const env = buildEnvelope(DEFAULT_ENV_NAME, { includeSecrets: false });
    expect(env.source).toEqual({ name: 'default', type: 'regular', appVersion: expect.any(String) });
    expect(parse(env.config).port).toBe(3000);
    expect(env.payload).toEqual({});
    // read-only: export must not create any state files beyond the scaffold dirs
    expect(fs.readdirSync(paths.dataDir)).toEqual([]);
    expect(fs.existsSync(paths.webauthSecretPath)).toBe(false);
  });

  it('missing config.yaml → EnvArchiveError 404', () => {
    fs.mkdirSync(path.join(HOME, 'envs', 'empty'), { recursive: true });
    try {
      buildEnvelope('empty', { includeSecrets: false });
      expect('should have thrown').toBe('thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvArchiveError);
      expect((err as EnvArchiveError).code).toBe(404);
    }
  });
});

/* ─── parseAndValidateEnvelope ───────────────────────────────────────────── */

describe('parseAndValidateEnvelope — happy + sanitizing', () => {
  it('valid redacted envelope round-trips with sentinels STRIPPED ENTIRELY', async () => {
    await seedAlpha();
    const env = buildEnvelope('alpha', { includeSecrets: false });
    const v = parseAndValidateEnvelope(JSON.parse(JSON.stringify(env)));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.name).toBe('alpha');
    expect(v.config).not.toContain('__REDACTED__');
    const cfg = parse(v.config);
    expect(cfg.adminApiKey).toBeUndefined();
    expect(cfg.providers[0].apiKey).toBeUndefined(); // key removed, not imported as literal
    expect('apiKey' in cfg.providers[0]).toBe(false);
    expect(cfg.apiKeys[0].key).toBeUndefined();
    expect(cfg.webAuth.username).toBe('admin');
    expect(v.configWasSanitized).toBe(true);
    expect(v.payload['data/flywheel.jsonl']).toContain('{"v":1}');
  });

  it('clean (included-secrets) envelope keeps its exact config text', async () => {
    await seedAlpha();
    const env = buildEnvelope('alpha', { includeSecrets: true });
    const v = parseAndValidateEnvelope(JSON.parse(JSON.stringify(env)));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.configWasSanitized).toBe(false);
    expect(v.config).toBe(env.config);
    const cfg = parse(v.config);
    expect(cfg.providers[0].apiKey).toBe('sk-provider-real');
  });

  it('hand-crafted passwordHash is stripped defensively (re-written config)', () => {
    const config = 'webAuth:\n  enabled: true\n  username: admin\n  passwordHash: scrypt$aa$bb\n';
    const env = sign({
      format: ENVELOPE_FORMAT,
      version: 1,
      name: 'pwnet',
      payload: {},
      config,
    });
    const v = parseAndValidateEnvelope(env);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.config).not.toContain('passwordHash');
    expect(v.config).not.toContain('scrypt$aa');
  });
});

describe('parseAndValidateEnvelope — guards', () => {
  const good = () => ({
    format: ENVELOPE_FORMAT,
    version: 1,
    name: 'bravo',
    payload: { 'data/flywheel.jsonl': 'row\n' },
    config: 'port: 3000\n',
  });

  it('wrong format → 400', () => {
    const v = parseAndValidateEnvelope(sign({ ...good(), format: 'something-else' }));
    expect(v).toMatchObject({ ok: false, code: 400 });
    if (!v.ok) expect(v.error).toMatch(/ocr-env/);
  });

  it('version above supported max → 400 "newer OCR"', () => {
    const v = parseAndValidateEnvelope(sign({ ...good(), version: ENVELOPE_VERSION + 1 }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/newer OCR/i);
  });

  it('missing checksums → 400 (fail loud, they are required)', () => {
    const env = { ...good() };
    delete (env as Record<string, unknown>).checksums;
    const v = parseAndValidateEnvelope(env);
    expect(v).toMatchObject({ ok: false, code: 400 });
  });

  it('tampered payload → checksum mismatch naming the entry', () => {
    const env = sign(good());
    env.payload['data/flywheel.jsonl'] = 'row\nEXTRA\n';
    const v = parseAndValidateEnvelope(env);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/data\/flywheel.jsonl/);
  });

  it('tampered config → checksum mismatch on config', () => {
    const env = sign(good());
    env.config = 'port: 9999\n';
    const v = parseAndValidateEnvelope(env);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/"config"/);
  });

  it('checksum for unknown entry → 400', () => {
    const env = sign(good());
    env.checksums['webauth-secret'] = 'sha256:whatever';
    const v = parseAndValidateEnvelope(env);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/unknown entry/);
  });

  it('reserved/invalid names → 400', () => {
    for (const name of ['default', 'current', 'has space', 'x'.repeat(33)]) {
      const v = parseAndValidateEnvelope(sign({ ...good(), name }));
      expect(v.ok).toBe(false);
    }
  });

  it('path-traversal payload keys → 400 (each signature checked)', () => {
    for (const key of ['../escape.txt', '/etc/passwd', 'C:\\Windows\\evil', 'a\0b', 'nested/../../x', 'data/./x']) {
      const env = sign({ ...good(), payload: { [key]: 'x' } });
      const v = parseAndValidateEnvelope(env);
      expect(v.ok).toBe(false);
    }
    // a legitimate nested key passes
    const env = sign({ ...good(), payload: { 'data/layer2-decisions.jsonl': 'x' } });
    expect(parseAndValidateEnvelope(env).ok).toBe(true);
  });
});

/* ─── safeResolveWithin ──────────────────────────────────────────────────── */

describe('safeResolveWithin', () => {
  it('accepts env-relative keys, rejects escaping ones, re-verifies prefix', () => {
    const dir = path.resolve(HOME, 'envs', 'x');
    expect(safeResolveWithin(dir, 'data/flywheel.jsonl')).toBe(path.join(dir, 'data', 'flywheel.jsonl'));
    expect(safeResolveWithin(dir, '../evil')).toBeNull();
    expect(safeResolveWithin(dir, '..')).toBeNull();
    expect(safeResolveWithin(dir, 'a/../../evil')).toBeNull();
    expect(safeResolveWithin(dir, '/abs')).toBeNull();
    expect(safeResolveWithin(dir, 'C:\\abs')).toBeNull();
    expect(safeResolveWithin(dir, 'nul\0name')).toBeNull();
    expect(safeResolveWithin(dir, '')).toBeNull();
    expect(safeResolveWithin(dir, 'data//double')).toBeNull();
  });
});

/* ─── P1-1 payload whitelist (unit) ──────────────────────────────────────── */

describe('parseAndValidateEnvelope — payload key whitelist', () => {
  it('reserved env filenames as payload keys → 400 (signed correctly)', () => {
    for (const key of ['config.yaml', 'webauth-secret', 'env.json']) {
      const payload = { [key]: 'evil-content' };
      const config = 'port: 3000\n';
      const v = parseAndValidateEnvelope({
        format: ENVELOPE_FORMAT,
        version: 1,
        name: 'whitelisted',
        config,
        payload,
        checksums: { config: sha(config), [key]: sha('evil-content') },
      });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toMatch(/Unsupported payload key/);
    }
    // the four known data keys still pass
    const config = 'port: 3000\n';
    const payload = {
      'data/flywheel.jsonl': 'a\n',
      'data/layer2-decisions.jsonl': 'b\n',
      'models/layer1-classifier.json': '{}',
      'catalog/custom.json': '{}',
    };
    const v = parseAndValidateEnvelope({
      format: ENVELOPE_FORMAT,
      version: 1,
      name: 'whitelisted',
      config,
      payload,
      checksums: { config: sha(config), ...Object.fromEntries(Object.entries(payload).map(([k, t]) => [k, sha(t)])) },
    });
    expect(v.ok).toBe(true);
  });
});

/* ─── P2-1 redaction gaps ────────────────────────────────────────────────── */

describe('buildEnvelope — redaction completeness', () => {
  async function seedConfig(name: string, yamlText: string): Promise<void> {
    await createEnv({ name });
    fs.writeFileSync(path.join(HOME, 'envs', name, 'config.yaml'), yamlText, 'utf8');
  }

  it('numeric adminApiKey is still redacted (type-agnostic sentinel)', async () => {
    await seedConfig('num', 'adminApiKey: 123456\n');
    const env = buildEnvelope('num', { includeSecrets: false });
    expect(env.redactedPaths).toEqual(['adminApiKey']);
    expect(parse(env.config).adminApiKey).toBe('__REDACTED__');
    expect(env.config).not.toContain('123456');
  });

  it('proxy.url with inline credentials is redacted; a plain URL is kept', async () => {
    await seedConfig('px', 'proxy:\n  url: http://corp-user:s3cret@10.0.0.1:7890\n');
    const env = buildEnvelope('px', { includeSecrets: false });
    expect(env.redactedPaths).toEqual(['proxy.url']);
    expect(env.config).not.toContain('s3cret');
    expect(parse(env.config).proxy.url).toBe('__REDACTED__');

    await seedConfig('px2', 'proxy:\n  url: http://127.0.0.1:7890\n');
    const plain = buildEnvelope('px2', { includeSecrets: false });
    expect(plain.redactedPaths).toEqual([]);
    expect(parse(plain.config).proxy.url).toBe('http://127.0.0.1:7890');
  });

  it('opencode.password is redacted', async () => {
    await seedConfig('opc', 'opencode:\n  password: hunter2\n  baseUrl: https://x.example\n');
    const env = buildEnvelope('opc', { includeSecrets: false });
    expect(env.redactedPaths).toEqual(['opencode.password']);
    expect(env.config).not.toContain('hunter2');
    expect(parse(env.config).opencode.baseUrl).toBe('https://x.example');
  });
});

/* ─── P3-4 dangerous keys ────────────────────────────────────────────────── */

describe('dangerous keys (__proto__/constructor/prototype)', () => {
  it('empirical pin: yaml.parse surfaces __proto__ as an OWN key without prototype change', () => {
    const p = parse('__proto__: { polluted: true }\nport: 3000\n') as any;
    expect(Object.hasOwn(p, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined(); // no global pollution
  });

  it('import STRIPS dangerous keys from the config before writing', () => {
    const config = '__proto__: { polluted: true }\nconstructor: { x: 1 }\nport: 3000\n';
    const v = parseAndValidateEnvelope(
      sign({ format: ENVELOPE_FORMAT, version: 1, name: 'danger', payload: {}, config })
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.configWasSanitized).toBe(true);
    expect(v.config).not.toContain('__proto__');
    expect(v.config).not.toContain('constructor');
    expect(v.config).not.toContain('polluted');
    const written = parse(v.config) as any;
    expect(written.polluted).toBeUndefined();
    expect(written.port).toBe(3000);
  });
});

/* ─── Zip transport : codec + guards ────────────────── */

describe('zip transport — buildZipArchive / parseZipArchiveAsync', () => {
  it('build → parse round-trips through the SAME envelope validation', async () => {
    await createEnv({ name: 'zipper' });
    fs.writeFileSync(getEnvPaths('zipper').configPath, 'adminApiKey: sk-live\n', 'utf8');
    fs.mkdirSync(getEnvPaths('zipper').dataDir, { recursive: true });
    fs.writeFileSync(path.join(getEnvPaths('zipper').dataDir, 'flywheel.jsonl'), 'row\n', 'utf8');

    const bytes = buildZipArchive('zipper', { includeSecrets: false });
    // The archive itself carries the redacted form...
    const entries = unzipSync(bytes);
    expect(strFromU8(entries['config.yaml'])).toContain('__REDACTED__');
    const v = await parseZipArchiveAsync(bytes, 'rezipped');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.name).toBe('rezipped'); // override honored over the source name
    // ...while import strips the sentinel wholesale (never a literal value).
    expect(v.config).not.toContain('__REDACTED__');
    expect(v.payload['data/flywheel.jsonl']).toBe('row\n');
  });

  it('includePayload subsets the payload (manifest checksums follow)', async () => {
    await createEnv({ name: 'subset' });
    const bytes = buildZipArchive('subset', { includeSecrets: false, includePayload: [] });
    const entries = unzipSync(bytes);
    expect(entries['config.yaml']).toBeDefined();
    expect(entries['models/layer1-classifier.json']).toBeUndefined();
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    expect(Object.keys(manifest.checksums)).toEqual(['config']);
  });

  it('non-zip bytes → 400; zip without manifest / config.yaml → 400', async () => {
    const notZip = await parseZipArchiveAsync(strToU8('hello world, definitely not a zip'));
    expect(notZip.ok).toBe(false);

    const bare = zipSync({ 'config.yaml': strToU8('port: 1\n') }); // no manifest
    expect((await parseZipArchiveAsync(bare)).ok).toBe(false);

    const noCfg = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'ocr-env', version: 1 })),
    });
    expect((await parseZipArchiveAsync(noCfg)).ok).toBe(false);
  });

  it('manifest that is not an ocr-env object → 400', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'other', version: 1 })),
      'config.yaml': strToU8('port: 1\n'),
    });
    const v = await parseZipArchiveAsync(bytes);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/ocr-env/);
  });

  it('an oversized whitelisted entry → explicit 400 (never a silent skip)', async () => {
    const big = 'x'.repeat(ZIP_MAX_ENTRY_BYTES + 1);
    const manifest = {
      format: 'ocr-env',
      version: 1,
      source: { name: 'a', type: 'regular', appVersion: 'x' },
      secrets: 'redacted',
      redactedPaths: [],
      checksums: { config: sha('port: 1\n'), 'data/flywheel.jsonl': sha(big) },
    };
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'config.yaml': strToU8('port: 1\n'),
      'data/flywheel.jsonl': strToU8(big),
    });
    const v = await parseZipArchiveAsync(bytes);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/decompression cap|zip bomb/i);
  }, 20000);

  it('non-whitelisted entries are skipped even alongside valid content', async () => {
    const manifest = {
      format: 'ocr-env',
      version: 1,
      source: { name: 'a', type: 'regular', appVersion: 'x' },
      secrets: 'redacted',
      redactedPaths: [],
      checksums: { config: sha('port: 1\n') },
    };
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'config.yaml': strToU8('port: 1\n'),
      '__MACOSX/junk': strToU8('junk'),
      'env.json': strToU8('{"type":"sandbox"}'),
    });
    const v = await parseZipArchiveAsync(bytes);
    expect(v.ok).toBe(true); // junk ignored, import proceeds
    if (!v.ok) return;
    expect(v.type).toBe('regular'); // the env.json entry could NOT flip the type
  });
});

/* ─── Encrypted archive (WinZip AE-2 via zip.js) ────── */

describe('encrypted archive — buildEncryptedZipArchive / parseZipArchiveAsync', () => {
  it('is a STANDARD zip (PK magic) whose entries are flagged encrypted — 360 Zip/7-Zip territory', async () => {
    await createEnv({ name: 'enczip' });
    fs.writeFileSync(getEnvPaths('enczip').configPath, 'adminApiKey: sk-live\n', 'utf8');
    const bytes = await buildEncryptedZipArchive('enczip', { includeSecrets: false, password: 'pw-12345' });
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    // A plain reader (no password) still lists the entries and sees the flag.
    const reader = new ZipReader(new BlobReader(new Blob([bytes])));
    const entries = await reader.getEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.encrypted)).toBe(true);
    await reader.close();
  });

  it('server-driven gate: no password → needs-password 400; wrong password → no-oracle 400', async () => {
    await createEnv({ name: 'encgate' });
    const bytes = await buildEncryptedZipArchive('encgate', { includeSecrets: false, password: 'pw-12345' });
    const noPw = await parseZipArchiveAsync(bytes);
    expect(noPw.ok).toBe(false);
    if (noPw.ok) return;
    expect(noPw.error).toMatch(/encrypted — supply the x-ocr-archive-password header/);

    const wrong = await parseZipArchiveAsync(bytes, undefined, 'totally-wrong');
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toMatch(/decryption failed/i);
  });

  it('round-trips through the SAME envelope validation; override honored; sentinels stripped on import', async () => {
    await createEnv({ name: 'encrt' });
    fs.writeFileSync(getEnvPaths('encrt').configPath, 'adminApiKey: sk-live\n', 'utf8');
    fs.mkdirSync(getEnvPaths('encrt').dataDir, { recursive: true });
    fs.writeFileSync(path.join(getEnvPaths('encrt').dataDir, 'flywheel.jsonl'), 'row\n', 'utf8');
    const bytes = await buildEncryptedZipArchive('encrt', { includeSecrets: false, password: 'pw-12345' });
    const v = await parseZipArchiveAsync(bytes, 'enc-override', 'pw-12345');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.name).toBe('enc-override');
    expect(v.config).not.toContain('__REDACTED__'); // sentinel stripped wholesale on import
    expect(v.payload['data/flywheel.jsonl']).toBe('row\n');
  });

  it('refuses an empty password at build time', async () => {
    await expect(buildEncryptedZipArchive('encrt', { includeSecrets: false, password: '' })).rejects.toThrow(EnvArchiveError);
  });
});
