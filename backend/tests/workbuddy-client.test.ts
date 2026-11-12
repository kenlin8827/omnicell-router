import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  WorkBuddyClientAdapter,
  workbuddyConfigCandidates,
  resolveWorkbuddyConfigPath,
} from '../src/cli/clients/workbuddy.js';
import { setGatewayMetaDeps, type GatewayMetaDeps } from '../src/cli/clients/model-meta.js';
import type { ProviderRegistry } from '../src/providers/registry.js';
import type { CatalogProviderRecord } from '../src/opencode/catalog/types.js';

/**
 * WorkBuddy adapter: the config hook writes the vendor's user-level
 * models.json. Every test owns a disposable config dir — setup/teardown
 * override getConfigPath, path-resolution tests own the env vars.
 */
describe('WorkBuddy client adapter — config hook', () => {
  let tmpDir: string;
  let configPath: string;
  let adapter: WorkBuddyClientAdapter;

  const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-workbuddy-test-'));
    configPath = path.join(tmpDir, 'models.json');
    adapter = new WorkBuddyClientAdapter();
    adapter.getConfigPath = () => configPath;
  });

  afterEach(() => {
    setGatewayMetaDeps(undefined);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('setup writes a valid WorkBuddy custom-model row on a /v1 root URL', async () => {
    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      apiKey: 'ocr-test-key',
      extraModels: ['prov/thinker'],
      contextWindow: 128000,
    });
    expect(res.success).toBe(true);

    const cfg = readJson(configPath);
    expect(Array.isArray(cfg.models)).toBe(true);
    // WorkBuddy normalizes a /v1 base to /v1/chat/completions; a full path
    // would be stripped and re-appended to the same thing but is not portable.
    expect(cfg.models[0].url).toBe('http://127.0.0.1:4000/v1');
    expect(cfg.models[0].apiKey).toBe('ocr-test-key');
    expect(cfg.models[0].vendor).toBe('OmniCellRouter');
    expect(cfg.models[0].useCustomProtocol).toBe(false);
    expect(cfg.models[0].supportsToolCall).toBe(true);
    expect(cfg.models[0].maxInputTokens).toBe(128000);
    // main + the five virtual tiers + the concrete extra, deduped.
    expect(cfg.models.map((m: any) => m.id)).toEqual([
      'auto', 'lite', 'plus', 'pro', 'ultra', 'prov/thinker',
    ]);
    // availableModels is NOT injected when the user file did not declare it —
    // that key replaces WorkBuddy's built-in model list.
    expect(cfg.availableModels).toBeUndefined();

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.modelSlots[0].value).toBe('auto');
    expect(status.extraModels).toEqual(['prov/thinker']);
  });

  it('setup merges into an existing object config and extends an explicit availableModels', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      models: [
        { id: 'my-ollama', name: 'My Ollama', vendor: 'Ollama', url: 'http://localhost:11434/v1', apiKey: 'ollama' },
      ],
      availableModels: ['built-in-a', 'my-ollama'],
      someOtherKey: true,
    }), 'utf8');

    const res = await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'k' });
    expect(res.success).toBe(true);
    expect(fs.existsSync(`${configPath}.bak.ocr`)).toBe(true);

    const cfg = readJson(configPath);
    expect(cfg.someOtherKey).toBe(true); // unrelated keys preserved verbatim
    expect(cfg.models[0]).toEqual({
      id: 'my-ollama', name: 'My Ollama', vendor: 'Ollama',
      url: 'http://localhost:11434/v1', apiKey: 'ollama',
    });
    expect(cfg.availableModels).toContain('built-in-a');
    expect(cfg.availableModels).toContain('auto');
    expect(cfg.availableModels).toContain('lite');
  });

  it('setup preserves the bare-array shape and other users models', async () => {
    fs.writeFileSync(configPath, JSON.stringify([
      { id: 'foreign', name: 'Foreign', vendor: 'Custom', url: 'https://example.com/v1', apiKey: 'x' },
    ]), 'utf8');

    const res = await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'k', virtualModels: [] });
    expect(res.success).toBe(true);
    const cfg = readJson(configPath);
    expect(Array.isArray(cfg)).toBe(true);
    expect(cfg[0].id).toBe('foreign');
    expect(cfg.filter((m: any) => m.vendor === 'OmniCellRouter')).toHaveLength(1);
  });

  it('setup accepts an empty models.json (WorkBuddy itself skips empty files)', async () => {
    fs.writeFileSync(configPath, '   \n', 'utf8');
    const res = await adapter.setup({ port: 4000, apiKey: 'k', virtualModels: [] });
    expect(res.success).toBe(true);
    expect(readJson(configPath).models).toHaveLength(1);
  });

  it('setup refuses to overwrite an unparseable config', async () => {
    fs.writeFileSync(configPath, '{ broken', 'utf8');
    const res = await adapter.setup({ port: 4000, apiKey: 'k' });
    expect(res.success).toBe(false);
    expect(res.message).toContain('Could not parse');
  });

  it('re-setup replaces only OCR rows and keeps the previous key when none is supplied', async () => {
    await adapter.setup({ port: 4000, apiKey: 'first-key', virtualModels: [] });
    fs.writeFileSync(configPath, JSON.stringify({
      models: [
        ...readJson(configPath).models,
        { id: 'another', name: 'Another', vendor: 'Custom', url: 'https://x/v1', apiKey: 'y' },
      ],
    }), 'utf8');

    const res = await adapter.setup({ port: 4000, models: { main: 'pro' }, virtualModels: [] });
    expect(res.success).toBe(true);
    const cfg = readJson(configPath);
    expect(cfg.models).toHaveLength(2); // one OCR row + the user's own
    expect(cfg.models[0].id).toBe('another');
    const ocr = cfg.models[1];
    expect(ocr.id).toBe('pro');
    expect(ocr.apiKey).toBe('first-key');
  });

  it('teardown strips only OCR rows and prunes the ids from availableModels', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      models: [{ id: 'mine', name: 'Mine', vendor: 'Custom', url: 'https://x/v1', apiKey: 'y' }],
      availableModels: ['built-in-a', 'mine'],
    }), 'utf8');
    await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'k' });

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    const cfg = readJson(configPath);
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0].id).toBe('mine');
    expect(cfg.availableModels).toEqual(['built-in-a', 'mine']);
    expect((await adapter.getStatus()).hooked).toBe(false);
  });

  it('teardown is restore-then-strip: a repeat-setup backup cannot leave the hook behind', async () => {
    await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'k', virtualModels: [] });
    // Second setup snapshots the already-hooked file into .bak.ocr.
    await adapter.setup({ port: 4000, models: { main: 'pro' }, apiKey: 'k', virtualModels: [] });
    expect(readJson(`${configPath}.bak.ocr`).models.length).toBeGreaterThan(0);

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    expect((await adapter.getStatus()).hooked).toBe(false);
    expect(readJson(configPath).models).toHaveLength(0);
  });

  it('teardown is a no-op success when the hook is already absent', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ models: [] }), 'utf8');
    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    expect(res.message).toContain('No OCR hook present');
  });

  /**
   * supportsImages comes from the live gateway catalog via the model-meta
   * seam (same envelope math as pi's `input` modalities): a virtual ref is
   * image-true only when EVERY tier member declares image input; a concrete
   * id follows its own catalog record. Without injected deps (standalone
   * CLI) nothing resolves and every row stays false — the conservative
   * legacy claim.
   */
  describe('setup capability envelope (catalog-driven supportsImages)', () => {
    const injectDeps = (overrides: {
      models?: Record<string, any>;
      catalog?: CatalogProviderRecord[];
      tierPools?: Record<string, any[]>;
    }) => {
      const stub = {
        getModel: (id: string) => overrides.models?.[id],
        getCombos: () => [],
        getVariantExposures: () => [],
        getCandidateModelsForTier: (tier: string) => overrides.tierPools?.[tier] ?? [],
      } as unknown as ProviderRegistry;
      const deps: GatewayMetaDeps = {
        registry: stub,
        catalogList: async () => overrides.catalog ?? [],
      };
      setGatewayMetaDeps(() => deps);
    };

    const catModel = (id: string, image: boolean): CatalogProviderRecord['models'][number] =>
      ({ id, modalities: { input: image ? ['text', 'image'] : ['text'], output: ['text'] } } as any);

    it('concrete image-capable row claims supportsImages, text-only row does not', async () => {
      injectDeps({
        models: {
          'prov/visionary': { id: 'prov/visionary', provider: 'prov', upstreamModel: 'visionary' },
          'prov/thinker': { id: 'prov/thinker', provider: 'prov', upstreamModel: 'thinker' },
        },
        catalog: [{
          id: 'prov', custom: false, connected: true, sources: [],
          models: [catModel('visionary', true), catModel('thinker', false)],
        }],
      });
      await adapter.setup({ port: 4000, models: { main: 'prov/visionary' }, apiKey: 'k', extraModels: ['prov/thinker'], virtualModels: [] });
      const cfg = readJson(configPath);
      const byId = Object.fromEntries(cfg.models.map((m: any) => [m.id, m]));
      expect(byId['prov/visionary'].supportsImages).toBe(true);
      expect(byId['prov/thinker'].supportsImages).toBe(false);
    });

    it('tier alias claims images only when EVERY member is image-capable', async () => {
      injectDeps({
        tierPools: { pro: [{ id: 'prov/a' }, { id: 'prov/b' }] },
        catalog: [{
          id: 'prov', custom: false, connected: true, sources: [],
          models: [catModel('a', true), catModel('b', false)],
        }],
      });
      await adapter.setup({
        port: 4000, models: { main: 'pro' }, apiKey: 'k',
        virtualModels: ['pro'],
        // 'pro' is the main id; the envelope still resolves it as a tier alias.
      });
      const pro = readJson(configPath).models.find((m: any) => m.id === 'pro');
      expect(pro.supportsImages).toBe(false);

      // All members capable → true.
      injectDeps({
        tierPools: { pro: [{ id: 'prov/a' }, { id: 'prov/b' }] },
        catalog: [{
          id: 'prov', custom: false, connected: true, sources: [],
          models: [catModel('a', true), catModel('b', true)],
        }],
      });
      await adapter.setup({ port: 4000, models: { main: 'pro' }, apiKey: 'k', virtualModels: [] });
      const pro2 = readJson(configPath).models.find((m: any) => m.id === 'pro');
      expect(pro2.supportsImages).toBe(true);
    });

    it('without injected deps every row keeps the conservative false claim', async () => {
      setGatewayMetaDeps(undefined);
      await adapter.setup({ port: 4000, models: { main: 'auto' }, apiKey: 'k', extraModels: ['prov/thinker'] });
      for (const m of readJson(configPath).models) {
        expect(m.supportsImages).toBe(false);
        expect(m.supportsToolCall).toBe(true);
      }
    });
  });
});

describe('WorkBuddy config path resolution', () => {
  let tmpDir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_DATA_FOLDER_NAME'];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-workbuddy-path-'));
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('WORKBUDDY_CONFIG_DIR is the one authoritative override', () => {
    process.env.WORKBUDDY_CONFIG_DIR = tmpDir;
    expect(workbuddyConfigCandidates()).toEqual([path.join(tmpDir, 'models.json')]);
    expect(resolveWorkbuddyConfigPath()).toBe(path.join(tmpDir, 'models.json'));
  });

  it('CODEBUDDY_CONFIG_DIR is the legacy override', () => {
    process.env.CODEBUDDY_CONFIG_DIR = tmpDir;
    expect(resolveWorkbuddyConfigPath()).toBe(path.join(tmpDir, 'models.json'));
  });

  it('WORKBUDDY_DATA_FOLDER_NAME renames the folder under the home dir', () => {
    process.env.WORKBUDDY_DATA_FOLDER_NAME = '.workbuddy-international';
    expect(workbuddyConfigCandidates()).toEqual([
      path.join(os.homedir(), '.workbuddy-international', 'models.json'),
    ]);
  });

  it('the three edition folders are candidates in active-edition order', () => {
    expect(workbuddyConfigCandidates()).toEqual([
      path.join(os.homedir(), '.workbuddy', 'models.json'),
      path.join(os.homedir(), '.workbuddy-ai', 'models.json'),
      path.join(os.homedir(), '.codebuddy', 'models.json'),
    ]);
  });

  it('an existing file wins over a mere folder; the default is the first candidate', () => {
    const primary = path.join(tmpDir, '.workbuddy', 'models.json');
    const secondary = path.join(tmpDir, '.workbuddy-ai', 'models.json');
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.mkdirSync(path.dirname(secondary), { recursive: true });
    // Both folders exist, but only the second has the actual config file.
    expect(resolveWorkbuddyConfigPath([primary, secondary])).toBe(primary);
    fs.writeFileSync(secondary, '{}', 'utf8');
    expect(resolveWorkbuddyConfigPath([primary, secondary])).toBe(secondary);
    // With neither file nor folder present the declared default is used.
    expect(resolveWorkbuddyConfigPath([
      path.join(tmpDir, 'absent-a', 'models.json'),
      path.join(tmpDir, 'absent-b', 'models.json'),
    ])).toBe(path.join(tmpDir, 'absent-a', 'models.json'));
  });
});
