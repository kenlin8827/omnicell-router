import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { OmpClientAdapter, resolveOmpModelsPath } from '../src/cli/clients/omp.js';

/**
 * omp adapter: the models.yml provider hook + config.yml modelRoles layer
 * (tier presets, explicit picks, profile links, teardown restore-then-strip)
 * and the YAML round-trip contract (user comments survive every OCR write).
 * Each test gets a sandboxed config dir — the roles path derives from
 * getConfigPath, so overriding it isolates both models.yml and config.yml.
 */
describe('omp client adapter — hook, roles, teardown', () => {
  let tmpDir: string;
  let modelsPath: string;
  let rolesPath: string;
  let adapter: OmpClientAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-omp-test-'));
    modelsPath = path.join(tmpDir, 'models.yml');
    rolesPath = path.join(tmpDir, 'config.yml');
    adapter = new OmpClientAdapter();
    adapter.getConfigPath = () => modelsPath;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const readYml = (p: string): any => parse(fs.readFileSync(p, 'utf8'));

  it('setup writes the provider hook, tier presets, the default role claim, and the sidecar echo', async () => {
    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      apiKey: 'ocr-key-1',
      agentModels: { smol: 'qwen-max' }, // explicit manual pick (bare ref → qualified)
      profile: { id: 'p1', bindings: { slow: 'flash' } },
    });
    expect(res.success).toBe(true);

    // models.yml: the provider hook with model entries.
    const models = readYml(modelsPath);
    const entry = models.providers['omnicell-router'];
    expect(entry.baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(entry.api).toBe('openai-completions');
    expect(entry.apiKey).toBe('ocr-key-1');
    expect(entry.models[0].id).toBe('auto');
    // The explicit bare role ref rides along in the models list.
    expect(entry.models.some((m: any) => m.id === 'qwen-max')).toBe(true);

    // config.yml: explicit pick qualified, preset fills the rest, default claimed.
    const roles = readYml(rolesPath).modelRoles;
    expect(roles.smol).toBe('omnicell-router/qwen-max');
    expect(roles.tiny).toBe('omnicell-router/lite');
    expect(roles.plan).toBe('omnicell-router/pro');
    expect(roles.task).toBe('omnicell-router/plus');
    expect(roles.advisor).toBe('omnicell-router/ultra');
    expect(roles.default).toBe('omnicell-router/auto');
    // vision is deliberately not preset (omp auto-resolves image capability).
    expect(roles.vision).toBeUndefined();

    // Sidecar echo lives OUTSIDE the omp-owned YAML files.
    const meta = JSON.parse(fs.readFileSync(`${modelsPath}.ocr-meta.json`, 'utf8'));
    expect(meta.profile).toEqual({ id: 'p1', bindings: { slow: 'flash' } });

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.profile?.id).toBe('p1');
    expect(status.modelSlots.find(s => s.key === 'smol')?.value).toBe('qwen-max');
    expect(status.modelSlots.find(s => s.key === 'main')?.value).toBe('auto');
  });

  it('setup preserves user comments and foreign providers in both YAML files', async () => {
    fs.writeFileSync(modelsPath, [
      '# my gateway setup',
      'providers:',
      '  # local ollama',
      '  ollama:',
      '    baseUrl: http://127.0.0.1:11434',
      '    api: openai-completions',
      '    auth: none',
      '    models:',
      '      - id: qwen3',
     ].join('\n'), 'utf8');
    fs.writeFileSync(rolesPath, [
      '# role pins',
      'modelRoles:',
      '  vision: google/gemini-3-pro',
      'cycleOrder:',
      '  - default',
      '  - slow',
    ].join('\n'), 'utf8');

    const res = await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(true);

    const modelsRaw = fs.readFileSync(modelsPath, 'utf8');
    expect(modelsRaw).toContain('# my gateway setup');
    expect(modelsRaw).toContain('# local ollama');
    const models = readYml(modelsPath);
    expect(models.providers.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(models.providers['omnicell-router'].baseUrl).toBe('http://127.0.0.1:4000/v1');

    const rolesRaw = fs.readFileSync(rolesPath, 'utf8');
    expect(rolesRaw).toContain('# role pins');
    const rolesDoc = readYml(rolesPath);
    // Foreign pin survives verbatim; unknown top-level keys survive.
    expect(rolesDoc.modelRoles.vision).toBe('google/gemini-3-pro');
    expect(rolesDoc.cycleOrder).toEqual(['default', 'slow']);
  });

  it('setup never steals a foreign role pin and refuses legacy models.json', async () => {
    fs.writeFileSync(rolesPath, 'modelRoles:\n  slow: anthropic/claude-x:high\n', 'utf8');
    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(readYml(rolesPath).modelRoles.slow).toBe('anthropic/claude-x:high');

    fs.rmSync(modelsPath, { force: true });
    fs.rmSync(`${modelsPath}.bak.ocr`, { force: true });
    fs.writeFileSync(path.join(tmpDir, 'models.json'), '{"providers":{}}', 'utf8');
    const res = await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(false);
    expect(res.message).toContain('models.json');
  });

  it("setup with profile id '' un-links: tagged roles fall back to presets, foreign pins survive, echo clears", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { slow: 'anthropic/claude-x' },
      profile: { id: 'p1', bindings: { smol: 'flash' } },
    });

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { slow: 'anthropic/claude-x' },
      profile: { id: '', bindings: {} },
    });
    expect(res.success).toBe(true);

    const roles = readYml(rolesPath).modelRoles;
    // The linked role's entry was stripped and the tier preset refilled it.
    expect(roles.smol).toBe('omnicell-router/lite');
    // The manual foreign pin survived the un-link.
    expect(roles.slow).toBe('anthropic/claude-x');
    expect(JSON.parse(fs.readFileSync(`${modelsPath}.ocr-meta.json`, 'utf8')).profile).toBeUndefined();
  });

  it('refreshProfileBindings re-points linked roles only and is a no-op when nothing changed', async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { smol: 'lite' },
      profile: { id: 'p1', bindings: { smol: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { smol: 'flash' }, { flash: 'qwen-max' });
    expect(res.success).toBe(true);
    expect(readYml(rolesPath).modelRoles.smol).toBe('omnicell-router/qwen-max');
    // The new ref joined the provider models list.
    expect(readYml(modelsPath).providers['omnicell-router'].models.some((m: any) => m.id === 'qwen-max')).toBe(true);

    // No-diff save → explicit no-op.
    const again = await adapter.refreshProfileBindings('p1', { smol: 'flash' }, { flash: 'qwen-max' });
    expect(again.message).toContain('already up to date');
  });

  it("refreshProfileBindings treats an 'auto' slot ref as inherit and strips the entry", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { smol: 'lite' },
      profile: { id: 'p1', bindings: { smol: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { smol: 'autoSlot' }, { autoSlot: 'auto' });
    expect(res.success).toBe(true);
    const roles = readYml(rolesPath).modelRoles;
    // The role had only the router pin — the whole entry is pruned; the tier
    // preset is NOT re-applied by write-through (the next full setup refills it).
    expect(roles.smol).toBeUndefined();
  });

  it('setup handles pre-existing files that carry other keys but no modelRoles/providers node', async () => {
    // Regression: `doc.set(key, {})` on a document with existing content
    // stores the plain JS object raw — a later get() returns a non-node and
    // `.set` crashes with "modelRoles.set is not a function".
    fs.writeFileSync(rolesPath, 'setupVersion: 1\ndefaultThinkingLevel: auto\n', 'utf8');
    fs.writeFileSync(modelsPath, '# only a comment, no providers\n', 'utf8');
    const res = await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(true);
    const roles = readYml(rolesPath);
    expect(roles.modelRoles.default).toBe('omnicell-router/auto');
    expect(roles.modelRoles.smol).toBe('omnicell-router/lite');
    // omp's own keys survive.
    expect(roles.setupVersion).toBe(1);
    expect(roles.defaultThinkingLevel).toBe('auto');
    expect(readYml(modelsPath).providers['omnicell-router'].baseUrl).toBe('http://127.0.0.1:4000/v1');
  });

  it('setup claims the default role unconditionally (wizard residue or foreign pin), teardown restores the original', async () => {
    // omp's old setup wizard writes `router/*` tier selectors — stale residue
    // that must be claimed, or the main session keeps routing around the
    // gateway while every other role goes through it.
    fs.writeFileSync(rolesPath, 'modelRoles:\n  default: router/default\n', 'utf8');
    const res = await adapter.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(true);
    expect(readYml(rolesPath).modelRoles.default).toBe('omnicell-router/auto');

    const teardown = await adapter.teardown();
    expect(teardown.success).toBe(true);
    // Restore-then-strip: the pre-takeover default comes back from the backup.
    expect(readYml(rolesPath).modelRoles.default).toBe('router/default');
  });

  it('teardown removes the hook, the router-owned roles, and the sidecar (backup-contamination safe)', async () => {
    fs.writeFileSync(modelsPath, 'providers:\n  ollama:\n    baseUrl: http://127.0.0.1:11434\n', 'utf8');
    fs.writeFileSync(rolesPath, 'modelRoles:\n  vision: google/gemini-3-pro\n', 'utf8');
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { slow: 'anthropic/claude-x' },
      profile: { id: 'p1', bindings: { smol: 'flash' } },
    });
    // A second setup rewrites the backups with the HOOKED file — teardown
    // must still end clean (restore-then-strip).
    await adapter.setup({ port: 4001, models: { main: 'auto' } });
    expect(fs.existsSync(`${modelsPath}.ocr-meta.json`)).toBe(true);

    const res = await adapter.teardown();
    expect(res.success).toBe(true);

    const models = readYml(modelsPath);
    expect(models.providers['omnicell-router']).toBeUndefined();
    expect(models.providers.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    const roles = readYml(rolesPath).modelRoles;
    // Router-owned presets and the default claim are gone; the deliberate
    // foreign survivor (slow) and the pre-existing vision pin stay.
    for (const role of ['smol', 'tiny', 'commit', 'plan', 'designer', 'task', 'advisor', 'default']) {
      expect(roles[role]).toBeUndefined();
    }
    expect(roles.slow).toBe('anthropic/claude-x');
    expect(roles.vision).toBe('google/gemini-3-pro');
    expect(fs.existsSync(`${modelsPath}.ocr-meta.json`)).toBe(false);
    expect((await adapter.getStatus()).hooked).toBe(false);
  });

  it('prefers models.yml over models.yaml, but hooks models.yaml when it is the only file', async () => {
    const yamlPath = path.join(tmpDir, 'models.yaml');
    fs.writeFileSync(yamlPath, 'providers:\n  ollama:\n    baseUrl: http://x\n', 'utf8');
    // The path preference lives in resolveOmpModelsPath (getConfigPath is
    // stubbed to models.yml for the other tests).
    expect(resolveOmpModelsPath(tmpDir)).toBe(yamlPath);

    const stub = new OmpClientAdapter();
    stub.getConfigPath = () => yamlPath;
    const res = await stub.setup({ port: 4000, models: { main: 'auto' } });
    expect(res.success).toBe(true);
    expect(readYml(yamlPath).providers['omnicell-router']).toBeDefined();

    // Once a models.yml exists, it wins.
    fs.writeFileSync(modelsPath, 'providers: {}\n', 'utf8');
    expect(resolveOmpModelsPath(tmpDir)).toBe(modelsPath);
  });
});
