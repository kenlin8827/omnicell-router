import type { FastifyInstance } from 'fastify';
import { HOSTS } from '../harness/host/hosts.js';
import {
  adapterFor,
  hostDetected,
  isPluginHost,
  isMcpHost,
  isSkillsHost,
  skillOwner,
  skillRootsFor,
} from '../harness/host/adapters/index.js';
import { scanInventory } from '../harness/host/inventory.js';
import { claimsPath, manifestPath } from '../harness/host/manifest.js';
import { applyRemove, planRemove, type RemoveItem } from '../harness/host/maintenance.js';
import {
  pruneTranslationStore,
  probeTranslationChain,
  isSupportedLang,
  readCachedTranslations,
  translateDescription,
  translateMarkdown,
} from '../harness/translation.js';
import { probeSystemoneDefault } from '../surfaces/systemone-probe.js';
import { browseSource } from '../harness/common/market.js';
import { allHostProbes, createPluginAdapter, probeOptionsFor } from '../harness/plugin/adapters/index.js';
import { fetchRepoStars, peekStarCache } from '../harness/common/stars.js';
import { readMarketDetail } from '../harness/detail.js';
import { installArtifact } from '../harness/host/install.js';
import { recentApplies } from '../harness/host/ledger.js';
import { ENABLED_SCOPES, isEnabledScope } from '../harness/host/scopes.js';
import type { HarnessHostId, HarnessSourceView } from '../harness/types.js';
import { MCP_DEFAULT_VIEWS, SKILL_VIEWS, SOURCES } from '../harness/common/source-views.js';
import {
  checkSkillSource,
  registerSkillSource,
  removeSkillSource,
  rescanSkillSource,
  skillSourceEntry,
  updateSkillSource,
} from '../harness/skill/sources.js';
import { harvestAll } from '../harness/plugin/catalog.js';
import {
  browseMarketplace,
  getMarketplaceEntry,
  listMarketplaceEntries,
  latestSnapshot,
  marketplaceSourceId,
  probeMarketplace,
  snapshotHistory,
  updateMarketplaceEntry,
  writeNpmSourceSnapshot,
} from '../harness/common/market.js';
import { parseNpmSource, probeNpmSource } from '../harness/common/npm-source.js';
import { getBuiltinViewsForHarness } from '../harness/plugin/builtin.js';
import { reconcileMarketplaces } from '../harness/host/marketplace-sync.js';
import type { CatalogRow } from '../harness/plugin/types.js';

/**
 * Harness admin surface (ADR-0015): sources, hosts, inventory, install, uninstall, translate.
 *
 * Install goes through the source SPI (adapter.resolve → kind writer). MCP/plugin writers land
 * with their milestones; a request they cannot serve answers `unsupported_source`/`unsupported_kind`
 * — an endpoint that accepts a plan it cannot execute would be worse than a typed refusal.
 *
 * Measured accessibility, 2026-10-24: npm registry 200
 * anonymous. Measured 2026-10-25: `pi.dev/packages` 200 anonymous
 * (server-rendered HTML, no JSON API — the reader keys off the catalog's own card attributes).
 * Measured the same day, ClawHub's
 * public v1 API (`clawhub.ai`) answers 200 anonymous throughout — cursor-paged catalog, capped
 * whole-catalog search, and deterministic per-version ZIP downloads (3000 reads/min/IP).
 */

/**
 * The array order IS the console's display order and landing priority: per axis, the chip row
 * follows this sequence and the market opens on the FIRST enabled+browsable source for that axis.
 * The principle is low-noise first — within an axis, the order follows how far a row's claim
 * reaches: a catalog whose row IS the artifact (an official catalog, a
 * leaderboard entry) outranks a search over containers that CARRY the artifact (github's
 * topic-qualified repo search — the topic is self-declared, the stars reward the repo), which
 * outranks the one source that searches an entire package registry: npm, the wide net, is LAST
 * on purpose.
 */

/** One operator git-marketplace chip, materialized from the store: enabled state from the entry,
 *  browsable only once a probe has left a snapshot to browse. */
function mpSourceView(slug: string): HarnessSourceView | undefined {
  const entry = getMarketplaceEntry(slug);
  if (!entry) return undefined;
  const npm = entry.type === 'npm';
  const snap = latestSnapshot(slug, entry.harness);
  return {
    catalog: entry.catalog ?? 'default',
    id: marketplaceSourceId(slug),
    label: npm ? `${slug} (npm)` : `${slug} (git marketplace)`,
    // An npm entry carries packages only; a git entry may carry both kinds.
    kinds: npm ? ['plugin'] : ['skill', 'plugin'],
    trust: 'community',
    auth: 'none',
    enabled: entry.enabled,
    browsable: entry.enabled && snap !== null,
    hosts: entry.harness ? [entry.harness] : snap?.hosts,
  };
}

export function registerHarnessRoutes(app: FastifyInstance, opts: { marketplaceFetch?: typeof fetch } = {}): void {
  // Source registry + health. The console derives its tab row from this, never from a hardcoded list.
  app.get('/api/admin/harness/sources', async () => ({
    status: 'ok',
    sources: [...SOURCES, ...listMarketplaceEntries().map((e) => mpSourceView(e.slug)!)],
  }));

  // Per-harness plugin market (ADR-0015 §D10): the maintenance verbs live HERE, scoped to the
  // harness whose market tab is showing them — never on a global surface. The adapter forwards to
  // the SHARED marketplace store; the store being global is stated in §D11, and every mutation
  // re-harvests all served harnesses' indexes so no sibling tab goes stale.
  const pluginAdapterFor = (harness: string) => {
    if (!HOSTS.some((h) => h.id === harness)) return undefined;
    // The dialog maintains OPERATOR sources, so it always gets the writable chain: pi's official
    // surface is read-only by contract, while its git-source chain is the one that can add/remove.
    return createPluginAdapter(harness as HarnessHostId, opts.marketplaceFetch, { custom: true });
  };

  /** The entry behind a plugin-axis request: an entry whose snapshot carries no plugin row serves
   *  the skill axis only, so this route must not edit or delete it (§D11 route isolation). */
  const pluginEntry = (slug: string, harness: string) => {
    const entry = getMarketplaceEntry(slug, harness);
    if (!entry) return undefined;
    const snap = latestSnapshot(slug, entry.harness ?? harness);
    return (snap?.plugins.length ?? 0) > 0 ? entry : undefined;
  };

  // Per-harness sync: imports the marketplaces already configured in THIS harness's native
  // environment and pushes OCR's registrations back into it (ADR-0015 §D9, one direction each).

  app.get('/api/admin/harness/plugins/:harness/sources', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    const adapter = pluginAdapterFor(harnessParam);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    // KIND isolation (§D11): this route is the PER-HARNESS surface (plugin, plus MCP views when a
    // directory is wired). SKILLS are a GLOBAL directory with their OWN route (`/skills/sources`):
    // they are never served from a harness-scoped endpoint, because a skill source is not any
    // harness's private market. A source that cannot serve the open kind is noise, not information.
    const kindQ = ((req.query || {}) as { kind?: string }).kind;
    const kindOk = (kinds: readonly string[]) => !kindQ || kinds.includes(kindQ);
    const harness = harnessParam as HarnessHostId;
    const perHarness = [...MCP_DEFAULT_VIEWS, ...getBuiltinViewsForHarness(harness)].filter(
      (v) => !v.hosts || v.hosts.includes(harness),
    );
    return {
      status: 'ok',
      // This harness's published extension layer (`pi-extension`, `.claude-plugin`, …) or null.
      // The dialog pre-fills the add form with it; the API never applies it implicitly.
      extensionDir: adapter.extensionDir,
      sources: perHarness.filter((s) => kindOk(s.kinds)).map((s) => ({
        id: s.id,
        label: s.label,
        tier: 'federated' as const,
        sorts: s.sorts ?? ([] as string[]),
        counts: false,
      })),
      operator: listMarketplaceEntries(harness)
        .map((e) => {
          const snap = latestSnapshot(e.slug, harness);
          const kinds = [
            ...((snap?.rows.length ?? 0) > 0 ? ['skill' as const] : []),
            ...((snap?.plugins.length ?? 0) > 0 ? ['plugin' as const] : []),
          ];
          return {
            ...e,
            type: e.type ?? ('github' as const),
            /** Harnesses the repository's own forms declare (detected at probe time). */
            hosts: snap?.hosts ?? [],
            marketplace: snap?.marketplace ?? null,
            kinds,
          };
        })
        .filter((e) => kindOk(e.kinds)),
    };
  });

  // Full CRUD (§D11): the dialog edits the entry config in place — enable/disable and the rescan
  // schedule are independent fields, updated through this PATCH without a whole-store replace.
  app.patch('/api/admin/harness/plugins/:harness/sources/:slug', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    const adapter = pluginAdapterFor(harnessParam);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    const entry = pluginEntry(slug, harnessParam);
    if (!entry) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: `no source '${slug}'` };
    }
    const body = (req.body || {}) as {
      enabled?: boolean;
      catalog?: string;
      rescan?: { enabled?: boolean; intervalMs?: number };
    };
    const patch: { enabled?: boolean; catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } } = {};
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.catalog === 'string') patch.catalog = body.catalog;
    if (body.rescan) patch.rescan = body.rescan;
    if (Object.keys(patch).length === 0) return { status: 'ok' };
    if (!updateMarketplaceEntry(slug, patch, harnessParam)) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: `no source '${slug}'` };
    }
    // Enabling/disabling or re-cataloguing moves rows: every index re-reads the snapshot now.
    harvestAll();
    return { status: 'ok' };
  });

  // Manual rescan from the dialog (reports the diff: added / removed row counts).
  app.post('/api/admin/harness/plugins/:harness/sources/:slug/rescan', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    const adapter = pluginAdapterFor(harnessParam);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    const entry = pluginEntry(slug, harnessParam);
    if (!entry) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: `no source '${slug}'` };
    }
    const scope = entry.harness ?? (harnessParam as HarnessHostId);

    if (entry.type === 'npm') {
      const parsed = parseNpmSource(entry.repo);
      if (!parsed) {
        reply.code(400);
        return { status: 'error', code: 'invalid_source', message: 'invalid npm source spec' };
      }
      const probed = await probeNpmSource(parsed, opts.marketplaceFetch);
      if (!probed.ok) {
        reply.code(400);
        return { status: 'error', code: 'probe_failed', message: probed.message };
      }
      writeNpmSourceSnapshot(slug, probed.packages, scope);
      harvestAll();
      return { status: 'ok', rows: probed.packages.length };
    }

    const prev = latestSnapshot(slug, scope);
    const probe = await probeMarketplace(entry, opts.marketplaceFetch, {
      ...probeOptionsFor(entry.harness ?? (harnessParam as HarnessHostId)),
      hosts: allHostProbes(),
    });
    if (!probe.ok) {
      reply.code(400);
      return { status: 'error', code: 'probe_failed', message: probe.message };
    }
    // The new snapshot is the index's input: re-harvest every served harness so a rescan that
    // gained rows is visible in the catalog immediately.
    harvestAll();
    // Snapshots retain history: diff is against the IMMEDIATELY PRECEDING snapshot, not empty.
    const added = prev ? probe.snapshot.rows.filter((r) => !prev.rows.some((p) => p.name === r.name)).map((r) => r.name) : [];
    const removed = prev ? prev.rows.filter((p) => !probe.snapshot.rows.some((r) => r.name === p.name)).map((p) => p.name) : [];
    return { status: 'ok', rows: probe.snapshot.rows.length, diff: { added, removed } };
  });

  // Snapshot ledger inspection: the dialog can render recent scans with their timestamps.
  app.get('/api/admin/harness/plugins/:harness/sources/:slug/snapshots', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    const adapter = pluginAdapterFor(harnessParam);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const slug = (req.params as { slug: string }).slug;
    if (!getMarketplaceEntry(slug, harnessParam as HarnessHostId)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    const history = snapshotHistory(slug, harnessParam as HarnessHostId);
    return {
      status: 'ok',
      slug,
      snapshots: history.map((s) => ({
        probedAt: s.probedAt,
        sha: s.sha,
        rows: s.rows.length,
        plugins: s.plugins?.length ?? 0,
        stars: s.stars,
        pushedAt: s.pushedAt,
        marketplace: s.marketplace ?? null,
      })),
    };
  });

  // Register PROBES FIRST (an entry is written only when its repo answers a manifest or a
  // SKILL.md scan) and re-harvests every served harness's index; duplicate slugs answer 409.
  app.post('/api/admin/harness/plugins/:harness/sources', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const body = (req.body || {}) as {
      url?: string;
      type?: 'github' | 'npm';
      extensionDir?: string;
      catalog?: string;
      rescan?: { enabled?: boolean; intervalMs?: number };
    };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    const outcome = await adapter.registerSource(body.url, {
      catalog: body.catalog,
      rescan: body.rescan,
      extensionDir: body.extensionDir,
      ...(body.type ? { type: body.type } : {}),
    });
    if (!outcome.ok) {
      const reason = outcome.reason;
      // `no_form`/`probe_failed` are answers about the SOURCE; only a duplicate is a conflict.
      const conflict = reason === 'already_configured' || reason === 'slug_taken';
      reply.code(conflict ? 409 : 400);
      return {
        status: 'error',
        code: conflict ? 'conflict' : 'bad_request',
        reason,
        params: outcome.params,
        message: outcome.message ?? '',
      };
    }
    return { status: 'ok', reason: outcome.reason, params: outcome.params, message: outcome.message };
  });

  // Dry-run probe: reports counts without writing anything (the operator's "check before add").
  app.post('/api/admin/harness/plugins/:harness/sources/check', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const body = (req.body || {}) as { url?: string; type?: 'github' | 'npm'; extensionDir?: string };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    const check = await adapter.checkSource(body.url, {
      extensionDir: body.extensionDir,
      ...(body.type ? { type: body.type } : {}),
    });
    return { status: 'ok', ...check };
  });

  app.delete('/api/admin/harness/plugins/:harness/sources/:slug', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    const adapter = pluginAdapterFor(harnessParam);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    if (!pluginEntry(slug, harnessParam) || !adapter.unregisterSource(slug)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    return { status: 'ok' };
  });

  app.post('/api/admin/harness/plugins/:harness/sources/sync', async (req, reply) => {
    const harnessParam = (req.params as { harness: string }).harness;
    if (!pluginAdapterFor(harnessParam)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: 'unknown harness' };
    }
    const report = await reconcileMarketplaces([harnessParam as HarnessHostId], opts.marketplaceFetch);
    return { status: 'ok', ...report };
  });

  // ── Skill sources: the GLOBAL maintenance surface (§D11) ─────────────────────────────────────
  // The skill axis is not harness-scoped, so these verbs carry NO `:harness`: the registry is
  // code-configured (ClawHub) and an operator extension is a GitHub repository that publishes
  // SKILL.md rows. Plugin maintenance lives under `/plugins/:harness/sources*`; the two surfaces
  // never serve each other's axis.
  app.get('/api/admin/harness/skills/sources', async () => ({
    status: 'ok',
    sources: SKILL_VIEWS.map((s) => ({
      id: s.id,
      label: s.label,
      tier: 'federated' as const,
      sorts: s.sorts ?? ([] as string[]),
      counts: false,
    })),
    operator: listMarketplaceEntries()
      .map((e) => {
        const snap = latestSnapshot(e.slug, e.harness);
        const kinds = [
          ...((snap?.rows.length ?? 0) > 0 ? ['skill' as const] : []),
          ...((snap?.plugins.length ?? 0) > 0 ? ['plugin' as const] : []),
        ];
        return {
          ...e,
          type: e.type ?? ('github' as const),
          hosts: snap?.hosts ?? [],
          marketplace: snap?.marketplace ?? null,
          kinds,
        };
      })
      .filter((e) => e.kinds.includes('skill')),
  }));

  // Dry-run probe: a skill source must actually publish skills (check-before-add).
  app.post('/api/admin/harness/skills/sources/check', async (req, reply) => {
    const body = (req.body || {}) as { url?: string };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    return { status: 'ok', ...(await checkSkillSource(body.url, opts.marketplaceFetch)) };
  });

  app.post('/api/admin/harness/skills/sources', async (req, reply) => {
    const body = (req.body || {}) as { url?: string; catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    const outcome = await registerSkillSource(body.url, { catalog: body.catalog, rescan: body.rescan }, opts.marketplaceFetch);
    if (!outcome.ok) {
      const conflict = outcome.reason === 'already_configured' || outcome.reason === 'slug_taken';
      reply.code(conflict ? 409 : 400);
      return {
        status: 'error',
        code: conflict ? 'conflict' : 'bad_request',
        reason: outcome.reason,
        params: outcome.params,
        message: outcome.message ?? '',
      };
    }
    return { status: 'ok', reason: outcome.reason, params: outcome.params, message: outcome.message };
  });

  app.patch('/api/admin/harness/skills/sources/:slug', async (req, reply) => {
    const body = (req.body || {}) as {
      enabled?: boolean;
      catalog?: string;
      rescan?: { enabled?: boolean; intervalMs?: number };
    };
    if (!updateSkillSource((req.params as { slug: string }).slug, body)) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: `no source '${(req.params as { slug: string }).slug}'` };
    }
    return { status: 'ok' };
  });

  app.delete('/api/admin/harness/skills/sources/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!removeSkillSource(slug)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    return { status: 'ok' };
  });

  app.post('/api/admin/harness/skills/sources/:slug/rescan', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!skillSourceEntry(slug)) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: `no source '${slug}'` };
    }
    const result = await rescanSkillSource(slug, opts.marketplaceFetch);
    if (!result.ok) {
      reply.code(400);
      return { status: 'error', code: 'probe_failed', message: result.message };
    }
    return { status: 'ok', rows: result.rows, diff: { added: result.diff.added, removed: result.diff.removed } };
  });

  app.get('/api/admin/harness/plugins/:harness/catalog', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const query = (req.query || {}) as { q?: string; page?: string; pageSize?: string; sort?: string };
    const page = await adapter.search(query.q ?? '', {
      ...(query.page ? { page: Number(query.page) || 1 } : {}),
      ...(query.pageSize ? { pageSize: Number(query.pageSize) || 24 } : {}),
      ...(query.sort ? { sort: query.sort as never } : {}),
    });
    return { status: 'ok', ...page };
  });

  // Install funnels through the adapter into the HOST axis (§D11): the market adapter only
  // translates the row; the write lands via HarnessHostAdapter with gate-3 discipline intact.
  app.post('/api/admin/harness/plugins/:harness/install', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const body = (req.body || {}) as { row?: CatalogRow; scope?: string; confirm?: boolean };
    if (!body.row || typeof body.row !== 'object') {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'row is required' };
    }
    // Same trust boundary as the main install route: `project` is deferred, and the body cannot
    // widen the scope set the rest of the domain reads from `ENABLED_SCOPES`.
    if (!isEnabledScope(body.scope ?? 'global')) {
      reply.code(400);
      return {
        status: 'error',
        code: 'unsupported_scope',
        message: `scope '${body.scope}' is not supported — installs target ${ENABLED_SCOPES.join(', ')} scope`,
      };
    }
    const result = await adapter.install(body.row, {
      scope: (body.scope ?? 'global') as 'global',
      confirm: body.confirm === true,
    });
    if (!result.ok) {
      const status =
        result.code === 'exists' || result.code === 'foreign' || result.code === 'confirm_required'
          ? 409
          : result.code === 'upstream' || result.code === 'unavailable'
            ? 502
            : 400;
      reply.code(status);
      return { status: 'error', ...result };
    }
    return { status: 'ok', ...result };
  });

  // Host catalog + resolved roots. `origin` explains why a path is what it is.
  app.get('/api/admin/harness/hosts', async () => ({
    status: 'ok',
    // The scopes this build accepts (ADR-0015 §D2 "Scope"). A consumer must read this instead of
    // assuming a `project` landing exists: project support is deferred, and `roots` below carries
    // exactly the scopes named here.
    scopes: [...ENABLED_SCOPES],
    hosts: HOSTS.map((host) => {
      const roots = {
        global: skillRootsFor(host.id, 'global'),
      };
      // `owner` names the host a copy would be recorded under in that scope. A host that is not its
      // own owner is an alias: it reads a directory another host already owns.
      return {
        id: host.id,
        label: host.label,
        /** Present on this machine (executable, config dir, or an existing skills root). The
         *  console rail hides undetected hosts — but never one whose rows are already landed. */
        detected: hostDetected(adapterFor(host.id)!),
        hasSkills: isSkillsHost(adapterFor(host.id)),
        /** MCP-capable host: its adapter implements the MCP landing capability. */
        hasMcp: isMcpHost(adapterFor(host.id)),
        /** Plugin-capable host: its adapter implements the plugin landing capability. */
        hasExt: isPluginHost(adapterFor(host.id)),
        roots,
        owner: {
          global: roots.global[0] ? skillOwner(roots.global[0].root, 'global') : null,
        },
      };
    }),
  }));

  // Apply ledger — the audit trail behind every install/remove (ADR-0015 apply ledger).
  app.get('/api/admin/harness/applies', async () => ({ status: 'ok', applies: recentApplies(100) }));

  // Installed artifacts + untracked directories, reconciled per copy.
  app.get('/api/admin/harness/inventory', async () => {
    const inventory = scanInventory();
    return {
      status: 'ok',
      ...inventory,
      paths: { manifest: manifestPath(), claims: claimsPath() },
    };
  });

  // Dry run: nothing is written, and the plan expires in 10 minutes.
  app.post('/api/admin/harness/plan', async (req, reply) => {
    const body = (req.body || {}) as { action?: string; items?: RemoveItem[] };
    if (body.action !== 'remove') {
      reply.code(400);
      return { status: 'error', code: 'unsupported_action', message: "only 'remove' is implemented" };
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'items[] is required' };
    }
    // `planRemove` dereferences `item.copies` and `removal.op` directly; a shape check here turns a
    // malformed body into a 400 instead of a TypeError surfacing as a 500.
    for (const raw of body.items as unknown[]) {
      const item = raw as { copies?: unknown; removal?: { op?: unknown } } | null;
      if (!item || typeof item !== 'object') {
        reply.code(400);
        return { status: 'error', code: 'bad_request', message: 'items[] entries must be objects' };
      }
      if (!Array.isArray(item.copies)) {
        reply.code(400);
        return { status: 'error', code: 'bad_request', message: 'items[].copies[] is required' };
      }
      if (item.removal !== undefined) {
        const op = item.removal?.op;
        if (op !== 'trash-path' && op !== 'drop-entry' && op !== 'drop-server') {
          reply.code(400);
          return { status: 'error', code: 'bad_request', message: `unknown removal op '${String(op)}'` };
        }
      }
    }
    // artifactId null = a directory with no manifest entry; root containment is the guard.
    const plan = planRemove(body.items);
    if ('error' in plan) {
      reply.code(400);
      return { status: 'error', code: 'plan_rejected', message: plan.error };
    }
    return { status: 'ok', plan };
  });

  // Marketplace browse. An unavailable source answers with its reason instead of an empty list:
  // an empty market reads as "nothing exists", which is a different (and false) claim.
  app.get('/api/admin/harness/browse', async (req, reply) => {
    const query = (req.query || {}) as {
      source?: string;
      q?: string;
      limit?: string;
      harness?: string;
      page?: string;
      sort?: string;
      refresh?: string;
      kind?: string;
    };
    const requestedSource = query.source || SOURCES[0]?.id || '';
    const source =
      SOURCES.find((s) => s.id === requestedSource) ??
      mpSourceView(requestedSource.startsWith('mp-') ? requestedSource.slice(3) : requestedSource);
    if (!source) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${requestedSource}'` };
    }
    // An operator entry browses from its own snapshot, not the live-source dispatcher. The plugin
    // axis reads the snapshot's plugin rows: those ARE the plugins the operator added, and their
    // keys are the native install handles (`mp-<slug>:<repo>#<source>` / `npm:<pkg>`).
    if (source.id.startsWith('mp-')) {
      const slug = source.id.slice(3);
      const page = Math.max(Number(query.page) || 1, 1);
      const pageSize = Math.min(Number(query.limit) || 24, 100);
      const entry = getMarketplaceEntry(slug);
      if (query.kind === 'plugin' && entry) {
        const snapshot = latestSnapshot(slug);
        const needle = (query.q || '').trim().toLowerCase();
        const all = (snapshot?.plugins ?? [])
          .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.description ?? '').toLowerCase().includes(needle))
          .map((p) => {
            const key = entry.type === 'npm' ? `npm:${p.name}` : `${source.id}:${entry.repo}#${p.source}`;
            return {
              id: key,
              key,
              sourceId: source.id,
              installKind: 'plugin' as const,
              name: p.name,
              ...(entry.type === 'npm' ? {} : { repo: entry.repo }),
              description: p.description,
              url:
                entry.type === 'npm'
                  ? `https://www.npmjs.com/package/${p.name}`
                  : `https://github.com/${entry.repo}`,
              stars: entry.type === 'npm' ? null : snapshot?.stars ?? null,
              updatedAt: '',
              topics: [],
              // The install command spells `<plugin>@<marketplace>`; an npm row installs by spec.
              ...(entry.type === 'npm' ? {} : { marketplace: snapshot?.marketplace ?? null }),
            };
          });
        return {
          status: 'ok',
          source: source.id,
          page,
          items: all.slice((page - 1) * pageSize, page * pageSize),
          hasMore: page * pageSize < all.length,
          total: all.length,
        };
      }
      const browsed = browseMarketplace(slug, { query: query.q, page, pageSize });
      if (!browsed.ok) {
        reply.code(browsed.code === 'unknown_source' ? 404 : 409);
        return { status: 'error', code: browsed.code, message: browsed.message, source: source.id };
      }
      return {
        status: 'ok',
        source: source.id,
        page,
        items: browsed.items.map((i) => ({ ...i, id: i.key, sourceId: source.id, installKind: 'skill', stars: null, updatedAt: '', url: null, topics: [] })),
        hasMore: browsed.hasMore,
        total: browsed.total,
      };
    }
    // `page` is 1-based; a nonsense value falls back to the first page rather than answering empty.
    const page = Math.max(Number(query.page) || 1, 1);
    const result = await browseSource(source, query.q || '', Number(query.limit) || 24, {
      ...(query.harness ? { harness: query.harness } : {}),
      page,
      // `sort` is validated against the source's OWN declared orderings inside `browseSource`: an
      // order the upstream cannot serve is dropped, never forwarded as a guess.
      ...(query.sort ? { sort: query.sort } : {}),
      // `refresh=1` is the console's explicit "ask again" — it drops this source's 60 s window so the
      // answer is a new read, never a cached one. Anything else keeps the read-through.
      ...(query.refresh === '1' ? { refresh: true } : {}),
    });
    if (!result.ok) {
      reply.code(result.code === 'unavailable' ? 409 : 502);
      return {
        status: 'error',
        code: result.code,
        // The console translates `reason`; `message` is the English fallback and the diagnostic.
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.reasonParams ? { reasonParams: result.reasonParams } : {}),
        message: result.message,
        source: source.id,
      };
    }
    return {
      status: 'ok',
      source: source.id,
      page,
      items: result.items,
      hasMore: result.hasMore,
      ...(result.total !== undefined ? { total: result.total } : {}),
      note: result.note,
      noteCode: result.noteCode,
      noteParams: result.noteParams,
    };
  });

  // On-demand GitHub stars for market rows — the popularity half most catalogs never publish.
  //
  // The market itself is read-only enrichment-free (a browse never spends star quota), so this is a
  // SEPARATE, explicit call: the operator clicks, the console sends the repositories of the rows it is
  // showing, and one batched search answers them. `missing` is named rather than absorbed: a row whose
  // repo GitHub does not index keeps "unknown" instead of a fabricated 0.
  //
  // `cachedOnly: true` is the same read with the network REMOVED: it answers what the in-process star
  // cache already holds, so the console can show a cached count the moment a page renders instead of
  // asking for a click it would not spend (no unasked upstream spend, no held-back data).
  app.post('/api/admin/harness/market/stars', async (req, reply) => {
    const body = (req.body || {}) as { repos?: unknown; cachedOnly?: unknown };
    if (!Array.isArray(body.repos) || body.repos.length === 0) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: "'repos' must be a non-empty array of `owner/repo` strings" };
    }
    const repos = body.repos.filter((v): v is string => typeof v === 'string');
    if (repos.length === 0) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: "'repos' carried no strings" };
    }
    if (body.cachedOnly === true) {
      return { status: 'ok', ...peekStarCache(repos) };
    }
    const result = await fetchRepoStars(repos);
    if (!result.ok) {
      reply.code(result.code === 'unavailable' ? 409 : 502);
      return {
        status: 'error',
        code: result.code,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.reasonParams ? { reasonParams: result.reasonParams } : {}),
        message: result.message,
      };
    }
    return { status: 'ok', stars: result.stars, missing: result.missing, cached: result.cached };
  });

  // Market-row detail — the long-form half of a browse answer (README, licence, version).
  //
  // The console renders this in a native dialog rather than an iframe because the sources refuse
  // framing: measured 2026-10-25, github.com answers `X-Frame-Options: deny`, npmjs.com
  // `SAMEORIGIN` (plus a Cloudflare challenge) and pi.dev `SAMEORIGIN`. The endpoint therefore reads
  // upstreams it chooses itself — the package name parsed out of `npm:<name>`, a validated
  // `owner/repo`, or a `clawhub:<owner>/<slug>` pair — and NEVER follows a caller-supplied URL: that
  // would turn an admin GET into an arbitrary-URL proxy.
  app.get('/api/admin/harness/detail', async (req, reply) => {
    const query = (req.query || {}) as { source?: string; key?: string; repo?: string };
    let sourceId = 'direct';
    if (query.source) {
      const source =
        SOURCES.find((s) => s.id === query.source) ??
        mpSourceView(query.source.startsWith('mp-') ? query.source.slice(3) : query.source);
      if (!source) {
        reply.code(404);
        return { status: 'error', code: 'unknown_source', message: `unknown source '${query.source}'` };
      }
      sourceId = source.id;
    }
    const detail = await readMarketDetail({
      ...(query.key ? { key: query.key } : {}),
      ...(query.repo ? { repo: query.repo } : {}),
    });
    return { status: 'ok', source: sourceId, detail };
  });

  // Install one artifact into one or more host locations — one store entry, N copies. The route
  // speaks keys (`<sourceId>:<ref>[#detail]`); the SPI resolves the payload, the kind writer does
  // the disk work. An `ambiguous` answer carries `candidates` — the console picks one and retries
  // with a `#detail`-pinned key.
  app.post('/api/admin/harness/install', async (req, reply) => {
    const body = (req.body || {}) as {
      sourceId?: string;
      key?: string;
      repo?: string;
      kind?: string;
      skillDir?: string;
      manualPayload?: { name?: string; launch?: unknown };
      manualSpec?: string;
      confirm?: boolean;
      listedOn?: unknown;
      marketplace?: { repo?: string; plugin?: string; name?: string };
      hosts?: unknown;
      scope?: string;
    };
    const hosts = Array.isArray(body.hosts) ? body.hosts.filter((h): h is string => typeof h === 'string') : [];
    if (hosts.length === 0 || !body.scope) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'hosts[] and scope are required' };
    }
    // Scope is a capability, not a free-form field: this build installs to the user-level roots only
    // (ADR-0015 §D2 "Scope"). The orchestrator keeps `scope` as the seam, so the refusal lives here —
    // a request naming `project` must not reach a writer that would happily land inside the repo.
    if (!isEnabledScope(body.scope)) {
      reply.code(400);
      return {
        status: 'error',
        code: 'unsupported_scope',
        message: `scope '${body.scope}' is not supported — installs target ${ENABLED_SCOPES.join(', ')} scope`,
      };
    }
    // Validate the host catalog HERE, at the trust boundary: an unknown id would otherwise travel
    // through resolve/write and fail deep inside a writer with a message about the wrong thing.
    const unknown = hosts.find((id) => !HOSTS.some((host) => host.id === id));
    if (unknown !== undefined) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: `unknown host '${unknown}'` };
    }
    // The unknown-host check above already proved membership; this is the type narrowing, not a
    // second validation.
    const hostIds = hosts as HarnessHostId[];
    if (!body.key && !body.repo && !body.manualPayload && !body.manualSpec) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'key, repo, manualPayload or manualSpec is required' };
    }
    // Kind is validated HERE, at the trust boundary, for the same reason as hosts above: an unknown
    // kind must fail with a message about kind, not deep inside the orchestrator's default branch.
    if (body.kind !== 'skill' && body.kind !== 'mcp' && body.kind !== 'plugin') {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: `unknown kind '${body.kind}'` };
    }
    const kind = body.kind;
    const manualPayload =
      body.manualPayload && typeof body.manualPayload.name === 'string' && body.manualPayload.launch
        ? { name: body.manualPayload.name, launch: body.manualPayload.launch as never }
        : undefined;
    // Listing surfaces are validated HERE, at the trust boundary, against the same registry the
    // console builds its source chips from: a claim about where a row was browsed must name a source
    // this gateway declares — built-in views OR an operator git source (`mp-*`, materialized from
    // the marketplace store) — or it is dropped rather than recorded.
    const listedOn = Array.isArray(body.listedOn)
      ? body.listedOn.filter(
          (id): id is string =>
            typeof id === 'string' && (SOURCES.some((s) => s.id === id) || /^mp-[a-z0-9][a-z0-9-]{0,38}$/.test(id)),
        )
      : undefined;
    const result = await installArtifact({
      sourceId: body.sourceId,
      key: body.key,
      repo: body.repo,
      kind,
      skillDir: body.skillDir,
      manualPayload,
      manualSpec: typeof body.manualSpec === 'string' ? body.manualSpec : undefined,
      confirm: body.confirm === true,
      listedOn,
      hosts: hostIds,
      scope: body.scope,
      ...(kind === 'plugin' &&
      body.marketplace &&
      typeof body.marketplace.repo === 'string' &&
      typeof body.marketplace.plugin === 'string' &&
      typeof body.marketplace.name === 'string'
        ? { marketplace: { repo: body.marketplace.repo, plugin: body.marketplace.plugin, name: body.marketplace.name } }
        : {}),
    });
    if (!result.ok) {
      const status =
        result.code === 'exists' || result.code === 'foreign' || result.code === 'confirm_required'
          ? 409
          : result.code === 'upstream' || result.code === 'unavailable'
            ? 502
            : 400;
      reply.code(status);
      return { status: 'error', ...result };
    }
    return { status: 'ok', ...result };
  });

  // Description translation (derived cache; the model call goes through this gateway's own /v1).
  // `format: 'markdown'` switches to the long-form contract: a README is a document, so it is
  // translated in chunked prose runs (fenced code preserved verbatim) under its own cache namespace
  // and a length budget — the description prompt would answer a 3 000-word page with two sentences.
  app.post('/api/admin/harness/translate', async (req, reply) => {
    const body = (req.body || {}) as { text?: string; lang?: string; format?: string };
    const text = (body.text || '').trim();
    if (!text) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'text is required' };
    }
    if (!body.lang) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang is required' };
    }
    const result =
      body.format === 'markdown'
        ? await translateMarkdown(text, body.lang)
        : await translateDescription(text, body.lang);
    if ('code' in result) {
      reply.code(result.code === 'no_api_key' ? 409 : 502);
      return { status: 'error', ...result };
    }
    return { status: 'ok', ...result };
  });

  // Batch translation. One chunk per call, small in-process pool: the console walks the list in
  // chunks so a slow tier never turns one request into a 60-second hang, and a dropped connection
  // resumes from the cache instead of losing everything.
  app.post('/api/admin/harness/translate-batch', async (req, reply) => {
    const body = (req.body || {}) as { lang?: string; texts?: unknown };
    if (!body.lang || !Array.isArray(body.texts)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang and texts[] are required' };
    }
    const texts = [
      ...new Set(
        body.texts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      ),
    ].slice(0, 50);
    if (texts.length === 0) return { status: 'ok', results: {}, errors: [] };

    const results: Record<string, { text: string; model: string; cached: boolean }> = {};
    const errors: { text: string; code: string; message: string }[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < texts.length) {
        const text = texts[cursor++];
        const result = await translateDescription(text, body.lang!);
        if ('code' in result) errors.push({ text, code: result.code, message: result.message });
        else results[text] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, texts.length) }, worker));

    // No key = every item fails the same way; say it once instead of 50 identical rows.
    if (errors.length === texts.length && errors.every((e) => e.code === 'no_api_key')) {
      reply.code(409);
      return { status: 'error', code: 'no_api_key', message: errors[0].message };
    }
    return { status: 'ok', results, errors };
  });

  // Cache-only lookup: the console seeds every already-translated description on mount, no spend.
  app.post('/api/admin/harness/translations', async (req, reply) => {
    const body = (req.body || {}) as { lang?: string; texts?: unknown; format?: string };
    if (!body.lang || !Array.isArray(body.texts)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'lang and texts[] are required' };
    }
    // The cache seed READS a path derived from `lang`; an unchecked value would let a caller walk
    // out of the cache directory. The translate verbs already check this.
    if (!isSupportedLang(body.lang)) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: `unsupported language '${body.lang}'` };
    }
    const texts = body.texts
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .slice(0, 500);
    return {
      status: 'ok',
      translations: readCachedTranslations(texts, body.lang, body.format === 'markdown' ? 'readme' : 'descriptions'),
    };
  });

  // Housekeeping on the derived translation store: age expiry, then oldest-first trimming under the
  // size budget. Writes sweep on a throttle; this is the manual lever for an operator (or a future
  // console button) that wants it now. Nothing here is correctness-bearing — the cache is derived.
  app.post('/api/admin/harness/translations/prune', async (req) => {
    const body = (req.body || {}) as { maxAgeDays?: unknown; maxBytes?: unknown };
    const maxAgeDays = typeof body.maxAgeDays === 'number' ? body.maxAgeDays : undefined;
    const maxBytes = typeof body.maxBytes === 'number' ? body.maxBytes : undefined;
    const stats = pruneTranslationStore({
      ...(maxAgeDays !== undefined ? { maxAgeMs: Math.max(maxAgeDays, 0) * 24 * 60 * 60 * 1000 } : {}),
      ...(maxBytes !== undefined ? { maxBytes: Math.max(maxBytes, 0) } : {}),
    });
    return { status: 'ok', ...stats };
  });

  // Chain probe behind the console's default-model "test" buttons. `model` in the body carries the
  // PICKER'S PENDING value (test BEFORE save; empty string = "as if unset"); absent → the saved
  // config. Both probes under one diagnostic contract: explicit click = explicit one-call spend,
  // honest verdicts, nothing persisted by the probe itself.
  app.post('/api/admin/harness/translations/probe', async (req) => {
    const body = (req.body || {}) as { lang?: unknown; model?: unknown };
    return probeTranslationChain(
      typeof body.lang === 'string' ? body.lang : 'en',
      typeof body.model === 'string' ? body.model : undefined
    );
  });

  // System One default-model probe — the Settings "默认模型" card's second "test" button. Fires
  // the REAL /v1/systemone fallback path; with a pending selection it rides as an explicit
  // `model` through the surface's own admission gates.
  app.post('/api/admin/systemone/probe', async (req) => {
    const body = (req.body || {}) as { model?: unknown };
    return probeSystemoneDefault(typeof body.model === 'string' ? body.model : undefined);
  });

  // Execute a plan. 409 for every refusal — the plan is stale, unknown, or needs a discard flag.
  app.post('/api/admin/harness/apply', async (req, reply) => {
    const body = (req.body || {}) as { planId?: string; discardLocalEdits?: boolean };
    if (!body.planId) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'planId is required' };
    }
    const result = applyRemove(body.planId, { discardLocalEdits: body.discardLocalEdits === true });
    if (!result.ok) {
      reply.code(409);
      return { status: 'error', code: result.code, message: result.message };
    }
    return { status: 'ok', ...result };
  });
}
