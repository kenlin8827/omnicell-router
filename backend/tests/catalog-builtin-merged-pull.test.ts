import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, loadConfig } from '../src/config/index.js';
import { resetEnvPathsForTests } from '../src/config/env.js';
import { writeProviderDefs } from '../src/opencode/provider-defs.js';
import { resetCredentialStoreForTests } from '../src/opencode/credentials/factory.js';

/**
 * Merged pull path for BUILTIN providers (catalog-first + live top-up):
 *  - isBuiltinCatalogProvider classifies first-party catalog coverage
 *  - dryRun previews the catalog∪live union without writing
 *  - a real pull lands catalog metadata (cost/limit) + live-only new ids,
 *    ADD-ONLY over operator-maintained defs
 *  - the periodic sweep reports mode 'merged' with the same union
 * Everything is hermetic: the "models.opencode.ai" baseline and the provider's
 * own /v1/models are both loopback mocks.
 */
describe('builtin provider merged model pull (catalog-first + live top-up)', () => {
  let tmpDir: string;
  let catalogServer: ReturnType<typeof Bun.serve> | undefined;
  let upstreamServer: ReturnType<typeof Bun.serve> | undefined;
  let oldConfigHome: string | undefined;
  let oldDataHome: string | undefined;
  let oldCacheHome: string | undefined;
  let oldOcrHome: string | undefined;
  let oldCatalogPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-merged-pull-'));
    oldConfigHome = process.env.XDG_CONFIG_HOME;
    oldDataHome = process.env.XDG_DATA_HOME;
    oldCacheHome = process.env.XDG_CACHE_HOME;
    oldOcrHome = process.env.OCR_HOME;
    oldCatalogPath = process.env.OCR_CATALOG_PATH;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_CACHE_HOME = path.join(tmpDir, 'cache');
    process.env.OCR_HOME = path.join(tmpDir, 'home');
    // env paths are cached per process (keyed by env name) — the cache holds
    // the PREVIOUS case's tmpDir until dropped, so loadConfig would read a
    // deleted config.yaml and the catalog falls back to the default sources.
    resetEnvPathsForTests();
    // The isolated runner pins OCR_ENV=itest against the sandbox OCR_HOME;
    // overriding OCR_HOME here must carry the env book-set over (config.yaml
    // + env.json), or env resolution loudly refuses.
    const envDir = path.join(tmpDir, 'home', 'envs', 'itest');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, 'config.yaml'), 'port: 3000\nhost: 127.0.0.1\napiKeys: []\nmodels: []\n');
    fs.writeFileSync(path.join(envDir, 'env.json'), JSON.stringify({ name: 'itest', type: 'regular', createdAt: new Date().toISOString(), schemaVersion: 1 }));
    process.env.OCR_CATALOG_PATH = path.join(tmpDir, 'catalog-merged.json');

    // Builtin baseline source: models.dev-shape payload with pricing/limits —
    // the metadata the live /v1/models list will NOT carry.
    catalogServer = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          anthropic: {
            id: 'anthropic',
            name: 'Anthropic',
            npm: '@ai-sdk/anthropic',
            models: {
              'claude-haiku': {
                name: 'Claude Haiku',
                reasoning: true,
                tool_call: true,
                cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
                limit: { context: 200000, output: 64000 },
              },
            },
          },
        }),
    });
    // The provider's own /v1/models: bare ids (live lists carry no pricing),
    // one shared id + one id the catalog does not know yet.
    upstreamServer = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [{ id: 'claude-haiku' }, { id: 'claude-sonnet-new' }] }),
    });

    // Sources pinned to the loopback mocks — zero external network. openrouter
    // disabled so its sync never fires.
    saveConfig({
      catalog: {
        sources: [
          { id: 'opencode', type: 'provider-catalog', url: `http://127.0.0.1:${catalogServer!.port}/api.json`, enabled: true, priority: 10 },
          { id: 'openrouter', type: 'model-list', url: 'http://127.0.0.1:9/models', enabled: false, priority: 30 },
        ],
      },
    });
    writeProviderDefs({
      anthropic: {
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${upstreamServer!.port}/v1`, apiKey: 'sk-test' },
      },
    });
  });

  afterEach(async () => {
    catalogServer?.stop(true);
    upstreamServer?.stop(true);
    resetCredentialStoreForTests();
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldDataHome;
    if (oldCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCacheHome;
    if (oldOcrHome === undefined) delete process.env.OCR_HOME;
    else process.env.OCR_HOME = oldOcrHome;
    if (oldCatalogPath === undefined) delete process.env.OCR_CATALOG_PATH;
    else process.env.OCR_CATALOG_PATH = oldCatalogPath;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  /** Boot parity: applyConfig(loadConfig().catalog) BEFORE start() — index.ts
   *  does exactly this; without it the repo falls back to DEFAULT_CATALOG_SOURCES
   *  and hits the real network. */
  async function bootRepo() {
    const { catalogRepository } = await import('../src/opencode/catalog/repository.js');
    // The singleton survives across tests in one process; without a reset the
    // previous test's sources (dead mock ports) stay pinned — applyConfig is a
    // no-op once started. Fresh instance state per test, then boot parity:
    // applyConfig(loadConfig().catalog) BEFORE start() — index.ts does exactly
    // this; without it the repo falls back to DEFAULT_CATALOG_SOURCES and hits
    // the real network.
    catalogRepository.resetForTests();
    catalogRepository.applyConfig(loadConfig().catalog);
    await catalogRepository.start();
    return catalogRepository;
  }

  it('classifies a first-party catalog provider as builtin', async () => {
    await bootRepo();
    const { isBuiltinCatalogProvider } = await import('../src/opencode/catalog/auto-pull.js');
    expect(await isBuiltinCatalogProvider('anthropic')).toBe(true);
    // A provider absent from the baseline source is not builtin.
    expect(await isBuiltinCatalogProvider('no-such-vendor')).toBe(false);
  });

  it('dryRun previews the catalog∪live union and writes nothing', async () => {
    await bootRepo();
    const { autoPullProvider } = await import('../src/opencode/catalog/auto-pull.js');
    const { getProviderModelDefs } = await import('../src/opencode/user-config.js');
    const res = await autoPullProvider('anthropic', { dryRun: true });
    const { catalogRepository: dbgRepo } = await import('../src/opencode/catalog/repository.js');
    const dbgRec = await dbgRepo.getProvider('anthropic');
    expect(res.httpStatus).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.live).toBe(true); // merged preview
    const ids = (res.body.models as { id: string }[]).map((m) => m.id).sort();
    // catalog ∪ live: the shared id appears ONCE (deduped, catalog entry first)
    expect(ids).toEqual(['claude-haiku', 'claude-sonnet-new']);
    const haiku = (res.body.models as any[]).find((m) => m.id === 'claude-haiku');
    // the catalog entry won the dedup — its metadata is intact
    expect(haiku.cost).toMatchObject({ input: 1, output: 5 });
    expect(haiku.limit).toMatchObject({ context: 200000 });
    // dryRun wrote nothing
    expect(getProviderModelDefs('anthropic') ?? {}).toEqual({});
  });

  it('pull lands catalog metadata + live-only new ids, ADD-ONLY', async () => {
    await bootRepo();
    const { autoPullProvider } = await import('../src/opencode/catalog/auto-pull.js');
    const { getProviderModelDefs, upsertProviderModel } = await import('../src/opencode/user-config.js');

    // Operator-maintained def must survive both passes.
    expect(upsertProviderModel('anthropic', 'my-own-model', { name: 'Mine' }).success).toBe(true);

    const res = await autoPullProvider('anthropic', {});
    expect(res.httpStatus).toBe(200);
    // skipped 2 = two passes each skip one existing id: catalog pass skips the
    // operator's own def (my-own-model, surfaced as a config-source entry),
    // live pass skips claude-haiku which the catalog pass just landed.
    expect(res.body).toMatchObject({ status: 'ok', success: true, live: true, pulled: 2, skipped: 2 });

    const defs = getProviderModelDefs('anthropic') ?? {};
    // live-only id landed (the top-up works)
    expect(Object.keys(defs)).toContain('claude-sonnet-new');
    // catalog metadata is authoritative on the shared id
    expect(defs['claude-haiku']).toMatchObject({ name: 'Claude Haiku', reasoning: true, tool_call: true });
    expect((defs['claude-haiku'] as any).limit?.context).toBe(200000);
    // operator-maintained def untouched (ADD-ONLY both passes)
    expect(Object.keys(defs)).toContain('my-own-model');

    // Re-pull: everything now exists → 0 pulled, nothing rewritten. skipped 5
    // = catalog pass 3 (defs now hold my-own-model + haiku + sonnet-new, all
    // surfaced back as config-source entries) + live pass 2 (both ids exist).
    const again = await autoPullProvider('anthropic', {});
    expect(again.body).toMatchObject({ pulled: 0, skipped: 5 });
  });

  it('periodic sweep reports mode merged with the same union', async () => {
    saveConfig({
      catalog: {
        sources: [
          { id: 'opencode', type: 'provider-catalog', url: `http://127.0.0.1:${catalogServer!.port}/api.json`, enabled: true, priority: 10 },
          { id: 'openrouter', type: 'model-list', url: 'http://127.0.0.1:9/models', enabled: false, priority: 30 },
        ],
        autoPullModels: true,
        autoPullPatterns: { anthropic: 'claude-*' },
      },
    });
    await bootRepo();
    const { autoPullProviderModels } = await import('../src/opencode/catalog/auto-pull.js');
    const { getProviderModelDefs } = await import('../src/opencode/user-config.js');
    const entries = await autoPullProviderModels();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ providerId: 'anthropic', mode: 'merged' });
    // pulled/skipped are racy by design: start()'s background sweep and this
    // explicit call are BOTH ADD-ONLY pulls of the same union — whichever runs
    // first lands the models and the other reports them as skipped. The
    // deterministic contract is the end state:
    const ids = Object.keys(getProviderModelDefs('anthropic') ?? {}).sort();
    expect(ids).toEqual(['claude-haiku', 'claude-sonnet-new']);
  });
});
