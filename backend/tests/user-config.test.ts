import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listOpenCodeProviders,
  listConfigProviders,
  upsertCustomProvider,
  deleteCustomProvider,
  getProviderNodeById,
  readAuthEntries,
  maskSecret,
  expandEnvTemplate,
  getOpenCodeConfigPath,
  getOpenCodeAuthPath,
} from '../src/opencode/user-config.js';

/**
 * Test fixture only: OCR never writes auth.json (ADR-0019 Decision 11), so a case
 * that needs a snapshot on disk stages it directly instead of through a product API.
 */
function stageAuth(entries: Record<string, unknown>): void {
  const p = getOpenCodeAuthPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries), 'utf8');
}

describe('OpenCode user-config (opencode.jsonc provider node + auth.json)', () => {
  let tmpDir: string;
  let oldConfigHome: string | undefined;
  let oldDataHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-userconfig-'));
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
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
    expect(fs.existsSync(getOpenCodeConfigPath())).toBe(false);

    const result = upsertCustomProvider({
      id: 'home-lab',
      name: 'Home Lab',
      baseURL: 'http://192.168.1.10:20180/v1',
      apiKey: 'sk-test-1234567890',
      apiKeyInline: true,
    });
    expect(result.success).toBe(true);

    const configPath = getOpenCodeConfigPath();
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsed.providers['home-lab'].package).toBe('@opencode/ai/providers/openai-compatible');
    expect(parsed.providers['home-lab'].settings.baseURL).toBe('http://192.168.1.10:20180/v1');
    expect(parsed.providers['home-lab'].npm).toBeUndefined();
    // auth.json is never a sink on any binding.
    expect(fs.existsSync(getOpenCodeAuthPath())).toBe(false);
  });

  it('must preserve JSONC comments when upserting and deleting providers', () => {
    const configPath = getOpenCodeConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '{',
        '  // Top comment: keep me!',
        '  "model": "zhipuai-coding-plan/glm-5.3-flash",',
        '  "providers": {',
        '    // headroom proxy, tuned by hand',
        '    "headroom": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "{env:VOLC_CODING_KEY}" }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      'utf8'
    );

    const result = upsertCustomProvider({ id: 'maisuitx', baseURL: 'http://192.168.18.10:20180/v1' });
    expect(result.success).toBe(true);

    let raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('// Top comment: keep me!');
    expect(raw).toContain('// headroom proxy, tuned by hand');
    expect(raw).toContain('{env:VOLC_CODING_KEY}');

    let parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(parsed.providers.headroom.options.baseURL).toBe('http://127.0.0.1:8787/v1');
    // OCR writes the native slot in the v2 shape: settings, not options.
    expect(parsed.providers.maisuitx.settings.baseURL).toBe('http://192.168.18.10:20180/v1');
    expect(parsed.providers.maisuitx.npm).toBeUndefined();
    expect(parsed.model).toBe('zhipuai-coding-plan/glm-5.3-flash');

    // Delete keeps comments and siblings intact
    const del = deleteCustomProvider('maisuitx');
    expect(del.success).toBe(true);
    raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('// headroom proxy, tuned by hand');
    parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
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

    const parsed = JSON.parse(fs.readFileSync(getOpenCodeConfigPath(), 'utf8'));
    // opencode v2 has no inline template concept — the NAME is what gets stored.
    expect(parsed.providers.inline.env).toEqual(['OCR_TEST_PROVIDER_KEY']);
    expect(parsed.providers.inline.settings?.apiKey).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('sk-from-env-9876543210');
    const auth = readAuthEntries();
    expect(auth['inline']).toBeUndefined();

    // OCR's reader materializes the named var back into the template the pool expands.
    const view = listConfigProviders().find((p) => p.id === 'inline');
    expect(view?.auth.connected).toBe(true);
    expect(view?.auth.keyMasked).toBe('sk-f••••3210');
    delete process.env['OCR_TEST_PROVIDER_KEY'];
  });

  it('should merge config providers and auth credentials into a safe view', () => {
    fs.mkdirSync(path.dirname(getOpenCodeConfigPath()), { recursive: true });
    fs.writeFileSync(
      getOpenCodeConfigPath(),
      JSON.stringify({ providers: { deepseek: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'https://api.deepseek.com/v1' } } } }),
      'utf8'
    );
    stageAuth({
      deepseek: { type: 'api', key: 'sk-fake-deepseek-0000000042' },
      'kimi-for-coding': { type: 'api', key: 'sk-fake-kimi-00000000xyz' },
    });

    const providers = listOpenCodeProviders();
    const deepseek = providers.find((p) => p.id === 'deepseek');
    expect(deepseek?.auth.connected).toBe(true);
    expect(deepseek?.auth.keyMasked).toBe('sk-f••••0042');
    expect(deepseek?.baseURL).toBe('https://api.deepseek.com/v1');

    const kimi = providers.find((p) => p.id === 'kimi-for-coding');
    expect(kimi?.custom).toBe(false); // credential-only
    expect(kimi?.auth.keyMasked).toBe('sk-f••••0xyz');

    // No raw secrets anywhere in the view
    expect(JSON.stringify(providers)).not.toContain('sk-fake-deepseek-0000000042');
    expect(JSON.stringify(providers)).not.toContain('sk-fake-kimi-00000000');
  });

  it('rejects invalid provider ids and unknown deletes', () => {
    const bad = upsertCustomProvider({ id: '../evil', baseURL: 'http://x/v1' });
    expect(bad.success).toBe(false);

    stageAuth({ temp: { type: 'api', key: 'sk-temp-1234567890abc' } });
    expect(readAuthEntries()['temp']).toBeDefined();

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
