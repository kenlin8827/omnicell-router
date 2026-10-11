import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getAllClientStatuses, setupClient, teardownClient } from '../cli/clients/index.js';
import { ProviderRegistry } from '../providers/registry.js';
import { resolveTierMatch } from '../providers/tier-match.js';
import { resolveTierMembers, matchingTiers, MEMBER_TIER_ORDER, asTierLevel } from '../providers/member-match.js';
import { globMatchAny } from '../utils/glob.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { Layer2Judge } from '../router/layer2-judge.js';
import { getRawConfig, loadConfig, saveConfig, saveRawConfig } from '../config/index.js';
import { initProxyConfig } from '../utils/proxy.js';
import { getOcrHomeDir } from '../cli/paths.js';
import { ensureCa } from '../forward-proxy/ca.js';
import { getForwardProxyStatus } from '../forward-proxy/status.js';
import { RouterConfig } from '../config/types.js';
import type { CatalogModel } from '../opencode/catalog/types.js';
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  validateApiKey,
  validateModelAccess,
} from '../auth/api-keys.js';
import { getModelAccessPolicy, isAutoEntryUsable, isModelAllowed, tierFromVirtualEntry } from '../auth/model-access.js';

export { validateApiKey };

/* ------------------------------------------------------------------------ *
 * Process-log tail helpers (for GET /api/admin/logs).
 * Pino writes NDJSON with a numeric `level`; banner text is plain lines.
 * ------------------------------------------------------------------------ */
const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};
const LEVEL_NAME_TO_NUM: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function parseLogLevelParam(name?: string): number {
  if (!name) return 0; // 0 = no filtering
  return LEVEL_NAME_TO_NUM[name.toLowerCase()] ?? 0;
}

export interface ParsedLogLine {
  raw: string;
  level?: string;
  levelNum?: number;
  time?: number;
  msg?: string;
}

function parseLogLine(raw: string): ParsedLogLine {
  if (!raw.startsWith('{')) return { raw };
  try {
    const j = JSON.parse(raw);
    const levelNum = typeof j.level === 'number' ? j.level : undefined;
    return {
      raw,
      level: levelNum !== undefined ? PINO_LEVELS[levelNum] : undefined,
      levelNum,
      time: typeof j.time === 'number' ? j.time : undefined,
      msg: typeof j.msg === 'string' ? j.msg : undefined,
    };
  } catch {
    return { raw };
  }
}

/**
 * Catalog-style model payload → opencode v2 model definition shape
 * (https://opencode.ai/v2/docs/models/): capabilities{tools,input,output},
 * limit, settings.reasoningEffort, headers, body, compatibility.reasoningField,
 * variants, modelID, disabled.
 */
function bodyToModelDef(body: any): Record<string, any> {
  if (body?.definition && typeof body.definition === 'object') return { ...body.definition };
  const def: Record<string, any> = {};
  if (body?.name) def.name = String(body.name);
  if (body?.modelID) def.modelID = String(body.modelID);
  if (body?.disabled != null) def.disabled = Boolean(body.disabled);

  // capabilities: tools + input/output modality lists (present in payload = full replace)
  const caps: Record<string, any> = {};
  if (body?.capabilities?.tools != null) caps.tools = Boolean(body.capabilities.tools);
  else if (body?.toolCall != null) caps.tools = Boolean(body.toolCall);
  const inList = body?.capabilities?.input ?? body?.modalities?.input;
  if (Array.isArray(inList)) {
    const vals = inList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.input = vals;
  }
  const outList = body?.capabilities?.output ?? body?.modalities?.output;
  if (Array.isArray(outList)) {
    const vals = outList.map((x: any) => String(x)).filter(Boolean);
    if (vals.length > 0) caps.output = vals;
  }
  if (body?.capabilities && typeof body.capabilities === 'object') def.capabilities = caps;
  else if (Object.keys(caps).length > 0) def.capabilities = caps;

  const limit: Record<string, number> = {};
  if (body?.contextLimit) limit.context = Number(body.contextLimit);
  if (body?.outputLimit) limit.output = Number(body.outputLimit);
  if (Object.keys(limit).length > 0) def.limit = limit;

  if (body?.cost && typeof body.cost === 'object') {
    const c: Record<string, number> = {};
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const v = (body.cost as any)[k];
      if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
    }
    if (Object.keys(c).length > 0) def.cost = c;
  }

  // settings.reasoningEffort (thinking level); presence in payload = full replace
  if (body?.settings && typeof body.settings === 'object') {
    const s: Record<string, any> = {};
    if (body.settings.reasoningEffort) s.reasoningEffort = String(body.settings.reasoningEffort);
    def.settings = s;
  } else if (body?.reasoningEffort) {
    def.settings = { reasoningEffort: String(body.reasoningEffort) };
  }

  // headers: { Name: Value } map or "Name: Value" lines (presence = full replace)
  if (body?.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.headers)) {
      if (k && typeof v === 'string' && v) h[k] = v;
    }
    def.headers = h;
  } else if (typeof body?.headersText === 'string') {
    const h: Record<string, string> = {};
    for (const line of body.headersText.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) h[k] = v;
      }
    }
    def.headers = h; // may be {} — clears old headers
  }

  // body: provider-specific request body fields (JSON object; presence = full replace)
  if (body?.body && typeof body.body === 'object' && !Array.isArray(body.body)) {
    def.body = body.body;
  } else if (typeof body?.bodyText === 'string') {
    let parsed: any = {};
    if (body.bodyText.trim()) {
      try {
        parsed = JSON.parse(body.bodyText);
      } catch {
        parsed = {}; // UI validates before submit
      }
    }
    def.body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  // compatibility.reasoningField (presence = full replace)
  if (body?.compatibility && typeof body.compatibility === 'object') {
    const c: Record<string, any> = {};
    if (body.compatibility.reasoningField) c.reasoningField = String(body.compatibility.reasoningField);
    def.compatibility = c;
  }

  // variants: [{ id, settings: { reasoningEffort } }]
  if (Array.isArray(body?.variants)) {
    const variants = body.variants
      .filter((v: any) => v && typeof v === 'object' && v.id)
      .map((v: any) => {
        const entry: Record<string, any> = { id: String(v.id) };
        if (v.settings?.reasoningEffort) entry.settings = { reasoningEffort: String(v.settings.reasoningEffort) };
        return entry;
      });
    if (variants.length > 0) def.variants = variants;
  }
  return def;
}

/** CatalogModel → opencode model definition (moved to opencode/catalog/auto-pull.ts). */

/** v2 def → CatalogModel (custom-store mirror of the editor form payload). */
function defToCatalogModel(id: string, def: Record<string, any>): CatalogModel {
  const caps = def.capabilities && typeof def.capabilities === 'object' ? def.capabilities : {};
  const modalities =
    def.modalities && typeof def.modalities === 'object'
      ? def.modalities
      : caps.input || caps.output
        ? { input: caps.input, output: caps.output }
        : undefined;
  return {
    id,
    name: def.name || undefined,
    reasoning: def.reasoning === true || caps.reasoning === true || undefined,
    tool_call: def.tool_call === true || (typeof caps.tools === 'boolean' ? caps.tools : undefined),
    modalities,
    cost: def.cost && typeof def.cost === 'object' ? def.cost : undefined,
    limit: def.limit && typeof def.limit === 'object' ? def.limit : undefined,
    source: 'custom',
  };
}

/** CatalogModel → v2-ish def (management view for credential-only providers). */
function catalogModelToV2Def(m: CatalogModel): Record<string, any> {
  const def: Record<string, any> = {};
  if (m.name) def.name = m.name;
  if (m.reasoning != null) def.reasoning = m.reasoning;
  const caps: Record<string, any> = {};
  if (m.tool_call != null) caps.tools = m.tool_call;
  if (m.modalities?.input?.length) caps.input = m.modalities.input;
  if (m.modalities?.output?.length) caps.output = m.modalities.output;
  if (Object.keys(caps).length > 0) def.capabilities = caps;
  if (m.cost) def.cost = m.cost;
  if (m.limit) def.limit = m.limit;
  return def;
}

// Live/catalog model pull moved to opencode/catalog/auto-pull.ts so the
// periodic auto-pull scheduler and the console share one implementation.

export function registerConsoleRoutes(
  app: FastifyInstance,
  registry: ProviderRegistry,
  orchestrator: PipelineOrchestrator
): void {
  const candidateDistDirs = [
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../frontend/dist'),
  ];
  const FRONTEND_DIST = candidateDistDirs.find((p) => fs.existsSync(p)) || path.resolve(process.cwd(), 'frontend/dist');

  // 1. Static Asset Serving from frontend/dist/assets — production vite
  // builds use base '/admin/' so HTML references /admin/assets/* below.
  app.get('/admin/assets/:file', async (req: any, reply: any) => {
    const file = req.params.file;
    // Path traversal guard: the router percent-decodes :file, so "..%2f" arrives
    // as "../". Reject separators/dot-segments outright (asset names are flat
    // hashed filenames like "index-CeY-Ig7t.js").
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..') || file.includes('\0')) {
      return reply.status(400).send('Bad Request');
    }
    const filePath = path.join(FRONTEND_DIST, 'assets', file);
    // Defense in depth: the resolved path must stay inside the assets dir.
    if (!path.resolve(filePath).startsWith(path.join(FRONTEND_DIST, 'assets') + path.sep)) {
      return reply.status(400).send('Bad Request');
    }
    if (fs.existsSync(filePath)) {
      // Hashed filenames → safe to cache forever; a rebuild produces new names.
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      if (file.endsWith('.js')) reply.type('application/javascript');
      else if (file.endsWith('.css')) reply.type('text/css');
      else if (file.endsWith('.svg')) reply.type('image/svg+xml');
      else if (file.endsWith('.json')) reply.type('application/json');
      else if (file.endsWith('.woff2')) reply.type('font/woff2');
      else if (file.endsWith('.woff')) reply.type('font/woff');
      else if (file.endsWith('.ttf')) reply.type('font/ttf');
      return reply.send(fs.readFileSync(filePath));
    }
    return reply.status(404).send('Not Found');
  });

  // 2. React SPA HTML Handler
  const handleHtml = async (_req: any, reply: any) => {
    const indexHtmlPath = path.join(FRONTEND_DIST, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
      // no-cache: the HTML references hashed asset names — always re-fetch it so
      // a rebuilt frontend is picked up on a normal refresh (no hard-reload needed).
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.readFileSync(indexHtmlPath, 'utf8'));
    }
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
        <head><title>OpenCode Router Gateway Console</title></head>
        <body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:40px;text-align:center;">
          <h2>⚡ OpenCode Router Gateway Console</h2>
          <p style="color:#a1a1aa;">The web console assets have not been built yet.</p>
          <p>Please run <code style="color:#06b6d4;background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;">npm run build:frontend</code> to build the React application.</p>
        </body>
      </html>
    `);
  };

  // Everything under /admin/ is the console. Wildcard registration (not an
  // explicit page list) makes a new React page impossible to 401/404 on
  // browser refresh — App.tsx stays the single source of truth for pages.
  // Router specificity: the parametric /admin/assets/:file handler above
  // outranks this wildcard, so hashed build assets hit the static handler.
  app.get('/admin', handleHtml);
  app.get('/admin/*', handleHtml);

  // `/` is an entry redirect, not a page: land on the console prefix.
  app.get('/', async (_req: any, reply: any) => reply.redirect('/admin/', 301));

  // 3. Status Aggregation API for Console
  const handleStatus = async () => {
    const cbSummary = registry.getCircuitBreakerManager().getSummary();
    const metrics = orchestrator.getTracker().getStats();
    const clients = getAllClientStatuses();
    const config = loadConfig();

    const maskedProviders = (config.providers || []).map((p) => ({
      ...p,
      apiKey: p.apiKey ? `${p.apiKey.slice(0, 4)}••••${p.apiKey.slice(-4)}` : '',
      rawKeyConfigured: Boolean(p.apiKey),
    }));

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      // Actual listening port (config.yaml `port` is the single source of truth)
      // so the console header shows the real gateway port instead of a literal.
      port: config.port,
      metrics,
      circuitBreakers: cbSummary,
      clients,
      providers: maskedProviders,
      registeredModelsCount: registry.getAllModels().length,
      // Inbound forward-proxy runtime status (see forward-proxy/status.ts) —
      // the Proxy Access page polls this to show running / failed / pending.
      forwardProxy: {
        enabled: Boolean(config.forwardProxy?.enabled),
        ...getForwardProxyStatus(),
      },
    };
  };

  app.get('/api/admin/status', handleStatus);

  // 3B. Prompt-cache observability (provider-native caching, aggregated from traces).
  // Optional `?since=<epoch-ms>` narrows the totals / per-model rows / hourly
  // series to traces with `timestamp >= since`. Back-compat: when omitted the
  // response is the legacy 24-hour window.
  app.get('/api/admin/cache-stats', async (req) => {
    const query = req.query as { since?: string };
    const sinceRaw = query.since ? Number(query.since) : NaN;
    const sinceTs = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    return {
      status: 'ok',
      stats: orchestrator.getTraceTracker().getCacheStats(sinceTs !== undefined ? { sinceTs } : undefined),
      routingCache: Layer2Judge.getDecisionCacheStats(),
    };
  });

  // 4. Client Interception Setup / Teardown
  const handleSetup = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const { models, apiKey, contextWindow, extraModels } = (req.body || {}) as {
      models?: Record<string, string>;
      apiKey?: string;
      contextWindow?: number;
      extraModels?: string[];
    };
    const cleaned = models && typeof models === 'object'
      ? Object.fromEntries(Object.entries(models).map(([k, v]) => [k, String(v ?? 'auto').trim() || 'auto']))
      : undefined;
    const cleanedExtra = Array.isArray(extraModels)
      ? extraModels.map(s => String(s || '').trim()).filter(Boolean)
      : undefined;
    const cw = Number(contextWindow);
    const result = await setupClient(client, {
      ...(cleaned ? { models: cleaned } : {}),
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(Number.isFinite(cw) && cw > 0 ? { contextWindow: Math.floor(cw) } : {}),
      ...(cleanedExtra ? { extraModels: cleanedExtra } : {}),
    });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  const handleTeardown = async (req: any, reply: any) => {
    const { client } = req.params as { client: string };
    const result = await teardownClient(client);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };

  app.post('/api/admin/client/:client/setup', handleSetup);
  app.post('/api/admin/client/:client/teardown', handleTeardown);

  // 5. Configuration Read & Write API
  app.get('/api/admin/config', async () => ({ status: 'ok', config: loadConfig() }));

  const handleSaveConfig = async (req: any, reply: any) => {
    const body = req.body as Partial<RouterConfig>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ success: false, message: 'Invalid config payload' });
    }
    const result = saveConfig(body);
    if (!result.success) return reply.status(400).send(result);
    // Hot-applied config sections: proxy policy (module singleton per call),
    // the capture recorder (enabled/toggles take effect immediately, no
    // gateway restart needed) and custom model combos (registry re-reads the
    // combo map per request). Everything else still requires a restart.
    initProxyConfig(loadConfig().proxy);
    orchestrator.getCaptureRecorder().applyConfig(loadConfig().capture);
    orchestrator.getRegistry().applyCombos(loadConfig().combos);
    orchestrator.getRegistry().applyTierConfigNow(); // tier member lists commit immediately (no restart)
    warnOnEmptyTierPools(); // no residual tier → an empty pool is now possible
    return result;
  };
  app.post('/api/admin/config', handleSaveConfig);

  // 6. Raw YAML Configuration
  app.get('/api/admin/config/raw', async () => ({ status: 'ok', yaml: getRawConfig() }));

  const handleSaveRawYaml = async (req: any, reply: any) => {
    const body = req.body as { yaml?: string };
    if (!body?.yaml || typeof body.yaml !== 'string') {
      return reply.status(400).send({ success: false, message: 'YAML content is required' });
    }
    const result = saveRawConfig(body.yaml);
    if (!result.success) return reply.status(400).send(result);
    initProxyConfig(loadConfig().proxy); // hot-apply proxy policy (see handleSaveConfig)
    orchestrator.getCaptureRecorder().applyConfig(loadConfig().capture); // hot-apply capture too
    orchestrator.getRegistry().applyCombos(loadConfig().combos); // hot-apply combos too
    orchestrator.getRegistry().applyTierConfigNow(); // hot-commit tier member lists too
    warnOnEmptyTierPools(); // no residual tier → an empty pool is now possible
    return result;
  };
  app.post('/api/admin/config/raw', handleSaveRawYaml);

  // 6a. Forward-proxy MITM CA export — clients using the inbound forward
  // proxy must trust this CA. Generated on first request when absent (the
  // same idempotent ensureCa the proxy itself uses).
  const handleForwardProxyCa = async (_req: any, reply: any) => {
    const cfg = loadConfig();
    const caDir = cfg.forwardProxy?.caDir?.trim() || path.join(getOcrHomeDir(), 'forward-proxy');
    try {
      const ca = ensureCa(caDir);
      reply.header('content-type', 'application/x-pem-file');
      reply.header('content-disposition', 'attachment; filename="ocr-forward-proxy-ca.pem"');
      return reply.send(ca.caCertPem);
    } catch (err: any) {
      return reply.status(500).send({ status: 'error', message: err?.message || 'Failed to load CA' });
    }
  };
  app.get('/api/admin/proxy/ca', handleForwardProxyCa);

  // 6b. Tier member lists — candidate pool snapshots (console preview).
  // membership is a PURE projection of (model id × tiers.members);
  // PREVIEW never mutates live pools — real membership is committed ONLY by
  // the save events below (applyTierConfigNow), so editing takes effect
  // without a restart.
  const projectTierPools = async (policies: any) => {
    const pools: Record<string, unknown> = {};
    const cb = registry.getCircuitBreakerManager();
    const shape = (pool: { model: any; weight: number }[]) =>
      pool.map(({ model, weight }) => ({
        id: model.id,
        provider: model.provider,
        upstreamModel: model.upstreamModel,
        priority: model.priority,
        isDefaultInTier: Boolean(model.isDefaultInTier),
        inputPrice: model.pricing?.input,
        outputPrice: model.pricing?.output,
        healthy: cb.isAvailable(model.id),
        weight,
      }));
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool, excluded } = registry.resolveTierPool(tier, policies);
      pools[tier] = { pool: shape(pool), excluded };
    }
    return pools;
  };

  // membership is explicit — an empty pool means the member list is
  // empty or matches no registered model. Degradation is allowed but never
  // silent — warn on every commit.
  const warnOnEmptyTierPools = () => {
    const tiers = loadConfig().tiers;
    const resolved = resolveTierMembers(tiers);
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool } = registry.resolveTierPool(tier, tiers);
      if (pool.length === 0) {
        const cause =
          resolved.tiers[tier].length === 0 ? 'the member list is empty' : 'no rule matches a registered model';
        console.warn(
          `[Console] Tier '${tier}' has an EMPTY candidate pool (${cause}) — its requests will degrade to another tier. ` +
            `Add models to tiers.${tier}.members on the /tiers page.`,
        );
      }
    }
  };

  const handleTierPools = async () => {
    // Snapshot of the SAVED file state (what a restart would load anyway, and
    // what the save-commit has already applied). `match` rides along as the
    // suggestion engine's resolved config (catalog-page recommendations).
    const freshTiers = loadConfig().tiers;
    return {
      status: 'ok',
      pools: await projectTierPools(freshTiers),
      members: resolveTierMembers(freshTiers).tiers,
      match: resolveTierMatch(freshTiers),
    };
  };
  app.get('/api/admin/tier-pools', handleTierPools);

  // 6b'. Live (committed) tier pool snapshot — reflects the registry's
  // current m.tier (the last applyTierConfigNow result) plus the global
  // tiers.exclude filter. No preview; what the runtime would actually use.
  //
  // Read-only on purpose: the previous version called applyTierConfigNow()
  // here as a "force-commit view" trick, but that mutated m.tier / m.unclassified
  // on every Live tab open — a stealth commit with no save event behind it.
  // The console must NEVER write routing state from a GET. Out-of-band file
  // edits get picked up on the next save commit (the console already triggers
  // applyTierConfigNow in handleSaveConfig / handleSaveRawYaml).
  const handleTierPoolsLive = async () => {
    const policies = registry.getTierPolicies();
    const pools: Record<string, unknown> = {};
    const cb = registry.getCircuitBreakerManager();
    for (const tier of MEMBER_TIER_ORDER) {
      const { pool, excluded } = registry.resolveTierPool(tier, policies);
      pools[tier] = {
        pool: pool.map(({ model, weight }) => ({
          id: model.id,
          provider: model.provider,
          upstreamModel: model.upstreamModel,
          priority: model.priority,
          isDefaultInTier: Boolean(model.isDefaultInTier),
          inputPrice: model.pricing?.input,
          outputPrice: model.pricing?.output,
          healthy: cb.isAvailable(model.id),
          weight,
        })),
        excluded,
      };
    }
    return { status: 'ok', live: true, pools };
  };
  app.get('/api/admin/tier-pools/live', handleTierPoolsLive);

  // 6b'. Ephemeral preview from UNSAVED form state — { tiers } in the body;
  // the console shows what the pools WOULD be, without touching routing.
  const handleTierPoolsPreview = async (req: any) => {
    const body = req.body as { tiers?: unknown };
    const tiers = body?.tiers ?? loadConfig().tiers ?? {};
    return {
      status: 'ok',
      preview: true,
      pools: await projectTierPools(tiers),
      members: resolveTierMembers(tiers as any).tiers,
      match: resolveTierMatch(tiers as any),
    };
  };
  app.post('/api/admin/tier-pools/preview', handleTierPoolsPreview);

  // Check: dry-run validation of a DRAFT tiers config — non-blocking warnings:
  //   overlap — a model claimable by 2+ tiers (runtime resolves by tier order)
  //   orphan  — a rule matching no registered model (rename / typo / removed)
  const handleTiersCheck = async (req: any) => {
    const body = req.body as { tiers?: unknown };
    const tiers = (body?.tiers ?? loadConfig().tiers ?? {}) as any;
    const members = resolveTierMembers(tiers).tiers;
    const modelIds = registry
      .getAllModels()
      .filter((m) => m.tierMatch)
      .map((m) => m.id);
    const overlapGroups = new Map<string, { tiers: string[]; count: number; sampleIds: string[] }>();
    for (const id of modelIds) {
      const hits = matchingTiers(id, members);
      if (hits.length < 2) continue;
      const key = hits.join('|');
      const g = overlapGroups.get(key) ?? { tiers: hits, count: 0, sampleIds: [] };
      g.count++;
      if (g.sampleIds.length < 5) g.sampleIds.push(id);
      overlapGroups.set(key, g);
    }
    const orphans: { tier: string; pattern: string }[] = [];
    for (const tier of MEMBER_TIER_ORDER) {
      for (const rule of members[tier]) {
        if (!modelIds.some((id) => globMatchAny([rule.pattern], id))) orphans.push({ tier, pattern: rule.pattern });
      }
    }
    return {
      status: 'ok',
      warnings: [
        ...[...overlapGroups.values()].map((g) => ({
          kind: 'overlap' as const,
          tiers: g.tiers,
          count: g.count,
          sampleIds: g.sampleIds,
        })),
        ...orphans.map((o) => ({ kind: 'orphan' as const, tier: o.tier, pattern: o.pattern })),
      ],
    };
  };
  app.post('/api/admin/tiers/check', handleTiersCheck);

  // 6b-2. Catalog source management — view/add/remove/toggle/refresh the remote
  // catalog sources (config.catalog.sources). Mutations apply to the live
  // CatalogRepository immediately (no gateway restart) and are persisted to
  // config.yaml so they survive restarts. The 'opencode' baseline source is
  // mandatory: the repository rejects its removal/disabling with 403.
  const persistCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    const current = loadConfig().catalog ?? {};
    saveConfig({
      catalog: {
        ...current,
        sources: catalogRepository.configuredSources().map((d) => ({
          id: d.id,
          type: d.type,
          url: d.url,
          enabled: d.enabled,
          priority: d.priority,
          // 'custom' sources are invalid without their field mapping — persist
          // it too, otherwise the first save silently wipes it from config.yaml
          ...(d.map ? { map: d.map } : {}),
        })),
      },
    });
  };

  const listCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    return {
      status: 'ok',
      syncIntervalMs: catalogRepository.syncInterval,
      sources: catalogRepository.sourceStates(),
    };
  };

  // Hot-apply the auto-sync period (no restart) and persist to config.yaml.
  const handleSetCatalogSyncInterval = async (req: any, reply: any) => {
    const body = req.body ?? {};
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      catalogRepository.setSyncInterval(Number(body.intervalMs));
      const current = loadConfig().catalog ?? {};
      const result = saveConfig({ catalog: { ...current, syncIntervalMs: catalogRepository.syncInterval } });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', syncIntervalMs: catalogRepository.syncInterval };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleAddCatalogSource = async (req: any, reply: any) => {
    const body = req.body ?? {};
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.addSource({
        id: String(body.id ?? ''),
        type: String(body.type ?? ''),
        url: String(body.url ?? ''),
        priority: typeof body.priority === 'number' ? body.priority : undefined,
        enabled: body.enabled,
        map: body.map && typeof body.map === 'object' ? body.map : undefined,
      });
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message ?? 'failed to add source' });
    }
  };

  const handleToggleCatalogSource = async (req: any, reply: any) => {
    const body = req.body ?? {};
    if (typeof body.enabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'body.enabled (boolean) is required' });
    }
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.setSourceEnabled(req.params.id, body.enabled);
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRemoveCatalogSource = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      catalogRepository.removeSource(req.params.id);
      await persistCatalogSources();
      await catalogRepository.ensureOcrStore();
      return { status: 'ok' };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRefreshCatalogSource = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const source = await catalogRepository.refreshSource(req.params.id);
      // Rebuild + persist the OCR store immediately so catalog/ocr.json reflects
      // the refresh the moment this call returns.
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', source };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  const handleRefreshCatalogSources = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.refreshAll();
    await catalogRepository.ensureOcrStore();
    return { status: 'ok', sources: catalogRepository.sourceStates() };
  };

  const getCatalogSourceData = async (req: any, reply: any) => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    try {
      const data = catalogRepository.sourceData(req.params.id);
      return { status: 'ok', ...data };
    } catch (err: any) {
      return reply.status(err?.statusCode ?? 400).send({ success: false, error: err?.message });
    }
  };

  // Toggle one model id in catalog.lockedModels (locally anchored: remote sources
  // never overwrite its maintained values, explicit zeros included). Hot-effective:
  // the repository reads config.yaml live on every aggregation.
  const handleLockCatalogModel = async (req: any, reply: any) => {
    const body = req.body as { id?: string; locked?: boolean };
    if (!body?.id || typeof body.locked !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'body.id (string) and body.locked (boolean) are required' });
    }
    const current = loadConfig().catalog ?? {};
    const set = new Set(current.lockedModels ?? []);
    if (body.locked) set.add(String(body.id));
    else set.delete(String(body.id));
    const lockedModels = [...set].sort();
    const result = saveConfig({ catalog: { ...current, lockedModels } });
    if (!result.success) return reply.status(400).send(result);
    return { status: 'ok', lockedModels };
  };

  const listLockedCatalogModels = async () => ({
    status: 'ok',
    lockedModels: loadConfig().catalog?.lockedModels ?? [],
  });

  // The FULL OCR catalog view (catalogRepository.list()): opencode.jsonc
  // definitions + credentials first, then provider-catalog sources (builtin
  // baseline) and model-list enrichments, service baseURL hints — the exact
  // aggregation the /providers and /models pages are built on.
  const getCatalogOcr = async () => {
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    const providers = await catalogRepository.list();
    return { status: 'ok', providers };
  };

  // Aggregate-level model overrides (OCR Catalog viewer edits) — a separate
  // editing plane from opencode.jsonc definitions. Applied LAST on the
  // aggregation so edited values always win over sourced values.
  const handleGetCatalogOverride = async (req: any) => {
    const { getOverride } = await import('../opencode/catalog/overrides-store.js');
    const q = req.query as { providerId?: string; modelId?: string };
    if (!q.providerId || !q.modelId) return { status: 'ok', entry: null };
    return { status: 'ok', entry: getOverride(q.providerId, q.modelId) ?? null };
  };

  const handlePutCatalogOverride = async (req: any, reply: any) => {
    const body = req.body as { providerId?: string; modelId?: string; entry?: any };
    if (!body?.providerId || !body?.modelId || typeof body.entry !== 'object') {
      return reply.status(400).send({ success: false, error: 'providerId, modelId and entry are required' });
    }
    if ('tier' in body.entry && body.entry.tier !== null && asTierLevel(body.entry.tier) === undefined) {
      return reply.status(400).send({ success: false, error: 'entry.tier must be lite | plus | pro | ultra or null' });
    }
    const { upsertOverride } = await import('../opencode/catalog/overrides-store.js');
    const result = upsertOverride(String(body.providerId), String(body.modelId), body.entry);
    if (!result.success) return reply.status(400).send(result);
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.ensureOcrStore();
    registry.applyTierConfigNow(); // explicit catalog tier edits commit to pools immediately
    return { status: 'ok' };
  };

  const handleDeleteCatalogOverride = async (req: any, reply: any) => {
    const q = req.query as { providerId?: string; modelId?: string };
    if (!q.providerId || !q.modelId) {
      return reply.status(400).send({ success: false, error: 'providerId and modelId are required' });
    }
    const { removeOverride } = await import('../opencode/catalog/overrides-store.js');
    const result = removeOverride(q.providerId, q.modelId);
    if (!result.success) return reply.status(400).send(result);
    const { catalogRepository } = await import('../opencode/catalog/repository.js');
    await catalogRepository.ensureOcrStore();
    registry.applyTierConfigNow(); // explicit catalog tier edits commit to pools immediately
    return { status: 'ok' };
  };

  for (const prefix of ['/api/admin']) {
    app.get(`${prefix}/catalog/sources`, listCatalogSources);
    app.post(`${prefix}/catalog/sources`, handleAddCatalogSource);
    app.post(`${prefix}/catalog/sources/refresh`, handleRefreshCatalogSources);
    app.post(`${prefix}/catalog/sources/:id/refresh`, handleRefreshCatalogSource);
    app.put(`${prefix}/catalog/sources/:id`, handleToggleCatalogSource);
    app.delete(`${prefix}/catalog/sources/:id`, handleRemoveCatalogSource);
    app.get(`${prefix}/catalog/sources/:id/data`, getCatalogSourceData);
    app.get(`${prefix}/catalog/locked-models`, listLockedCatalogModels);
    app.post(`${prefix}/catalog/locked-models`, handleLockCatalogModel);
    app.get(`${prefix}/catalog/ocr`, getCatalogOcr);
    app.get(`${prefix}/catalog/override`, handleGetCatalogOverride);
    app.put(`${prefix}/catalog/override`, handlePutCatalogOverride);
    app.delete(`${prefix}/catalog/override`, handleDeleteCatalogOverride);
    app.post(`${prefix}/catalog/sync-interval`, handleSetCatalogSyncInterval);
  }

  // 6c. Custom model combos — resolved member view for the /combos console
  // page. Reads the FRESH config (loadConfig) so a just-saved combo shows up
  // without a restart; member health/breaker state comes from the live
  // registry, and unregistered member ids are flagged via registered:false.
  const handleCombos = async () => {
    const cb = registry.getCircuitBreakerManager();
    const combos = (loadConfig().combos || []).map(c => ({
      id: c.id,
      note: c.note,
      // active=false ⇒ the gateway ignored this combo (reserved/colliding id
      // or model-shadowed) — the UI badges it instead of diverging silently.
      active: registry.isCombo(c.id),
      selection: c.selection || 'priority',
      members: (c.models || []).map((entry: any) => {
        const ref =
          typeof entry === 'string' ? { id: entry, weight: 1 } : { id: entry.id, weight: entry.weight ?? 1 };
        const model = registry.getModel(ref.id);
        return {
          id: ref.id,
          weight: ref.weight,
          registered: Boolean(model),
          provider: model?.provider,
          tier: model?.tier,
          inputPrice: model?.pricing?.input,
          outputPrice: model?.pricing?.output,
          breakerState: model ? cb.getBreaker(model.id)?.getState() ?? 'CLOSED' : undefined,
        };
      }),
    }));
    return { status: 'ok', combos };
  };
  app.get('/api/admin/combos', handleCombos);

  // 7. OpenCode-native Provider Management (opencode.jsonc `provider` node + auth.json)
  //     - Definitions live in ~/.config/opencode/opencode.jsonc (JSONC, comment-preserving edits)
  //     - Credentials live in ~/.local/share/opencode/auth.json
  //     - Connectable catalog comes from models.dev (same source as `opencode auth login`)
  const ocHandlers = {
    list: async () => {
      const { listOpenCodeProviders, getOpenCodeConfigPath, getOpenCodeAuthPath } = await import(
        '../opencode/user-config.js'
      );
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const unified = await catalogRepository.list();
      const byId = new Map(unified.map((p) => [p.id, p]));
      return {
        status: 'ok',
        configPath: getOpenCodeConfigPath(),
        authPath: getOpenCodeAuthPath(),
        catalogSync: catalogRepository.lastSyncOrigin,
        providers: listOpenCodeProviders().map((v) => {
          const u = byId.get(v.id);
          return {
            ...v,
            // upgraded custom: an explicit jsonc definition OR not covered by
            // the remote catalog (credential-only zhipu, private relays, …)
            custom: u?.custom ?? v.custom,
            logo: u?.logo,
            // auth-only providers have no config baseURL — fall back to the
            // catalog's effective base (config override → live service hint)
            baseURL: v.baseURL || u?.baseURL,
            priceFrom: u ? catalogRepository.minInputPrice(u) : undefined,
            modelsCount: u?.models.length ?? v.models.length,
          };
        }),
      };
    },

    catalog: async () => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const unified = await catalogRepository.list();
      // Trim model arrays from the list payload (detail endpoint can serve them later)
      const providers = unified.map((p) => ({
        id: p.id,
        name: p.name,
        logo: p.logo,
        npm: p.npm,
        api: p.api,
        baseURL: p.baseURL,
        doc: p.doc,
        env: p.env,
        custom: p.custom,
        connected: p.connected,
        sources: p.sources,
        modelCount: p.models.length,
        priceFrom: catalogRepository.minInputPrice(p),
      }));
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, providers };
    },

    /** Flat model catalog across providers (supports ?provider= & ?connected=1). */
    models: async (req: any) => {
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const query = req.query as { provider?: string; connected?: string };
      const providerFilter = query.provider?.trim().toLowerCase();
      const connectedOnly = query.connected === '1' || query.connected === 'true';
      const unified = await catalogRepository.list();
      const models = unified
        .filter(
          (p) =>
            (!providerFilter || p.id.toLowerCase() === providerFilter) &&
            (!connectedOnly || p.connected)
        )
        .flatMap((p) =>
          p.models.map((m) => ({
            ...m,
            providerId: p.id,
            providerName: p.name,
            logo: p.logo,
            custom: p.custom,
            connected: p.connected,
          }))
        );
      return { status: 'ok', source: catalogRepository.lastSyncOrigin, total: models.length, models };
    },

    create: async (req: any, reply: any) => {
      const body = req.body as any;
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Provider id is required' });
      }
      const id = String(body.id);
      // An id covered by the remote catalog (opencode / models-dev) may NOT be
      // redefined as a custom provider — it would shadow the catalog entry.
      // Connect it with credentials instead (auth.json), no definition needed.
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const covered = await catalogRepository.getProvider(id);
      if (covered && covered.sources.some((s) => s === 'opencode' || s === 'models-dev')) {
        return reply.status(409).send({
          success: false,
          error: `'${id}' is covered by the built-in catalog — connect it with credentials instead of redefining it`,
        });
      }
      const { upsertCustomProvider } = await import('../opencode/user-config.js');
      const result = upsertCustomProvider({
        id,
        name: body.name,
        npm: body.npm,
        baseURL: body.baseURL,
        apiKey: body.apiKey,
        apiKeyInline: Boolean(body.apiKeyInline),
        headers: body.headers,
        models: body.models,
        options: body.options,
      });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', ...result };
    },

    update: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      const existing = getProviderNodeById(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: `Provider '${id}' not found in opencode.jsonc` });
      }
      const result = upsertCustomProvider({
        id,
        name: body.name ?? existing.name,
        npm: body.npm ?? existing.npm,
        baseURL: body.baseURL ?? existing.options?.baseURL,
        apiKey: body.apiKey,
        apiKeyInline: body.apiKeyInline ?? Boolean(existing.options?.apiKey),
        headers: body.headers ?? existing.options?.headers,
        models: body.models ?? existing.models,
        options: existing.options,
      });
      if (!result.success) return reply.status(400).send(result);
      return { status: 'ok', ...result };
    },

    connect: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string; baseURL?: string };
      const { setAuthApiKey, upsertCustomProvider, getProviderNodeById } = await import('../opencode/user-config.js');
      try {
        if (!body?.apiKey) {
          return reply.status(400).send({
            success: false,
            oauthHint: true,
            error: `API key required. For OAuth-based providers run: opencode auth login ${id}`,
          });
        }
        setAuthApiKey(id, body.apiKey);
        // Optional baseURL override — merge with the existing definition so we
        // never wipe name/npm/models of a config-defined custom provider.
        if (body.baseURL) {
          const existing = getProviderNodeById(id);
          upsertCustomProvider({
            id,
            baseURL: body.baseURL,
            name: existing?.name,
            npm: existing?.npm,
            headers: existing?.options?.headers,
            models: existing?.models,
            options: existing?.options,
          });
        }
        return { status: 'ok', success: true, message: `Provider '${id}' connected via auth.json` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    /**
     * One-shot upstream connectivity probe behind the console "Test" buttons.
     * Resolves baseURL/key/model from body overrides (test-before-save) or
     * config/auth.json. Config problems (no key/baseURL/model) are 4xx; probe
     * outcomes (auth failure, network error, upstream error) come back as data
     * on HTTP 200 with ok:false.
     */
    test: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = (req.body || {}) as { modelId?: string; apiKey?: string; baseURL?: string };
      const { getProviderNodeById, getProviderModelDefs, expandEnvTemplate, readAuthEntries } = await import(
        '../opencode/user-config.js'
      );
      const def = getProviderNodeById(id);
      const authEntry = readAuthEntries()[id];
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      const cat = (await catalogRepository.list()).find((p) => p.id === id);
      // model: explicit override (config key or upstream id) → first enabled
      // config def → first catalog model (auth-only providers)
      const defs = getProviderModelDefs(id);
      const upstreamId = (mid: string): string => {
        const d = defs?.[mid];
        return d && typeof d === 'object' && d.modelID ? String(d.modelID) : mid;
      };
      const enabledDefIds = Object.keys(defs || {}).filter((k) => (defs as any)[k]?.disabled !== true);
      const modelId = body.modelId
        ? upstreamId(body.modelId)
        : enabledDefIds.length > 0
          ? upstreamId(enabledDefIds[0])
          : cat?.models[0]?.id;
      if (!modelId) {
        return reply.status(400).send({ success: false, error: `'${id}' 没有可用于测试的模型 —— 请先添加模型` });
      }

      // probes run DIRECT against the provider on the same wire the
      // executor resolved for this model (shared wireFor()). The opencode
      // daemon is not in any request path — no test-vs-inference divergence.
      const apiKey = body.apiKey || expandEnvTemplate(def?.options?.apiKey) || authEntry?.key || authEntry?.access;
      if (!apiKey) {
        return reply.status(400).send({
          success: false,
          oauthHint: true,
          error: `No API key for '${id}' (auth.json or inline). For OAuth-based providers run: opencode auth login ${id}`,
        });
      }
      // Same precedence as boot-direct pool construction (models.dev `api`
      // before the daemon runtime hint) — test must hit what inference hits.
      const baseURL = body.baseURL || def?.options?.baseURL || cat?.api || cat?.baseURL;
      if (!baseURL) {
        return reply
          .status(400)
          .send({ success: false, error: `无法确定 '${id}' 的 baseURL —— 请先配置带 baseURL 的自定义 provider` });
      }
      const { probeProvider, probeKindFor } = await import('../opencode/probe.js');
      const { baseForWire } = await import('../providers/wire.js');
      // Model-level npm override (e.g. Zen gpt-6-luna → @ai-sdk/openai =
      // Responses API) beats provider-level npm when picking the wire shape.
      const modelNpm = cat?.models.find((mm) => mm.id === modelId)?.npm;
      const kind = probeKindFor(cat?.api, modelNpm || def?.npm || cat?.npm);
      const result = await probeProvider({
        baseURL: baseForWire(kind, baseURL),
        apiKey,
        model: modelId,
        provider: id,
        kind,
        headers: def?.options?.headers,
        // explicit body.apiKey override is a plain API key, never OAuth
        oauth: !body.apiKey && authEntry?.type === 'oauth',
      });
      return { status: 'ok', provider: id, model: modelId, ...result };
    },

    setKey: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { apiKey?: string };
      const { setAuthApiKey } = await import('../opencode/user-config.js');
      if (!body?.apiKey) {
        return reply.status(400).send({ success: false, error: 'apiKey is required' });
      }
      try {
        setAuthApiKey(id, body.apiKey);
        return { status: 'ok', success: true, message: `Credential updated for '${id}'` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    remove: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const query = req.query as { purgeAuth?: string };
      const { deleteCustomProvider, removeAuthEntry, getProviderNodeById } = await import(
        '../opencode/user-config.js'
      );
      const purgeAuth = query.purgeAuth === '1' || query.purgeAuth === 'true';
      if (getProviderNodeById(id)) {
        const result = deleteCustomProvider(id, { purgeAuth });
        if (!result.success) return reply.status(400).send(result);
        return { status: 'ok', ...result };
      }
      // Credential-only entry (catalog provider connected via auth.json)
      try {
        removeAuthEntry(id);
        return { status: 'ok', success: true, message: `Credential entry '${id}' removed` };
      } catch (err: any) {
        return reply.status(400).send({ success: false, error: err.message });
      }
    },

    // -- Per-provider model maintenance (config-defined providers only) ----

    /** Full model definitions of a config-defined provider (management view). */
    modelsGet: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const { getProviderModelDefs } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // credential-only provider → models live in the custom store
        const { getCustomProviderModels } = await import('../opencode/catalog/custom-store.js');
        const custom = getCustomProviderModels(id);
        if (custom.length > 0) {
          const models: Record<string, any> = {};
          for (const m of custom) models[m.id] = catalogModelToV2Def(m);
          return { status: 'ok', id, models, custom: true };
        }
        return reply.status(404).send({ success: false, error: `Provider '${id}' is not defined in opencode.jsonc` });
      }
      return { status: 'ok', id, models: defs };
    },

    /** Add one model. Body: catalog-style fields or a raw `definition` object. */
    modelAdd: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel } = await import('../opencode/user-config.js');
      if (!body?.id) {
        return reply.status(400).send({ success: false, error: 'Model id is required' });
      }
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // credential-only provider (no jsonc node) → the custom store is the landing spot
        const { readCustomStore, upsertCustomModel } = await import('../opencode/catalog/custom-store.js');
        const custom = readCustomStore()?.providers[id];
        if (custom?.models.some((m) => m.id === String(body.id))) {
          return reply.status(409).send({ success: false, error: `Model '${body.id}' already exists — use PATCH to modify it` });
        }
        const model = defToCatalogModel(String(body.id), bodyToModelDef(body));
        const result = upsertCustomModel(id, model);
        if (!result.success) return reply.status(400).send(result);
        const { catalogRepository } = await import('../opencode/catalog/repository.js');
        await catalogRepository.ensureOcrStore();
        return { status: 'ok', success: true, model: body.id, custom: true };
      }
      if (body.id in defs) {
        return reply.status(409).send({ success: false, error: `Model '${body.id}' already exists — use PATCH to modify it` });
      }
      const result = upsertProviderModel(id, String(body.id), bodyToModelDef(body));
      if (!result.success) return reply.status(400).send(result);
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: body.id };
    },

    /** Modify one model (partial merge over the existing definition). */
    modelUpdate: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const body = req.body as any;
      const { getProviderModelDefs, upsertProviderModel, removeProviderModel } = await import('../opencode/user-config.js');
      const defs = getProviderModelDefs(id);
      if (defs === undefined) {
        // credential-only provider → merge the patch into the custom-store model
        const { readCustomStore, upsertCustomModel, removeCustomModel } = await import('../opencode/catalog/custom-store.js');
        const model = readCustomStore()?.providers[id]?.models.find((m) => m.id === modelId);
        if (!model) {
          return reply.status(404).send({ success: false, error: `Model '${modelId}' is not defined for provider '${id}'` });
        }
        const targetId = body?.newId ? String(body.newId) : modelId;
        const next = { ...model, ...defToCatalogModel(targetId, bodyToModelDef(body)), id: targetId, source: 'custom' as const };
        const result = upsertCustomModel(id, next);
        if (!result.success) return reply.status(400).send(result);
        if (targetId !== modelId) removeCustomModel(id, modelId);
        return { status: 'ok', success: true, model: targetId, renamed: targetId !== modelId, custom: true };
      }
      if (!(modelId in defs)) {
        return reply.status(404).send({ success: false, error: `Model '${modelId}' is not defined for provider '${id}'` });
      }
      // rename support: newId moves the definition to a new key (write new → remove old)
      const targetId = body?.newId ? String(body.newId) : modelId;
      const existing = defs[modelId] && typeof defs[modelId] === 'object' ? defs[modelId] : {};
      const patch = bodyToModelDef(body);
      const next: Record<string, any> = { ...existing, ...patch };
      // limit/cost: partial merge (the form sends them only when edited)
      if (patch.limit || existing.limit) next.limit = { ...(existing.limit || {}), ...(patch.limit || {}) };
      // cost: a payload carrying a `cost` key replaces it wholesale (the editor
      // form always sends the full object, so blank fields clear stored prices);
      // a payload without `cost` keeps the old values. Empty `{}` clears.
      if (body?.cost && typeof body.cost === 'object') {
        const c: Record<string, number> = {};
        for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
          const v = (body.cost as any)[k];
          if (typeof v === 'number' && Number.isFinite(v)) c[k] = v;
        }
        if (Object.keys(c).length > 0) next.cost = c;
        else delete next.cost; // blank form → drop the key instead of writing `cost: {}`
      }
      // v2 composite fields (capabilities/settings/headers/body/compatibility/
      // variants): the form is a full-definition editor — values present in the
      // payload (even {}) replace wholesale; absent keys keep their old values.
      const result = upsertProviderModel(id, targetId, next);
      if (!result.success) return reply.status(400).send(result);
      if (targetId !== modelId) {
        const rm = removeProviderModel(id, modelId);
        if (!rm.success) {
          return reply.status(400).send({
            success: false,
            error: `Renamed to '${targetId}' but failed to remove the old entry '${modelId}': ${rm.error}`,
          });
        }
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: targetId, renamed: targetId !== modelId };
    },

    modelRemove: async (req: any, reply: any) => {
      const { id, modelId } = req.params as { id: string; modelId: string };
      const { removeProviderModel } = await import('../opencode/user-config.js');
      const result = removeProviderModel(id, modelId);
      if (!result.success) {
        // credential-only provider → remove from the custom store
        const { removeCustomModel } = await import('../opencode/catalog/custom-store.js');
        const rm = removeCustomModel(id, modelId);
        if (!rm.success) return reply.status(404).send(result);
        const { catalogRepository: repo } = await import('../opencode/catalog/repository.js');
        await repo.ensureOcrStore();
        return { status: 'ok', success: true, model: modelId, custom: true };
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', success: true, model: modelId };
    },

    /**
     * Pull models into the provider's config definition. Data source is chosen
     * automatically: providers with baseURL + credential are pulled LIVE from
     * their own /v1/models (failures surface real errors); providers without a
     * usable baseURL/key fall back to the static merged catalog. The same
     * engine powers the periodic auto-pull (catalog.autoPullModels).
     */
    modelsPull: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string; dryRun?: boolean } | undefined;
      const { getProviderNodeById, expandEnvTemplate, readAuthEntries } = await import('../opencode/user-config.js');
      // Credential-only providers (no jsonc node) are pullable too — they land
      // in catalog/custom.json (the 'custom' aggregation source).
      const def = getProviderNodeById(id);
      const inlineKey = expandEnvTemplate(def?.options?.apiKey);
      const liveCapable = Boolean(def?.options?.baseURL && (inlineKey || readAuthEntries()[id]?.key));
      const { pullLiveModels, pullCatalogModels } = await import('../opencode/catalog/auto-pull.js');
      const result = liveCapable
        ? await pullLiveModels(id, body || {})
        : await pullCatalogModels(id, body || {});
      return reply.status(result.httpStatus).send(result.body);
    },

    /** Clear models — whole node without a pattern, matching ids only with one. */
    modelsClear: async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = req.body as { pattern?: string } | undefined;
      const { clearProviderModels } = await import('../opencode/user-config.js');
      const result = clearProviderModels(id, body?.pattern);
      if (!result.success) {
        // credential-only provider (no jsonc node) → clear from the custom store,
        // same fallback as modelRemove
        const { clearCustomModels } = await import('../opencode/catalog/custom-store.js');
        const cm = clearCustomModels(id, body?.pattern);
        if (!cm.success) return reply.status(404).send(result);
        const { catalogRepository: repo } = await import('../opencode/catalog/repository.js');
        await repo.ensureOcrStore();
        return { status: 'ok', success: true, removed: cm.removed, custom: true };
      }
      const { catalogRepository } = await import('../opencode/catalog/repository.js');
      await catalogRepository.ensureOcrStore();
      return { status: 'ok', ...result };
    },
  };

  for (const prefix of ['/api/admin']) {
    app.get(`${prefix}/opencode/providers`, ocHandlers.list);
    app.get(`${prefix}/opencode/catalog`, ocHandlers.catalog);
    app.get(`${prefix}/opencode/models`, ocHandlers.models);
    app.post(`${prefix}/opencode/providers`, ocHandlers.create);
    app.patch(`${prefix}/opencode/providers/:id`, ocHandlers.update);
    app.post(`${prefix}/opencode/providers/:id/connect`, ocHandlers.connect);
    app.post(`${prefix}/opencode/providers/:id/key`, ocHandlers.setKey);
    app.post(`${prefix}/opencode/providers/:id/test`, ocHandlers.test);
    app.delete(`${prefix}/opencode/providers/:id`, ocHandlers.remove);

    // Per-provider model maintenance (config-defined providers only)
    app.get(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelsGet);
    app.post(`${prefix}/opencode/providers/:id/models`, ocHandlers.modelAdd);
    app.patch(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelUpdate);
    app.delete(`${prefix}/opencode/providers/:id/models/:modelId`, ocHandlers.modelRemove);
    app.post(`${prefix}/opencode/providers/:id/models/pull`, ocHandlers.modelsPull);
    app.post(`${prefix}/opencode/providers/:id/models/clear`, ocHandlers.modelsClear);
  }

  // 8b. Catalog logo proxy — remote provider logos served from the local disk
  //     cache (backend/src/opencode/catalog/logos.ts) so page loads don't break
  //     icons when models.dev / openrouter.ai are unreachable.
  const handleCatalogLogo = async (req: any, reply: any) => {
    const { getLogoCached } = await import('../opencode/catalog/logos.js');
    const url = (req.query as { url?: string }).url;
    const logo = await getLogoCached(url);
    if (!logo) return reply.status(404).send();
    return reply.header('Cache-Control', 'public, max-age=604800').type(logo.contentType).send(logo.body);
  };
  app.get('/api/admin/catalog/logo', handleCatalogLogo);

  // 9. Client API Keys Management (for external client access)
  const handleListApiKeys = async () => {
    return { status: 'ok', keys: listApiKeys(false) };
  };
  app.get('/api/admin/api-keys', handleListApiKeys);

  const handleCreateApiKey = async (req: any, reply: any) => {
    const body = req.body as { name: string; key?: string; role?: 'admin' | 'user'; expiresAt?: string; description?: string; modelAccess?: unknown };
    if (!body?.name) {
      return reply.status(400).send({ success: false, message: 'API Key name is required' });
    }
    const access = validateModelAccess(body.modelAccess);
    if (access.error) {
      return reply.status(400).send({ success: false, error: access.error });
    }
    const result = createApiKey({ ...body, modelAccess: access.value });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.post('/api/admin/api-keys', handleCreateApiKey);

  const handleUpdateApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; enabled?: boolean; expiresAt?: string; description?: string; role?: 'admin' | 'user'; modelAccess?: unknown };
    const access = validateModelAccess(body?.modelAccess);
    if (access.error) {
      return reply.status(400).send({ success: false, error: access.error });
    }
    const result = updateApiKey(id, { ...body, modelAccess: body?.modelAccess === null ? null : access.value });
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.put('/api/admin/api-keys/:id', handleUpdateApiKey);

  const handleDeleteApiKey = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const result = deleteApiKey(id);
    if (!result.success) return reply.status(400).send(result);
    return result;
  };
  app.delete('/api/admin/api-keys/:id', handleDeleteApiKey);

  // 9b. Effective model view for ONE key — what this key can actually see &
  //     use right now (mirrors the /v1/models policy filter + the execution
  //     pool gate). Read-only: no key material in the response.
  const handleGetKeyModels = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const key = listApiKeys(false).find((k) => k.id === id);
    if (!key) {
      return reply.status(404).send({ status: 'error', message: `API Key '${id}' not found` });
    }
    const policy = getModelAccessPolicy(key);
    const registered = registry.getAllModels().map((m) => ({
      id: m.id,
      provider: m.provider,
      tier: m.tier as string,
      virtual: false,
      allowed: isModelAllowed(m.id, policy, m.tier),
    }));
    const tierAllowed = (t: string) => registered.some((m) => m.tier === t && m.allowed);
    // Virtual auto* rows honor runtime viability (mirrors /v1/models): bare
    // `auto` needs an allowed model in ANY tier, auto-X in tier X.
    const virtual = ['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra'].map((id) => ({
      id,
      provider: 'opencode-router',
      tier: tierFromVirtualEntry(id),
      virtual: true,
      allowed: isAutoEntryUsable(id, policy, tierAllowed),
    }));
    return {
      status: 'ok',
      mode: policy?.mode ?? 'none',
      policyModels: policy?.models ?? [],
      models: [...virtual, ...registered],
    };
  };
  app.get('/api/admin/api-keys/:id/models', handleGetKeyModels);

  // 9c. Full gateway catalog for CONSOLE-internal consumers (model pickers).
  //     /v1/models now requires a key like every other surface; the trusted
  //     console UI reads the unfiltered catalog here instead.
  const handleGatewayModels = async () => {
    const models = [
      ...['auto', 'auto-lite', 'auto-plus', 'auto-pro', 'auto-ultra'].map((id) => ({
        id,
        owned_by: 'opencode-router',
        tier: '',
      })),
      ...registry.getAllModels().map((m) => ({ id: m.id, owned_by: m.provider, tier: m.tier as string })),
      ...registry.getCombos().map((c) => ({ id: c.id, owned_by: 'opencode-router', tier: '' })),
      ...registry.getVariantExposures().map(({ id, base }) => ({ id, owned_by: base.provider, tier: base.tier as string })),
    ];
    return { status: 'ok', models };
  };
  app.get('/api/admin/gateway-models', handleGatewayModels);

  // 10. Remote restart trigger from UI — spawn a detached replacement gateway
  //     first (it waits for our pid to die, boots, and self-registers the
  //     pid/info files), THEN exit. Without the spawn we would just stop and
  //     nothing would bring the gateway back (there is no supervisor).
  const handleRestart = async () => {
    const { spawnDetachedRestartChild } = await import('../cli/daemon.js');
    const cfg = loadConfig();
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
    const spawned = spawnDetachedRestartChild({ port, host: cfg.host });
    if (!spawned) {
      // Fault-tolerance: NEVER stop the gateway without a replacement — keep
      // serving and surface the failure to the UI instead of exiting.
      return {
        status: 'failed',
        message: 'Could not spawn a replacement process — gateway keeps running. Restart it manually when convenient.',
      };
    }
    setTimeout(() => process.exit(0), 500);
    return { status: 'restarting', message: 'Gateway restart signal acknowledged — replacement process is booting' };
  };
  app.post('/api/admin/restart', handleRestart);

  // 11. Process-log tail viewer — reads ~/.opencode-router/ocr.log (only
  //     written when the gateway runs under `ocr start`; a manual `bun
  //     backend/src/index.ts` writes to its own console instead).
  //     Reads at most 1 MiB from the tail so huge files never blow up memory.
  const handleGetLogs = async (req: any) => {
    const { getLogFilePath } = await import('../cli/paths.js');
    const query = req.query as { tail?: string; level?: string; q?: string };
    const tail = Math.min(Math.max(parseInt(query.tail || '500', 10) || 500, 1), 5000);
    const minLevel = parseLogLevelParam(query.level);
    const needle = (query.q || '').toLowerCase();

    const file = getLogFilePath();
    if (!fs.existsSync(file)) {
      return { status: 'ok', file, exists: false, size: 0, mtimeMs: 0, lines: [] };
    }

    const stat = fs.statSync(file);
    const readSize = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      const text = buf.toString('utf8');
      const allLines = text.split(/\r?\n/);
      // Drop the first (likely partial) line when we sliced mid-line.
      if (readSize < stat.size && allLines.length > 0) allLines.shift();

      const parsed: ParsedLogLine[] = [];
      for (const raw of allLines) {
        if (!raw.trim()) continue;
        const entry = parseLogLine(raw);
        // Level filter only applies to parsed pino lines; banner text is
        // always kept so startup output never silently disappears.
        if (minLevel > 0 && entry.levelNum !== undefined && entry.levelNum < minLevel) continue;
        if (needle && !raw.toLowerCase().includes(needle)) continue;
        parsed.push(entry);
      }
      const lines = parsed.slice(-tail);
      return { status: 'ok', file, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, lines };
    } finally {
      fs.closeSync(fd);
    }
  };
  app.get('/api/admin/logs', handleGetLogs);

  /* ---------------------------------------------------------------------- *
   * 12. Request-capture archive browser (CaptureRecorder; opt-in audit log)
   * Bodies may contain sensitive data — these endpoints sit under /api/admin/*
   * which the auth preHandler whitelists, exactly like /api/admin/logs.
   * ---------------------------------------------------------------------- */
  const captureRecorder = orchestrator.getCaptureRecorder();
  const CAPTURE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const handleCaptureStatus = async () => captureRecorder.getStatus();
  app.get('/api/admin/capture/status', handleCaptureStatus);

  const handleCaptureDates = async () => ({ status: 'ok', dates: captureRecorder.listDates() });
  app.get('/api/admin/capture/dates', handleCaptureDates);

  // Locate a session's archive(s) across all dates by raw session id.
  // Query param (not path segment) — client-supplied ids may contain "/", '"'
  // or even be whole JSON blobs; encodeURIComponent round-trips them safely.
  app.get('/api/admin/capture/find-session', async (req: any, reply: any) => {
    const id = String((req.query as any)?.id || '').trim();
    if (!id) {
      return reply.status(400).send({ status: 'error', message: 'query param "id" (session id) is required' });
    }
    return { status: 'ok', matches: captureRecorder.findBySession(id) };
  });

  app.get('/api/admin/capture/:date/sessions', async (req: any, reply: any) => {
    const { date } = req.params as { date: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    return { status: 'ok', date, sessions: captureRecorder.listSessions(date) };
  });

  app.get('/api/admin/capture/:date/:file', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    // Raw export: verbatim JSONL download, no record parsing/cap.
    // `exclude` (comma-separated, whitelisted body fields) strips those fields
    // per turn — metadata (ts/status/model/routing/usage) always survives.
    if ((req.query as any)?.format === 'raw') {
      // The set of body fields the export endpoint accepts for strip. Wider
      // than the legacy turn schema (upstreamResponse / inboundHttp / etc.)
      // — covers everything the new HTTP exchange event stream writes too.
      const RAW_EXCLUDE_FIELDS = new Set([
        'request',
        'upstreamRequest',
        'upstreamResponse',
        'upstreamHttp',
        'inboundHttp',
        'outboundHttp',
        'response',
        'upstreamError',
      ]);
      const exclude = String((req.query as any)?.exclude || '')
        .split(',')
        .map(f => f.trim())
        .filter(f => RAW_EXCLUDE_FIELDS.has(f));
      const content = captureRecorder.readRawArchive(date, file, exclude.length ? exclude : undefined);
      if (content === null) {
        return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
      }
      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="capture-${date}-${file}"`);
      return reply.send(content);
    }
    const limit = Math.min(Math.max(parseInt((req.query as any)?.limit || '200', 10) || 200, 1), 2000);
    const result = captureRecorder.readRecords(date, file, limit);
    if (result.totalLines === 0 && !captureRecorder.listSessions(date).some(s => s.file === file)) {
      return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
    }
    return { status: 'ok', date, file, ...result };
  });

  /**
   * Read the HTTP exchange events written by the capture pipeline.
   * Each inference turn produces 2-4 events sharing the same `traceId`:
   * client-request, gateway-response, upstream-request, upstream-response.
   * The console joins them into one logical turn via `traceId` / `spanId`.
   */
  app.get('/api/admin/capture/:date/:file/events', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const limit = Math.min(Math.max(parseInt((req.query as any)?.limit || '500', 10) || 500, 1), 5000);
    const result = captureRecorder.readEvents(date, file, limit);
    if (result.totalLines === 0 && !captureRecorder.listSessions(date).some(s => s.file === file)) {
      return reply.status(404).send({ status: 'error', message: 'Capture archive not found' });
    }
    return { status: 'ok', date, file, ...result };
  });

  app.delete('/api/admin/capture/:date/:file', async (req: any, reply: any) => {
    const { date, file } = req.params as { date: string; file: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const deleted = captureRecorder.deleteSession(date, file);
    if (!deleted) {
      return reply.status(404).send({ status: 'error', message: `Capture session ${file} not found in ${date}` });
    }
    return { status: 'ok', message: `Capture session ${date}/${file} deleted` };
  });

  app.delete('/api/admin/capture/:date', async (req: any, reply: any) => {
    const { date } = req.params as { date: string };
    if (!CAPTURE_DATE_RE.test(date)) {
      return reply.status(400).send({ status: 'error', message: 'date must be YYYY-MM-DD' });
    }
    const deleted = captureRecorder.deleteDate(date);
    if (!deleted) {
      return reply.status(404).send({ status: 'error', message: `No capture archive for ${date}` });
    }
    return { status: 'ok', message: `Capture archive ${date} deleted` };
  });

  /* ---------------------------------------------------------------------- *
   * Session observation maintenance (console /sessions page cleanup).
   * Console pages cannot present API keys, so destructive session ops live
   * under /api/admin — same trust surface as the capture-archive deletes
    * above. (DELETE /api/admin/sessions/:id is registered in server.ts together
    * with the rest of the sessions* surface.)
   * ---------------------------------------------------------------------- */

  // Clear ALL sessions: live routing state (pin / ratchet) plus every trace
  // in memory and the durable store.
  app.post('/api/admin/sessions/clear', async () => {
    const sessionMgr = orchestrator.getSessionManager();
    const sessionsCleared = sessionMgr?.getAllSessions().length ?? 0;
    sessionMgr?.clear();
    const { traces } = orchestrator.getTraceTracker().clearAll();
    return {
      status: 'ok',
      sessionsCleared,
      tracesCleared: traces,
      message: `Cleared ${sessionsCleared} session(s) and ${traces} trace(s)`,
    };
  });

}

