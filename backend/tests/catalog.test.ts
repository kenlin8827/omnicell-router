import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig } from '../src/config/index.js';
import { normalizeModelsDev, modelsDevLogoUrl } from '../src/opencode/catalog/sources/models-dev.js';
import { normalizeOpenRouter, OPENROUTER_PROVIDER_ID } from '../src/opencode/catalog/sources/openrouter.js';
import { getProviderDefsPath, writeProviderDefs } from '../src/opencode/provider-defs.js';
import { mergeModels, CatalogRepository, isCustomProvider } from '../src/opencode/catalog/repository.js';
import { readCacheFile, writeCacheFile } from '../src/opencode/catalog/cache.js';
import { readOcrStore, writeOcrStore } from '../src/opencode/catalog/ocr-store.js';
import { ocrCredentialsFile, resolveDefaultPaths } from '../src/opencode/credentials/paths.js';
import { resetCredentialStoreForTests } from '../src/opencode/credentials/factory.js';
import { isAllowedLogoUrl, localLogoApiPath, getLogoCached, writeLogoCache } from '../src/opencode/catalog/logos.js';
import { resolveSources, parseByType, normalizeOpenAICompatible, normalizeMapped } from '../src/opencode/catalog/sources/registry.js';
import { effortLadderFor } from '../src/providers/boot-direct.js';
import { EFFORT_LADDER } from '../src/types/router.js';
import type { CatalogModel } from '../src/opencode/catalog/types.js';

describe('Catalog sources & repository', () => {
  let tmpDir: string;
  let oldCacheHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-'));
    oldCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tmpDir;
    process.env.OCR_CATALOG_PATH = path.join(tmpDir, 'catalog-merged.json');
  });

  afterEach(() => {
    if (oldCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCacheHome;
    delete process.env.OCR_CATALOG_PATH;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('normalizes models.dev providers into the OpenCode schema (identity passthrough)', () => {
    const records = normalizeModelsDev({
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        npm: '@ai-sdk/anthropic',
        api: 'https://api.anthropic.com/v1',
        env: ['ANTHROPIC_API_KEY'],
        models: {
          'claude-haiku': {
            name: 'Claude Haiku',
            reasoning: true,
            tool_call: true,
            temperature: true,
            reasoning_options: [{ type: 'budget_tokens', min: 1024 }],
            limit: { context: 200000, input: 180000, output: 64000 },
            cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
            structured_output: true,
            status: 'beta',
            description: 'Fast Claude model',
            family: 'claude',
            release_date: '2025-10-15',
            last_updated: '2026-01-01',
            open_weights: false,
            knowledge: '2025-07',
            canonical_model_id: 'anthropic/claude-haiku',
            interleaved: { field: 'reasoning_content' },
            experimental: { modes: { fast: { cost: { input: 2 } } } },
          },
          // Next-gen Claude: the raw models.dev data explicitly marks temperature:false
          'claude-opus-5': {
            name: 'Claude Opus 5',
            reasoning: true,
            temperature: false,
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
          },
        },
      },
      broken: null,
    });

    expect(records.length).toBe(1);
    const a = records[0];
    expect(a.id).toBe('anthropic');
    expect(a.logo).toBe('https://models.dev/logos/anthropic.svg');
    const m = a.models[0];
    expect(m.source).toBe('opencode');
    expect(m.tool_call).toBe(true);
    expect(m.reasoning).toBe(true);
    expect(m.limit).toEqual({ context: 200000, input: 180000, output: 64000 });
    expect(m.cost).toEqual({ input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 });
    // Tri-state capability flag + reasoning_options preserved verbatim
    expect(m.temperature).toBe(true);
    expect(m.reasoningOptions).toEqual([{ type: 'budget_tokens', min: 1024 }]);
    // Full models.dev schema passthrough (capability bits + display metadata)
    expect(m.structured_output).toBe(true);
    expect(m.status).toBe('beta');
    expect(m.description).toBe('Fast Claude model');
    expect(m.family).toBe('claude');
    expect(m.release_date).toBe('2025-10-15');
    expect(m.last_updated).toBe('2026-01-01');
    expect(m.open_weights).toBeUndefined(); // false collapses to absent (true-only flag)
    expect(m.knowledge).toBe('2025-07');
    expect(m.canonical_model_id).toBe('anthropic/claude-haiku');
    expect(m.interleaved).toEqual({ field: 'reasoning_content' });
    expect(m.experimental).toEqual({ modes: { fast: { cost: { input: 2 } } } });
    const opus5 = a.models.find((x) => x.id === 'claude-opus-5');
    expect(opus5?.temperature).toBe(false); // explicitly unsupported — must not collapse to missing
    expect(opus5?.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high', 'max'] }]);
    expect(modelsDevLogoUrl('deepseek')).toBe('https://models.dev/logos/deepseek.svg');
  });

  it('normalizes OpenRouter models converting $/token pricing to $/1M', () => {
    const models = normalizeOpenRouter({
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'OpenAI: GPT-4o',
          context_length: 128000,
          pricing: { prompt: '0.0000025', completion: '0.00001', input_cache_read: '0.00000125' },
          top_provider: { max_completion_tokens: 16384 },
          supported_parameters: ['tools', 'temperature'],
        },
        {
          id: 'deepseek/deepseek-r1',
          name: 'DeepSeek: R1',
          pricing: { prompt: '0.0000005', completion: '0.000002' },
          supported_parameters: ['reasoning', 'tools'],
        },
        { no_id: true },
      ],
    });

    expect(models.length).toBe(2);
    const gpt = models[0];
    expect(gpt.cost?.input).toBeCloseTo(2.5, 6); // $/1M
    expect(gpt.cost?.output).toBeCloseTo(10, 6);
    expect(gpt.cost?.cache_read).toBeCloseTo(1.25, 6);
    expect(gpt.limit?.context).toBe(128000);
    expect(gpt.limit?.output).toBe(16384);
    expect(gpt.tool_call).toBe(true);
    expect(gpt.reasoning).toBeUndefined();
    // supported_parameters containing temperature → declared supported; absent → undefined (never false)
    expect(gpt.temperature).toBe(true);
    expect(models[1].reasoning).toBe(true);
    expect(models[1].temperature).toBeUndefined();
  });

  it('maps reasoning_options to supportedReasoningEfforts (effort intersect / budget full ladder / toggle)', () => {
    // effort: intersect with EFFORT_LADDER ('max' is declared on the anthropic wire and survives the intersection)
    expect(
      effortLadderFor({ id: 'm', reasoningOptions: [{ type: 'effort', values: ['low', 'high', 'max'] }] } as CatalogModel, true)
    ).toEqual(['low', 'high', 'max']);
    expect(
      effortLadderFor({ id: 'm', reasoningOptions: [{ type: 'effort', values: ['unknown-level'] }] } as CatalogModel, true)
    ).toEqual([]); // empty intersection → explicit "no level control" (never undefined)
    expect(
      effortLadderFor({ id: 'm', reasoningOptions: [{ type: 'budget_tokens', min: 1024 }] } as CatalogModel, true)
    ).toEqual(EFFORT_LADDER); // continuous budget → full ladder
    expect(effortLadderFor({ id: 'm', reasoningOptions: [{ type: 'toggle' }] } as CatalogModel, true)).toEqual([]);
    // legacy data with no reasoning_options: fall back to the boolean-expanded ladder
    expect(effortLadderFor({ id: 'm' } as CatalogModel, true)).toEqual(EFFORT_LADDER);
    expect(effortLadderFor({ id: 'm' } as CatalogModel, false)).toBeUndefined();
  });

  it('preserves explicit temperature:false through fill-missing merge (first non-blank wins)', () => {
    const backfilled = mergeModels(
      [{ id: 'x', source: 'config' }],
      [{ id: 'x', temperature: false, source: 'openrouter' }]
    );
    expect(backfilled[0].temperature).toBe(false); // missing → backfilled from false
    const kept = mergeModels(
      [{ id: 'z', temperature: true, source: 'config' }],
      [{ id: 'z', temperature: false, source: 'openrouter' }]
    );
    expect(kept[0].temperature).toBe(true); // first source already declared → later source does not override
    const keptFalse = mergeModels(
      [{ id: 'w', temperature: false, source: 'config' }],
      [{ id: 'w', temperature: true, source: 'openrouter' }]
    );
    expect(keptFalse[0].temperature).toBe(false); // false is a non-blank value, so it is never overwritten
  });

  it('merges model lists fill-missing-only: first non-blank value wins, source kept', () => {
    const first: CatalogModel[] = [
      { id: 'a', name: 'A', reasoning: true, cost: { input: 1 }, limit: { context: 200000 }, source: 'config' },
      { id: 'b', name: 'B', source: 'config' },
    ];
    const later: CatalogModel[] = [
      { id: 'a', name: 'A-override-ignored', cost: { input: 99, output: 9 }, limit: { context: 1, output: 8192 }, source: 'openrouter' },
      { id: 'c', name: 'C', source: 'openrouter' },
    ];
    const merged = mergeModels(first, later);
    expect(merged.length).toBe(3);
    const a = merged.find((m) => m.id === 'a');
    expect(a?.name).toBe('A'); // first non-blank wins — later sources never overwrite
    expect(a?.source).toBe('config'); // creating source kept
    expect(a?.cost?.input).toBe(1); // non-blank kept
    expect(a?.cost?.output).toBe(9); // blank filled from later source
    expect(a?.limit?.context).toBe(200000); // kept
    expect(a?.limit?.output).toBe(8192); // filled
    expect(merged.find((m) => m.id === 'b')?.name).toBe('B');
    expect(merged.find((m) => m.id === 'c')?.source).toBe('openrouter');
  });

  it('treats 0 and empty containers as unset (fillable by later sources)', () => {
    const merged = mergeModels(
      [{ id: 'x', cost: { input: 0 }, limit: {}, source: 'config' }],
      [{ id: 'x', cost: { input: 5 }, limit: { context: 4096 }, source: 'openrouter' }]
    );
    expect(merged[0].cost?.input).toBe(5); // zero → fillable
    expect(merged[0].limit?.context).toBe(4096); // empty container → fillable
  });

  it('lockedModels anchor locally maintained values (including explicit zeros)', () => {    const local: CatalogModel[] = [
      { id: 'plan-model', name: 'Subscription', cost: { input: 0, output: 0 }, source: 'config' },
    ];
    const remote: CatalogModel[] = [
      { id: 'plan-model', name: 'Subscription', cost: { input: 5, output: 15 }, limit: { context: 200000 }, source: 'opencode' },
    ];

    // unlocked: 0 is "unset" → backfilled from the remote source (existing semantics)
    const unlocked = mergeModels(local, remote);
    expect(unlocked[0].cost?.input).toBe(5);

    // locked: the locally maintained definition stands untouched — zeros included
    const locked = mergeModels(local, remote, new Set(['plan-model']));
    expect(locked[0].cost?.input).toBe(0);
    expect(locked[0].cost?.output).toBe(0);
    expect(locked[0].limit?.context).toBeUndefined(); // overlay contributed nothing
    expect(locked[0].source).toBe('config');

    // locked ids with NO local entry are unaffected (new models still enter)
    const onlyRemote = mergeModels([], remote, new Set(['plan-model']));
    expect(onlyRemote[0].cost?.input).toBe(5);
  });

  it('ocr store round-trips and validates shape (static local database)', () => {
    expect(readOcrStore()).toBeNull(); // no file yet

    const providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        custom: false,
        connected: false,
        sources: ['config', 'opencode'],
        models: [{ id: 'claude-haiku-4-5', cost: { input: 1 }, source: 'opencode' }],
      },
    ];
    writeOcrStore('sig-1', providers as any);
    const store = readOcrStore();
    expect(store?.version).toBe(4);
    expect(store?.sig).toBe('sig-1');
    expect(store?.builtAt).toBeGreaterThan(0);
    expect(store?.providers[0].id).toBe('anthropic');
    expect(store?.providers[0].models[0].cost?.input).toBe(1);

    // corrupt file → treated as absent (rebuild path kicks in)
    fs.writeFileSync(process.env.OCR_CATALOG_PATH!, '{broken', 'utf8');
    expect(readOcrStore()).toBeNull();
  });

  it('caches catalog payloads to disk (round-trip + stale-on-error)', () => {
    writeCacheFile('unit-test-src', [{ hello: 'world' }]);
    const read = readCacheFile<any[]>('unit-test-src');
    expect(read?.fetchedAt).toBeGreaterThan(0);
    expect(read?.data[0].hello).toBe('world');
    expect(readCacheFile('missing-src')).toBeNull();
  });

  it('openrouter provider id is stable', () => {
    expect(OPENROUTER_PROVIDER_ID).toBe('openrouter');
  });

  it('resolveSources falls back to defaults with opencode as the baseline (first)', () => {
    const defaults = resolveSources(undefined);
    // priority ascending; the disabled models-dev mirror is retained for the console
    expect(defaults.map((s) => s.id)).toEqual(['opencode', 'models-dev', 'openrouter']);
    expect(defaults[0].priority).toBeLessThan(defaults[1].priority);
    expect(defaults[0].url).toBe('https://models.opencode.ai/api.json'); // mandatory baseline
    expect(defaults.find((s) => s.id === 'models-dev')?.enabled).toBe(false); // spare, off by default

    // config override replaces the whole list; DISABLED entries are retained
    // (enabled=false) so the console can list and re-enable them
    const custom = resolveSources([
      { id: 'relay', type: 'openai-compatible', url: 'http://x/v1/models', priority: 10 },
      { id: 'off', type: 'model-list', url: 'https://y', enabled: false },
    ]);
    expect(custom.map((s) => s.id)).toEqual(['relay', 'off']);
    expect(custom.find((s) => s.id === 'off')?.enabled).toBe(false);
  });

  it('parseByType dispatches to the registered normalizer', () => {
    const providers = parseByType('provider-catalog', { anthropic: { name: 'Anthropic', models: {} } });
    expect(providers?.providers?.[0].id).toBe('anthropic');

    const models = parseByType('model-list', { data: [{ id: 'openai/gpt-4o', pricing: { prompt: '0.0000025' } }] });
    expect(models?.models?.[0].cost?.input).toBeCloseTo(2.5, 6);

    const oc = parseByType('openai-compatible', { data: [{ id: 'glm-5.3-flash', context_length: 200000 }] });
    expect(oc?.models?.[0].id).toBe('glm-5.3-flash');
    expect(oc?.models?.[0].limit?.context).toBe(200000);

    expect(parseByType('nope' as any, {})).toBeNull();
  });

  it('normalizeOpenAICompatible accepts bare /v1/models payloads', () => {
    const models = normalizeOpenAICompatible({
      object: 'list',
      data: [{ id: 'model-a' }, { id: 'model-b', name: 'Model B', max_model_len: 8192 }, {}],
    });
    expect(models.length).toBe(2);
    expect(models[1].limit?.context).toBe(8192);
  });

  it('normalizeMapped applies the declarative schema map (zero-code type plugin)', () => {
    const { normalizeMapped } = require('../src/opencode/catalog/sources/registry.js');
    const map = {
      items: 'data.models',
      id: 'model_id',
      name: 'display_name',
      context: 'limits.ctx',
      output: 'limits.max_out',
      inputCost: 'pricing.in',
      outputCost: 'pricing.out',
      costScale: 1e6, // $/token → $/1M
      toolCall: 'supports.tools',
      reasoning: 'supports.reasoning',
      modalitiesInput: 'io.in',
      modalitiesOutput: 'io.out',
    };
    const raw = {
      data: {
        models: [
          {
            model_id: 'glm-5.3-flash',
            display_name: 'GLM 5.3 Flash',
            limits: { ctx: 200000, max_out: 64000 },
            pricing: { in: '0.00000015', out: 0.0000005 },
            supports: { tools: true, reasoning: false },
            io: { in: ['text'], out: ['text'] },
          },
          { no_id: true },
        ],
      },
    };
    const models = normalizeMapped(raw, map);
    expect(models.length).toBe(1);
    const m = models[0];
    expect(m.id).toBe('glm-5.3-flash');
    expect(m.name).toBe('GLM 5.3 Flash');
    expect(m.source).toBe('mapped');
    expect(m.limit).toEqual({ context: 200000, output: 64000 });
    expect(m.cost?.input).toBeCloseTo(0.15, 6); // 0.00000015 × 1e6
    expect(m.cost?.output).toBeCloseTo(0.5, 6);
    expect(m.tool_call).toBe(true);
    expect(m.reasoning).toBe(false);
    expect(m.modalities).toEqual({ input: ['text'], output: ['text'] });
  });

  it('logo proxy path allow-lists hosts and passes unknown URLs through', () => {
    const md = modelsDevLogoUrl('anthropic');
    expect(isAllowedLogoUrl(md)).toBe(true);
    expect(isAllowedLogoUrl('https://openrouter.ai/brand/v2/openrouter-glyph-light.svg')).toBe(true);
    expect(localLogoApiPath(md)).toBe(`/api/admin/catalog/logo?url=${encodeURIComponent(md)}`);
    expect(localLogoApiPath(undefined)).toBeUndefined();

    expect(isAllowedLogoUrl('https://evil.example/logo.svg')).toBe(false);
    expect(isAllowedLogoUrl('http://models.dev/logos/a.svg')).toBe(false); // https only
    expect(localLogoApiPath('https://evil.example/logo.svg')).toBe('https://evil.example/logo.svg');
  });

  it('serves logos from the disk cache without touching the network', async () => {
    const url = modelsDevLogoUrl('unit-test-logo');
    writeLogoCache(url, {
      fetchedAt: Date.now(), // fresh → no fetch attempted
      contentType: 'image/svg+xml',
      base64: Buffer.from('<svg/>').toString('base64'),
    });
    const out = await getLogoCached(url);
    expect(out?.contentType).toBe('image/svg+xml');
    expect(out?.body.toString('utf8')).toBe('<svg/>');

    // non-allow-listed URLs are rejected outright
    expect(await getLogoCached('https://evil.example/logo.svg')).toBeNull();
    expect(await getLogoCached(undefined)).toBeNull();
  });
});

describe('CatalogRepository source management', () => {
  // Unreachable URL that fails FAST (ECONNREFUSED) — no real network in tests.
  const DEAD_URL = 'http://127.0.0.1:9/v1/models';

  let tmpDir: string;
  let oldCacheHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-mgmt-'));
    oldCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tmpDir;
  });

  afterEach(() => {
    if (oldCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCacheHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('the custom badge is DERIVED from builtin-catalog coverage, never stored', () => {
    // ADR-0010 unification amendment: the tag is computed at aggregation time
    // (repository step 5 routes through this ONE predicate) and is never written
    // to any book. Both directions pinned — a self-declared relay is custom,
    // anything a builtin provider catalog covers is not, however it connected.
    expect(isCustomProvider({ sources: ['config'] })).toBe(true);
    expect(isCustomProvider({ sources: ['opencode', 'config'] })).toBe(false);
    expect(isCustomProvider({ sources: ['models-dev'] })).toBe(false);
    expect(isCustomProvider({ sources: ['config', 'models-dev', 'openrouter'] })).toBe(false);
    expect(isCustomProvider({ sources: [] })).toBe(true);
  });

  it('guards the mandatory baseline source (no removal, no disable)', async () => {
    const repo = new CatalogRepository();
    expect(() => repo.removeSource('opencode')).toThrow(/mandatory/);
    await expect(repo.setSourceEnabled('opencode', false)).rejects.toThrow(/mandatory/);
    await expect(
      repo.addSource({ id: 'opencode', type: 'provider-catalog', url: DEAD_URL })
    ).rejects.toThrow(/cannot be redefined/);
  });

  it('adds, lists, toggles and removes sources at runtime', async () => {
    const repo = new CatalogRepository();
    const view = await repo.addSource({
      id: 'Relay_List', // uppercase → normalized lowercase
      type: 'model-list',
      url: DEAD_URL,
      priority: 20,
    });
    expect(view.id).toBe('relay_list');
    expect(view.builtin).toBe(false);
    expect(view.enabled).toBe(true);
    expect(view.priority).toBe(20);
    expect(view.origin).toBe('none'); // dead URL → sync failed, error captured
    expect(view.lastError).toBeTruthy();
    expect(view.records).toBe(0);

    // listed with live state, priority-ascending (builtin 10 → relay_list 20 → openrouter 30)
    expect(repo.sourceStates().map((s) => s.id)).toEqual(['opencode', 'models-dev', 'relay_list', 'openrouter']);

    // validation errors
    await expect(
      repo.addSource({ id: 'relay_list', type: 'model-list', url: DEAD_URL })
    ).rejects.toThrow(/already exists/);
    await expect(repo.addSource({ id: 'x', type: 'model-list', url: DEAD_URL })).rejects.toThrow(/invalid source id/);
    await expect(repo.addSource({ id: 'ok', type: 'nope', url: DEAD_URL })).rejects.toThrow(/unknown source type/);
    await expect(repo.addSource({ id: 'ok', type: 'model-list', url: 'ftp://x' })).rejects.toThrow(/http\(s\)/);

    // disable → row retained with enabled=false; manual refresh stays allowed
    // (dead URL → 'none' again) — disabling only excludes the source from the
    // OCR aggregation, records stay viewable
    const off = await repo.setSourceEnabled('relay_list', false);
    expect(off.enabled).toBe(false);
    expect(repo.sourceStates().find((s) => s.id === 'relay_list')?.enabled).toBe(false);
    const refreshed = await repo.refreshSource('relay_list');
    expect(refreshed.enabled).toBe(false);
    expect(refreshed.origin).toBe('none');
    expect(refreshed.lastError).toBeTruthy();

    // re-enable → syncs again (dead URL, still 'none')
    const on = await repo.setSourceEnabled('relay_list', true);
    expect(on.enabled).toBe(true);

    // remove → row gone, builtin untouched
    repo.removeSource('relay_list');
    expect(repo.sourceStates().map((s) => s.id)).toEqual(['opencode', 'models-dev', 'openrouter']);
    expect(repo.removeSource.bind(repo, 'nope')).toThrow(/not found/);

    // runtime defs are exportable for config persistence
    expect(repo.configuredSources().map((s) => s.id)).toEqual(['opencode', 'models-dev', 'openrouter']);
    expect(repo.configuredSources()[0].url).toBe('https://models.opencode.ai/api.json');
  });

  it('disabled sources stay refreshable + viewable but never enter the OCR aggregation', async () => {
    // Loopback mock source (loopback is never proxied) + hermetic user-config dirs
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'peek-vendor/peek-model', pricing: { prompt: '0.000001' } }] }),
    });
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-cfg-'));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-data-'));
    const oldCfg = process.env.XDG_CONFIG_HOME;
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = tmpCfg;
    process.env.XDG_DATA_HOME = tmpData;
    try {
      const repo = new CatalogRepository();
      await repo.addSource({
        id: 'peek',
        type: 'model-list',
        url: `http://127.0.0.1:${server.port}/v1/models`,
        priority: 40,
      });

      // enabled → the first-party record for the source exists in the aggregation
      expect((await repo.list()).find((p) => p.id === 'peek')).toBeTruthy();

      // disable → record GONE from the aggregation, payload retained for the viewer
      await repo.setSourceEnabled('peek', false);
      expect((await repo.list()).find((p) => p.id === 'peek')).toBeFalsy();
      expect(repo.sourceStates().find((s) => s.id === 'peek')?.records).toBe(1);
      expect(repo.sourceData('peek').models?.[0]?.id).toBe('peek-vendor/peek-model');

      // manual refresh on a disabled source is allowed (cache/view only)
      const refreshed = await repo.refreshSource('peek');
      expect(refreshed.enabled).toBe(false);
      expect(refreshed.origin).toBe('network');
      expect(repo.sourceData('peek').models?.length).toBe(1);
      expect((await repo.list()).find((p) => p.id === 'peek')).toBeFalsy();
    } finally {
      server.stop(true);
      if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldCfg;
      if (oldData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldData;
      try {
        fs.rmSync(tmpCfg, { recursive: true, force: true });
        fs.rmSync(tmpData, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('bound-store credentials mark the provider connected in the aggregation', async () => {
    // A provider with no auth.json entry and no inline defs key reads
    // disconnected from the sourced layers alone — the credential store is the
    // single truth, so its credential presence must flip the flag (and its
    // file mtime must drift the aggregation signature, or the rebuild never
    // happens until restart).
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'peek-vendor/peek-model', pricing: { prompt: '0.000001' } }] }),
    });
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-cfg-'));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-data-'));
    const oldCfg = process.env.XDG_CONFIG_HOME;
    const oldData = process.env.XDG_DATA_HOME;
    const oldOcrHome = process.env.OCR_HOME;
    const credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-catalog-cred-'));
    process.env.XDG_CONFIG_HOME = tmpCfg;
    process.env.XDG_DATA_HOME = tmpData;
    process.env.OCR_HOME = credHome; // ocrCredentialsFile() resolves at call time
    const seed = (providers: Record<string, unknown>) => {
      fs.writeFileSync(
        ocrCredentialsFile(),
        JSON.stringify({ version: 1, providers })
      );
    };
    try {
      // The binding is PROCESS-STICKY and earlier tests in this file already
      // bound a store (aggregate step 4b calls getCredentialStore) against
      // THEIR env — rebind onto this test's sandbox before anything lists.
      resetCredentialStoreForTests(resolveDefaultPaths());
      const repo = new CatalogRepository();
      await repo.addSource({ id: 'peek', type: 'model-list', url: `http://127.0.0.1:${server.port}/v1/models`, priority: 40 });

      // No credential anywhere → sourced layers alone → disconnected
      expect((await repo.list()).find((p) => p.id === 'peek')?.connected).toBe(false);

      // A store credential for the provider → connected, without any other change
      await Bun.sleep(2); // file mtime drives the signature — never write twice in one tick
      seed({ peek: [{ credentialId: 'c1', label: 'k', key: 'sk-test', timeCreated: 1, timeUpdated: 1, active: true }] });
      expect((await repo.list()).find((p) => p.id === 'peek')?.connected).toBe(true);

      // Credential removed → the same drift path restores the sourced flag
      await Bun.sleep(2);
      seed({});
      expect((await repo.list()).find((p) => p.id === 'peek')?.connected).toBe(false);
    } finally {
      server.stop(true);
      // Leave no sticky binding pointed at the deleted sandbox — later tests
      // (auto-pull describe) bind their own world.
      resetCredentialStoreForTests();
      if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldCfg;
      if (oldData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldData;
      if (oldOcrHome === undefined) delete process.env.OCR_HOME;
      else process.env.OCR_HOME = oldOcrHome;
      try {
        fs.rmSync(tmpCfg, { recursive: true, force: true });
        fs.rmSync(tmpData, { recursive: true, force: true });
        fs.rmSync(credHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe('auto-pull sweep end-to-end (regression: TDZ in Phase-1)', () => {
  // Regression for autoPullProviderModels(): Phase-1 used getProviderNodeById
  // before its late destructuring (ReferenceError swallowed by autoPullSafely's
  // catch — the sweep silently did nothing). The provider below points at an
  // unreachable baseURL so the live-fetch branch fails FAST (ECONNREFUSED),
  // exercising Phase-1 without any real network or catalog aggregation.
  let tmpDir: string;
  let oldConfigHome: string | undefined;
  let oldDataHome: string | undefined;
  let oldOcrHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-autopull-'));
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    oldOcrHome = process.env.OCR_HOME;
    process.env.OCR_HOME = path.join(tmpDir, 'home');
    writeProviderDefs({
      'home-lab': {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test' },
      },
    });
    // Opt-in declaration: the sweep only pulls providers with a pattern —
    // '*' keeps the live-fetch regression path attemptable.
    saveConfig({ catalog: { autoPullPatterns: { 'home-lab': '*' } } });
  });

  afterEach(() => {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldOcrHome === undefined) delete process.env.OCR_HOME;
    else process.env.OCR_HOME = oldOcrHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('sweeps every provider without throwing and records the per-provider failure', async () => {
    const { autoPullProviderModels } = await import('../src/opencode/catalog/auto-pull.js');
    // Pre-fix this rejected with `Cannot access 'getProviderNodeById' before initialization`.
    const entries = await autoPullProviderModels();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].providerId).toBe('home-lab');
    expect(entries[0].mode).toBe('live');
    expect(entries[0].pulled).toBe(0);
    expect(entries[0].error).toBeDefined();
  });

  it('skips providers without a declared autoPullPatterns entry (opt-in sweep)', async () => {
    const { autoPullProviderModels } = await import('../src/opencode/catalog/auto-pull.js');
    saveConfig({ catalog: { autoPullPatterns: {} } });
    const entries = await autoPullProviderModels();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ providerId: 'home-lab', mode: 'skipped', pulled: 0 });
  });

  it('bounds the live pull by the declared pattern and writes only matches (ADD-ONLY)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          data: [{ id: 'alpha-one' }, { id: 'alpha-two' }, { id: 'beta-one' }],
        }),
    });
    try {
      writeProviderDefs({
        'home-lab': {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-test' },
        },
      });
      saveConfig({ catalog: { autoPullPatterns: { 'home-lab': 'alpha-*' } } });
      const { autoPullProviderModels } = await import('../src/opencode/catalog/auto-pull.js');
      const entries = await autoPullProviderModels();
      expect(entries).toHaveLength(1);
      // The pattern filtered in Phase-1 — `skipped` counts only matched-but-existing ids.
      expect(entries[0]).toMatchObject({ providerId: 'home-lab', mode: 'live', pulled: 2, skipped: 0 });
      const { getProviderModelDefs } = await import('../src/opencode/user-config.js');
      expect(Object.keys(getProviderModelDefs('home-lab') ?? {}).sort()).toEqual(['alpha-one', 'alpha-two']);
    } finally {
      server.stop(true);
    }
  });

  it('explicit ids narrow the live pull below the pattern (console pull-preview selection)', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          data: [{ id: 'alpha-one' }, { id: 'alpha-two' }, { id: 'beta-one' }],
        }),
    });
    try {
      writeProviderDefs({
        'home-lab': {
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'sk-test' },
        },
      });
      const { autoPullProvider } = await import('../src/opencode/catalog/auto-pull.js');
      const res = await autoPullProvider('home-lab', { ids: ['alpha-two', 'ghost-one'] });
      expect(res.httpStatus).toBe(200);
      // ids ∩ upstream = alpha-two; 'ghost-one' simply matches nothing. No
      // pattern given → the whole upstream list is the candidate pool.
      expect(res.body).toMatchObject({ status: 'ok', live: true, matched: 1, pulled: 1, skipped: 0 });
      const { getProviderModelDefs } = await import('../src/opencode/user-config.js');
      expect(Object.keys(getProviderModelDefs('home-lab') ?? {})).toEqual(['alpha-two']);
    } finally {
      server.stop(true);
    }
  });
});
