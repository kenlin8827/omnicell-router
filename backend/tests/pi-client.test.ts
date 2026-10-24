import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PiClientAdapter } from '../src/cli/clients/pi.js';
import { setGatewayMetaDeps, type GatewayMetaDeps } from '../src/cli/clients/model-meta.js';
import type { ProviderRegistry } from '../src/providers/registry.js';
import type { CatalogProviderRecord } from '../src/opencode/catalog/types.js';

/**
 * Pi adapter: profile-link layer (sidecar echo, write-through, unlink,
 * teardown sidecar cleanup). Each test gets a sandboxed config dir — the
 * adapter's settings path derives from getConfigPath, so overriding it
 * isolates both models.json and settings.json.
 */
describe('Pi client adapter — profile links', () => {
  let tmpDir: string;
  let configPath: string;
  let adapter: PiClientAdapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pi-test-'));
    configPath = path.join(tmpDir, 'models.json');
    adapter = new PiClientAdapter();
    adapter.getConfigPath = () => configPath;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));

  it('setup applies linked + manual role bindings, records the sidecar echo, and presets never steal explicit roles', async () => {
    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' }, // worker: manual foreign pin
      agentModels: { scout: 'lite' }, // scout: profile-linked (resolved)
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });
    expect(res.success).toBe(true);

    // The hook lands in models.json; the linked ref is exposed so pi can
    // resolve the override against the provider's declared ids.
    const cfg = readJson(configPath);
    expect(cfg.providers['omnicell-router'].baseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(cfg.providers['omnicell-router'].models.some((m: any) => m.id === 'lite')).toBe(true);

    // settings.json: the linked role is qualified, the manual foreign pin is
    // verbatim, and a preset role (researcher — discoverable roster is empty in
    // the sandbox, so the preset table applies) got its tier default.
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    expect(settings.subagents.agentOverrides.scout.model).toBe('omnicell-router/lite');
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');
    expect(settings.subagents.agentOverrides.researcher.model).toBe('omnicell-router/lite');

    // Sidecar echo (never settings.json — a running pi wipes foreign keys there).
    const meta = readJson(`${configPath}.ocr-meta.json`);
    expect(meta.profile).toEqual({ id: 'p1', bindings: { scout: 'flash' } });

    const status = await adapter.getStatus();
    expect(status.hooked).toBe(true);
    expect(status.profile?.id).toBe('p1');
    expect(status.profile?.bindings.scout).toBe('flash');
  });

  it('refreshProfileBindings re-points linked roles only and is a no-op when nothing changed', async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      agentModels: { scout: 'lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'qwen-max' });
    expect(res.success).toBe(true);
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    expect(settings.subagents.agentOverrides.scout.model).toBe('omnicell-router/qwen-max');
    // Manual foreign pin untouched by the write-through.
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');
    // The new ref joined the provider models list.
    const cfg = readJson(configPath);
    expect(cfg.providers['omnicell-router'].models.some((m: any) => m.id === 'qwen-max')).toBe(true);

    // No-diff save → explicit no-op (no settings rewrite).
    const again = await adapter.refreshProfileBindings('p1', { scout: 'flash' }, { flash: 'qwen-max' });
    expect(again.message).toContain('already up to date');
  });

  it("refreshProfileBindings treats an 'auto' slot ref as inherit and strips the override", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.refreshProfileBindings('p1', { scout: 'autoSlot' }, { autoSlot: 'auto' });
    expect(res.success).toBe(true);
    const settings = readJson(path.join(tmpDir, 'settings.json'));
    // The role had only the model field — the whole entry is pruned; no
    // literal omnicell-router/auto pin is ever written.
    expect(settings.subagents.agentOverrides.scout).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain('omnicell-router/auto"');
  });

  it("setup with profile id '' un-links: tagged roles fall back to presets, manual pins survive, echo clears", async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      agentModels: { scout: 'lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });

    const res = await adapter.setup({
      port: 4000,
      models: { main: 'auto', worker: 'anthropic/claude-x' },
      profile: { id: '', bindings: {} },
    });
    expect(res.success).toBe(true);

    const settings = readJson(path.join(tmpDir, 'settings.json'));
    // The linked role's override was stripped and the tier preset refilled it.
    expect(settings.subagents.agentOverrides.scout.model).toBe('omnicell-router/lite');
    // The manual foreign pin survived the un-link.
    expect(settings.subagents.agentOverrides.worker.model).toBe('anthropic/claude-x');

    const meta = readJson(`${configPath}.ocr-meta.json`);
    expect(meta.profile).toBeUndefined();
    expect((await adapter.getStatus()).profile).toBeUndefined();
  });

  it('teardown removes the sidecar along with the hook', async () => {
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      agentModels: { scout: 'lite' },
      profile: { id: 'p1', bindings: { scout: 'flash' } },
    });
    expect(fs.existsSync(`${configPath}.ocr-meta.json`)).toBe(true);

    const res = await adapter.teardown();
    expect(res.success).toBe(true);
    expect(fs.existsSync(`${configPath}.ocr-meta.json`)).toBe(false);
    expect((await adapter.getStatus()).profile).toBeUndefined();
  });
});

/**
 * Pi adapter: model-metadata completeness. pi's /thinking picker reads
 * `reasoning` + `thinkingLevelMap` from each models.json entry — absent, the
 * model reads as non-thinking and no thinking level can be set (the bug this
 * suite pins). Registry/catalog truth comes through the GatewayMetaDeps seam;
 * without it (standalone CLI) aliases still carry their static declaration
 * and concrete ids stay bare.
 */
describe('Pi client adapter — model metadata', () => {
  let tmpDir: string;
  let configPath: string;
  let adapter: PiClientAdapter;
  let deps: GatewayMetaDeps | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pi-meta-test-'));
    configPath = path.join(tmpDir, 'models.json');
    adapter = new PiClientAdapter();
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

  const readJson = (p: string): any => JSON.parse(fs.readFileSync(p, 'utf8'));
  const entryOf = (cfg: any, id: string): any =>
    cfg.providers['omnicell-router'].models.find((m: any) => m.id === id);
  /** One-provider catalog record wrapping a single model def. */
  const rec = (id: string, o: Record<string, any>): CatalogProviderRecord => ({
    id, custom: false, connected: true, sources: [], models: [o as any],
  });

  const injectDeps = (overrides: {
    models?: Record<string, any>;
    combos?: (string | { id: string; models: (string | { id: string })[] })[];
    variants?: string[];
    catalog?: CatalogProviderRecord[];
    /** tier alias → candidate pool (getCandidateModelsForTier stub) */
    tierPools?: Record<string, any[]>;
  }) => {
    const models = overrides.models ?? {};
    const stub = {
      getModel: (id: string) => models[id],
      getCombos: () => (overrides.combos ?? []).map((c) => typeof c === 'string' ? { id: c, models: [] } : c),
      getVariantExposures: () => (overrides.variants ?? []).map((id) => ({
        id, base: models[id.split('-').slice(0, -1).join('-')] ?? Object.values(models)[0], variant: { id: 'xhigh', reasoningEffort: 'xhigh' },
      })),
      getCandidateModelsForTier: (tier: string) => overrides.tierPools?.[tier] ?? [],
    } as unknown as ProviderRegistry;
    deps = {
      registry: stub,
      catalogList: async () => overrides.catalog ?? [],
    };
    setGatewayMetaDeps(() => deps);
  };

  it('aliases carry the static full-ladder thinking declaration even without injected deps (CLI path)', async () => {
    await adapter.setup({ port: 4000, models: { main: 'auto' }, extraModels: ['pro'] });
    const cfg = readJson(configPath);
    for (const id of ['auto', 'pro']) {
      const e = entryOf(cfg, id);
      expect(e.reasoning).toBe(true);
      expect(e.thinkingLevelMap).toEqual({
        off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      });
      expect(typeof e.name).toBe('string');
    }
  });

  it('concrete registered models resolve effort support, pricing and catalog display fields', async () => {
    injectDeps({
      models: {
        'prov/thinker': {
          id: 'prov/thinker', provider: 'prov', upstreamModel: 'thinker', tier: 'pro',
          pricing: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1.25 },
          supportedReasoningEfforts: ['none', 'low', 'high'],
        },
      },
      catalog: [{
        id: 'prov', custom: false, connected: true, sources: [],
        models: [{
          id: 'thinker', name: 'Thinker 5', reasoning: true,
          cost: { input: 2, output: 8, cache_read: 0.5, cache_write: 1.25 },
          limit: { context: 200000, output: 32000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        }],
      }],
    });
    await adapter.setup({ port: 4000, models: { main: 'auto' }, extraModels: ['prov/thinker'] });
    const e = entryOf(readJson(configPath), 'prov/thinker');
    expect(e).toEqual({
      id: 'prov/thinker',
      name: 'Thinker 5',
      contextWindow: 200000,
      maxTokens: 32000,
      reasoning: true,
      thinkingLevelMap: {
        off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null,
      },
      input: ['text', 'image'],
      cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1.25 },
    });
  });

  it('models without explicit effort control declare reasoning:false; combos stay permissive; variants pin silently', async () => {
    injectDeps({
      models: {
        'prov/toggle': {
          id: 'prov/toggle', provider: 'prov', upstreamModel: 'toggle', tier: 'lite',
          pricing: { input: 1, output: 4, cacheRead: 0.25 },
          supportedReasoningEfforts: [],
        },
      },
      combos: ['my-combo'],
      variants: ['prov/toggle-xhigh'],
    });
    await adapter.setup({
      port: 4000,
      models: { main: 'auto' },
      extraModels: ['prov/toggle', 'my-combo', 'prov/toggle-xhigh'],
    });
    const cfg = readJson(configPath);
    expect(entryOf(cfg, 'prov/toggle').reasoning).toBe(false);
    expect(entryOf(cfg, 'prov/toggle').thinkingLevelMap).toBeUndefined();
    expect(entryOf(cfg, 'my-combo').reasoning).toBe(true);
    expect(entryOf(cfg, 'my-combo').thinkingLevelMap.off).toBe('none');
    expect(entryOf(cfg, 'prov/toggle-xhigh').reasoning).toBe(false);
  });

  it('combos aggregate member capabilities: min limits, leader cost, intersection image input', async () => {
    injectDeps({
      combos: [{ id: 'my-combo', models: ['prov/leader', 'prov/follower'] }],
      catalog: [
        rec('prov', {
          id: 'leader', name: 'Leader 5', reasoning: true,
          cost: { input: 2, output: 8, cache_read: 0.5, cache_write: 1 },
          limit: { context: 200000, output: 32000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        }),
        rec('prov', {
          id: 'follower', name: 'Follower', reasoning: true,
          cost: { input: 1, output: 4 },
          limit: { context: 128000, output: 16000 },
          modalities: { input: ['text'], output: ['text'] },
        }),
      ],
    });
    await adapter.setup({ port: 4000, models: { main: 'auto' }, extraModels: ['my-combo'] });
    const e = entryOf(readJson(configPath), 'my-combo');
    expect(e.contextWindow).toBe(128000); // min across members — compaction-safe
    expect(e.maxTokens).toBe(16000);
    expect(e.input).toBeUndefined(); // follower lacks image — no image claim
    expect(e.cost).toEqual({ input: 2, output: 8, cacheRead: 0.5, cacheWrite: 1 }); // leader pricing
    expect(e.reasoning).toBe(true); // ladder stays permissive
    expect(e.thinkingLevelMap.off).toBe('none');
  });

  it('tier aliases aggregate the member envelope; auto spans the whole ladder with the lite leader pricing', async () => {
    const reg = (id: string, o: Record<string, any>): CatalogProviderRecord => ({
      id, custom: false, connected: true, sources: [], models: [o as any],
    });
    const poolEntry = (id: string, provider: string, pricing: any) => ({ id, provider, upstreamModel: id.split('/').pop(), pricing });
    injectDeps({
      tierPools: {
        lite: [poolEntry('prov/lite-a', 'prov', { input: 1, output: 4, cacheRead: 0.2 })],
        pro: [
          poolEntry('prov/pro-a', 'prov', { input: 5, output: 20, cacheRead: 1 }),
          poolEntry('prov/pro-b', 'prov', { input: 4, output: 16, cacheRead: 0.8 }),
        ],
        // plus/ultra empty — auto's cost leader must come from lite
      },
      catalog: [
        rec('prov', { id: 'lite-a', name: 'Lite A', limit: { context: 128000, output: 16000 }, modalities: { input: ['text'], output: ['text'] } }),
        rec('prov', { id: 'pro-a', name: 'Pro A', limit: { context: 200000, output: 32000 }, modalities: { input: ['text', 'image'], output: ['text'] } }),
        rec('prov', { id: 'pro-b', name: 'Pro B', limit: { context: 256000, output: 32000 }, modalities: { input: ['text', 'image'], output: ['text'] } }),
      ],
    });
    await adapter.setup({ port: 4000, models: { main: 'auto' }, extraModels: ['lite', 'pro'] });
    const cfg = readJson(configPath);
    const lite = entryOf(cfg, 'lite');
    expect(lite.contextWindow).toBe(128000); // own pool only
    expect(lite.maxTokens).toBe(16000);
    expect(lite.input).toBeUndefined(); // no image claim
    expect(lite.cost.input).toBe(1); // lite leader pricing
    expect(lite.reasoning).toBe(true); // ladder stays permissive
    const auto = entryOf(cfg, 'auto');
    expect(auto.contextWindow).toBe(128000); // min across lite+pro union
    expect(auto.maxTokens).toBe(16000);
    expect(auto.input).toBeUndefined(); // lite-a lacks image — no claim
    expect(auto.cost.input).toBe(1); // first tier in ladder order (lite) leads
    // static alias names survive the aggregation
    expect(auto.name).toBe('Auto');
    expect(lite.name).toBe('Lite');
  });

  it('unresolvable ids fall back to the bare entry with the user context window', async () => {
    injectDeps({});
    await adapter.setup({ port: 4000, models: { main: 'auto' }, extraModels: ['obscure/model-x'], contextWindow: 262144 });
    const e = entryOf(readJson(configPath), 'obscure/model-x');
    expect(e).toEqual({ id: 'obscure/model-x', contextWindow: 262144 });
  });

  it('refreshProfileBindings adds missing refs with metadata and never rewrites existing entries', async () => {
    injectDeps({
      models: {
        'prov/thinker': {
          id: 'prov/thinker', provider: 'prov', upstreamModel: 'thinker', tier: 'pro',
          pricing: { input: 2, output: 8, cacheRead: 0.5 },
          supportedReasoningEfforts: ['low', 'medium', 'high'],
        },
      },
    });
    await adapter.setup({ port: 4000, models: { main: 'auto' } });
    // Hand-edited existing record must survive the write-through untouched.
    const handEdited = { id: 'legacy', contextWindow: 999, maxTokens: 123 };
    const cfg0 = readJson(configPath);
    cfg0.providers['omnicell-router'].models.push(handEdited);
    fs.writeFileSync(configPath, JSON.stringify(cfg0));

    const res = await adapter.refreshProfileBindings('p1', { scout: 'slot' }, { slot: 'prov/thinker' });
    expect(res.success).toBe(true);
    const cfg = readJson(configPath);
    const added = entryOf(cfg, 'prov/thinker');
    expect(added.reasoning).toBe(true);
    expect(added.thinkingLevelMap.high).toBe('high');
    expect(added.thinkingLevelMap.xhigh).toBeNull();
    // existing entries — including the hand-edited one — untouched
    expect(cfg.providers['omnicell-router'].models.find((m: any) => m.id === 'legacy')).toEqual(handEdited);
  });
});
