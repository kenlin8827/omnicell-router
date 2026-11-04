import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseJsonc } from 'jsonc-parser';
import { OpenClawClientAdapter } from '../src/cli/clients/openclaw.js';

/** Tolerant read for assertions — the adapter's own contract is comment-safe JSONC. */
const readConfig = (p: string): any => parseJsonc(fs.readFileSync(p, 'utf8'), undefined, { allowTrailingComma: true });

const ORIGINAL_CONFIG = `// user comment — must survive every adapter write
{
  "channels": {
    "telegram": { "enabled": true },
  },
  "agents": {
    "defaults": { "model": { "primary": "anthropic/claude-sonnet-4" } },
  },
}
`;

describe('OpenClaw client adapter', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-openclaw-'));
    configPath = path.join(tmpDir, 'openclaw.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const adapter = () => {
    const a = new OpenClawClientAdapter();
    a.getConfigPath = () => configPath;
    // Pin the vendor-CLI resolution too: on a machine with the openclaw CLI
    // installed, the probe would otherwise redirect every test at the real
    // user config instead of this sandbox file.
    a.resolveConfigPath = async () => configPath;
    return a;
  }

  it('setup writes the provider + primary pin, preserving comments and unrelated keys', async () => {
    fs.writeFileSync(configPath, ORIGINAL_CONFIG, 'utf8');
    const res = await adapter().setup({
      port: 4321,
      apiKey: 'ocr-key-123',
      models: { main: 'auto' },
      extraModels: ['combo-x'],
    });
    expect(res.success).toBe(true);

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('// user comment — must survive every adapter write');
    // Strict-schema discipline: adapter state lives in the sidecar, never in the config.
    expect(raw).not.toContain('_ocr');
    expect(raw).not.toContain('omnicell-router-managed');

    const data = readConfig(configPath);
    const provider = data.models.providers['omnicell-router'];
    expect(provider.baseUrl).toBe('http://127.0.0.1:4321/v1');
    expect(provider.api).toBe('openai-completions');
    expect(provider.apiKey).toBe('ocr-key-123');
    const ids = provider.models.map((m: any) => m.id);
    expect(ids).toEqual(['auto', 'lite', 'plus', 'pro', 'ultra', 'combo-x']);
    expect(provider.models[0]).toEqual({ id: 'auto', name: 'auto' });
    expect(data.agents.defaults.model.primary).toBe('omnicell-router/auto');
    // Unrelated user config rides through untouched.
    expect(data.channels.telegram.enabled).toBe(true);

    // First pre-hook snapshot only — the backup is the ORIGINAL config.
    expect(fs.readFileSync(`${configPath}.bak.ocr`, 'utf8')).toBe(ORIGINAL_CONFIG);

    const status = await adapter().getStatus();
    expect(status.hooked).toBe(true);
    expect(status.exists).toBe(true);
    expect(status.backupExists).toBe(true);
    expect(status.modelSlots[0]).toEqual({ key: 'main', value: 'auto', default: 'auto' });
    expect(status.extraModels).toEqual(['combo-x']);
  });

  it('teardown restores the original config verbatim (comments included)', async () => {
    fs.writeFileSync(configPath, ORIGINAL_CONFIG, 'utf8');
    await adapter().setup({ port: 4000, apiKey: 'k' });
    const res = await adapter().teardown();
    expect(res.success).toBe(true);

    expect(fs.readFileSync(configPath, 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(false);
    expect(fs.existsSync(`${configPath}.ocr-meta.json`)).toBe(false);

    const status = await adapter().getStatus();
    expect(status.hooked).toBe(false);
  });

  it('teardown without a backup strips every node the setup created', async () => {
    // Setup on a machine with no prior openclaw.json: the adapter creates the file.
    await adapter().setup({ port: 4000, apiKey: 'k', models: { main: 'pro' } });
    expect(fs.existsSync(configPath)).toBe(true);
    expect(readConfig(configPath).agents.defaults.model.primary).toBe('omnicell-router/pro');

    const res = await adapter().teardown();
    expect(res.success).toBe(true);
    // No user content existed, so the empty containers are removed entirely.
    expect(readConfig(configPath)).toEqual({});
    expect(await adapter().getStatus()).toMatchObject({ hooked: false });
  });

  it('repeat setup keeps the FIRST backup and the FIRST previous primary', async () => {
    fs.writeFileSync(configPath, ORIGINAL_CONFIG, 'utf8');
    await adapter().setup({ port: 4000, apiKey: 'k' });
    // Second setup: the backup must not be overwritten with the hooked config.
    await adapter().setup({ port: 4000, apiKey: 'k', models: { main: 'ultra' } });
    expect(fs.readFileSync(`${configPath}.bak.ocr`, 'utf8')).toBe(ORIGINAL_CONFIG);

    await adapter().teardown();
    const data = readConfig(configPath);
    expect(data.models?.providers?.['omnicell-router']).toBeUndefined();
    expect(data.agents.defaults.model.primary).toBe('anthropic/claude-sonnet-4');
  });

  it('follow mode scopes the virtual tier block to the admitted subset', async () => {
    await adapter().setup({
      port: 4000,
      apiKey: 'k',
      models: { main: 'auto' },
      virtualModels: ['auto', 'plus'],
    });
    const ids = readConfig(configPath).models.providers['omnicell-router'].models.map((m: any) => m.id);
    expect(ids).toEqual(['auto', 'plus']);
  });

  it('setup refuses a config it cannot safely edit (JSON5 unquoted keys)', async () => {
    fs.writeFileSync(configPath, '{ models: { providers: {} } }', 'utf8');
    const res = await adapter().setup({ port: 4000, apiKey: 'k' });
    expect(res.success).toBe(false);
    expect(res.message).toContain('refusing to overwrite');
    const status = await adapter().getStatus();
    expect(status.hooked).toBe(false);
  });

  it('setup refuses when no gateway API key is given', async () => {
    const res = await adapter().setup({ port: 4000 });
    expect(res.success).toBe(false);
    expect(res.message).toContain('API key');
  });

  it('setup refuses a hand-edited scalar where an object node belongs', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ models: 'nope' }), 'utf8');
    const res = await adapter().setup({ port: 4000, apiKey: 'k' });
    expect(res.success).toBe(false);
    expect(res.message).toContain("'models' must be an object");
  });
  it('setup migrates the vendor string shorthand and teardown restores the string', async () => {
    const SHORTHAND_CONFIG = `{
  "agents": { "defaults": { "model": "openai/gpt-6-luna" } },
}
`;
    fs.writeFileSync(configPath, SHORTHAND_CONFIG, 'utf8');
    const res = await adapter().setup({ port: 4000, apiKey: 'k' });
    expect(res.success).toBe(true);

    const data = readConfig(configPath);
    expect(data.agents.defaults.model.primary).toBe('omnicell-router/auto');
    expect(data.models.providers['omnicell-router']).toBeDefined();

    await adapter().teardown();
    // The pre-hook shorthand string comes back verbatim, not as an object.
    expect(readConfig(configPath).agents.defaults.model).toBe('openai/gpt-6-luna');
    expect(readConfig(configPath).models?.providers?.['omnicell-router']).toBeUndefined();
  });
  it('setup pins fallback/utility/decision slots and teardown restores each pre-hook value', async () => {
    fs.writeFileSync(configPath, ORIGINAL_CONFIG, 'utf8');
    const res = await adapter().setup({
      port: 4000,
      apiKey: 'k',
      models: { main: 'auto', fallback: 'lite', utility: 'lite', decision: 'pro' },
    });
    expect(res.success).toBe(true);

    const data = readConfig(configPath);
    expect(data.agents.defaults.model.fallbacks).toEqual(['omnicell-router/lite']);
    expect(data.agents.defaults.utilityModel).toBe('omnicell-router/lite');
    expect(data.agents.defaults.decisionModel).toBe('omnicell-router/pro');

    // Status echoes the slots back (sidecar values, prefix stripped).
    const status = await adapter().getStatus();
    const byKey = Object.fromEntries(status.modelSlots.map(s => [s.key, s.value]));
    expect(byKey).toMatchObject({ fallback: 'lite', utility: 'lite', decision: 'pro' });

    // 'auto' is the unset sentinel: re-pinning decision to auto disables it.
    await adapter().setup({ port: 4000, apiKey: 'k', models: { main: 'auto', decision: 'auto' } });
    expect(readConfig(configPath).agents.defaults.decisionModel).toBeUndefined();

    const td = await adapter().teardown();
    expect(td.success).toBe(true);
    const restored = readConfig(configPath);
    // fallbacks rode inside the model node — restored verbatim with it.
    expect(restored.agents.defaults.model).toEqual({ primary: 'anthropic/claude-sonnet-4' });
    expect(restored.agents.defaults.utilityModel).toBeUndefined();
    expect(restored.agents.defaults.decisionModel).toBeUndefined();
  });

});

