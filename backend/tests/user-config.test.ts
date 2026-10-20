import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listConfigProviders,
  upsertCustomProvider,
  deleteCustomProvider,
  getProviderNodeById,
  maskSecret,
  expandEnvTemplate,
} from '../src/opencode/user-config.js';
import { authSnapshot } from '../src/opencode/credentials/auth-snapshot.js';
import { resolveDefaultPaths } from '../src/opencode/credentials/paths.js';
import {
  getProviderDefsPath,
  readProviderDefsFile,
  writeProviderDefs,
} from '../src/opencode/provider-defs.js';

/** auth.json's single reader-side path (credentials layer owns the file). */
const authJsonPath = () => resolveDefaultPaths().authJsonPath;

/**
 * Test fixture only: OCR never writes auth.json, so a case
 * that needs a snapshot on disk stages it directly instead of through a product API.
 */
function stageAuth(entries: Record<string, unknown>): void {
  const p = authJsonPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries), 'utf8');
}

describe('OpenCode user-config (provider defs file)', () => {
  let tmpDir: string;
  let oldConfigHome: string | undefined;
  let oldDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-userconfig-'));
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    fs.rmSync(getProviderDefsPath(), { force: true });
  });

  afterEach(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates the native slot; a non-inline key is refused by the writer (the store owns it)', () => {
    // The route pushes such a key through store.connectKey first and passes no apiKey.
    const refused = upsertCustomProvider({
      id: 'home-lab',
      name: 'Home Lab',
      baseURL: 'http://192.168.1.10:20180/v1',
      apiKey: 'sk-test-1234567890',
    });
    expect(refused.success).toBe(false);
    expect(fs.existsSync(getProviderDefsPath())).toBe(false);

    const result = upsertCustomProvider({
      id: 'home-lab',
      name: 'Home Lab',
      baseURL: 'http://192.168.1.10:20180/v1',
      apiKey: 'sk-test-1234567890',
      apiKeyInline: true,
    });
    expect(result.success).toBe(true);

    expect(fs.existsSync(getProviderDefsPath())).toBe(true);

    const parsed: any = readProviderDefsFile();
    expect(parsed.providers['home-lab'].package).toBe('@opencode/ai/providers/openai-compatible');
    expect(parsed.providers['home-lab'].settings.baseURL).toBe('http://192.168.1.10:20180/v1');
    expect(parsed.providers['home-lab'].npm).toBeUndefined();
    // auth.json is never a sink on any binding.
    expect(fs.existsSync(authJsonPath())).toBe(false);
  });

  it('preserves sibling defs map-level when upserting and deleting (the defs file is pure JSON — jsonc byte semantics died with the jsonc truth)', () => {
    writeProviderDefs({
      headroom: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:8787/v1', apiKey: '{env:VOLC_CODING_KEY}' },
      },
    });

    const result = upsertCustomProvider({ id: 'maisuitx', baseURL: 'http://192.168.18.10:20180/v1' });
    expect(result.success).toBe(true);

    let parsed: any = readProviderDefsFile();
    expect(parsed.providers.headroom.settings.baseURL).toBe('http://127.0.0.1:8787/v1');
    // OCR writes the v2 shape: settings, not options.
    expect(parsed.providers.maisuitx.settings.baseURL).toBe('http://192.168.18.10:20180/v1');
    expect(parsed.providers.maisuitx.npm).toBeUndefined();

    // Delete keeps siblings intact
    const del = deleteCustomProvider('maisuitx');
    expect(del.success).toBe(true);
    parsed = readProviderDefsFile()!;
    expect(parsed.providers.maisuitx).toBeUndefined();
    expect(parsed.providers.headroom).toBeDefined();
  });

  it('inline {env:VAR} lands as the v2 `env` name list and still resolves for routing', () => {
    process.env['OCR_TEST_PROVIDER_KEY'] = 'sk-from-env-9876543210';
    const result = upsertCustomProvider({
      id: 'inline',
      baseURL: 'http://10.0.0.1/v1',
      apiKey: '{env:OCR_TEST_PROVIDER_KEY}',
      apiKeyInline: true,
    });
    expect(result.success).toBe(true);

    const parsed: any = readProviderDefsFile();
    // opencode v2 has no inline template concept — the NAME is what gets stored.
    expect(parsed.providers.inline.env).toEqual(['OCR_TEST_PROVIDER_KEY']);
    expect(parsed.providers.inline.settings?.apiKey).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('sk-from-env-9876543210');
    const auth = authSnapshot(resolveDefaultPaths()).read();
    expect(auth['inline']).toBeUndefined();

    // OCR's reader materializes the named var back into the template the pool expands.
    const view = listConfigProviders().find((p) => p.id === 'inline');
    expect(view?.auth.connected).toBe(true);
    expect(view?.auth.keyMasked).toBe('sk-f••••3210');
    delete process.env['OCR_TEST_PROVIDER_KEY'];
  });

  it('lists defs-file providers as a masked view — the auth.json snapshot feeds nothing', () => {
    writeProviderDefs({
      deepseek: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.deepseek.com/v1' } },
    });
    stageAuth({
      deepseek: { type: 'api', key: 'sk-fake-deepseek-0000000042' },
      'kimi-for-coding': { type: 'api', key: 'sk-fake-kimi-00000000xyz' },
    });

    const providers = listConfigProviders();
    // Defs coverage only: no inline key → present but not connected (the bound
    // store supplies connected in the aggregation's union, never this reader).
    const deepseek = providers.find((p) => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.auth.connected).toBe(false);
    expect(deepseek?.baseURL).toBe('https://api.deepseek.com/v1');

    // Snapshot-only ids create NO view rows — the frozen auth.json is a
    // migration source, not a connected-provider masquerade.
    expect(providers.find((p) => p.id === 'kimi-for-coding')).toBeUndefined();
    expect(authSnapshot(resolveDefaultPaths()).read()['kimi-for-coding']).toBeDefined();

    // No raw secrets anywhere in the view
    expect(JSON.stringify(providers)).not.toContain('sk-fake-deepseek-0000000042');
  });

  it('rejects invalid provider ids and unknown deletes', () => {
    const bad = upsertCustomProvider({ id: '../evil', baseURL: 'http://x/v1' });
    expect(bad.success).toBe(false);

    stageAuth({ temp: { type: 'api', key: 'sk-temp-1234567890abc' } });
    expect(authSnapshot(resolveDefaultPaths()).read()['temp']).toBeDefined();

    const missing = deleteCustomProvider('does-not-exist');
    expect(missing.success).toBe(false);
    expect(getProviderNodeById('does-not-exist')).toBeUndefined();
  });

  it('should mask secrets and expand env templates', () => {
    expect(maskSecret(undefined)).toBe('');
    expect(maskSecret('short')).toBe('sh••••');
    expect(maskSecret('sk-very-long-secret-key-xyz')).toBe('sk-v••••-xyz');

    process.env.OCR_TEMPLATE_TEST = 'expanded';
    expect(expandEnvTemplate('{env:OCR_TEMPLATE_TEST}')).toBe('expanded');
    expect(expandEnvTemplate('{env:NOT_SET_ANYWHERE_XYZ}')).toBe('');
    expect(expandEnvTemplate('plain-key')).toBe('plain-key');
  });
});
