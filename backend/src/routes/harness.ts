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
  readCachedTranslations,
  translateDescription,
  translateMarkdown,
} from '../harness/translation.js';
import { probeSystemoneDefault } from '../surfaces/systemone-probe.js';
import { browseSource } from '../harness/market/browse.js';
import { createPluginAdapter } from '../harness/plugin/market.js';
import { fetchRepoStars, peekStarCache } from '../harness/market/stars.js';
import { readMarketDetail } from '../harness/detail.js';
import { installArtifact } from '../harness/host/install.js';
import { recentApplies } from '../harness/host/ledger.js';
import { ENABLED_SCOPES, isEnabledScope } from '../harness/host/scopes.js';
import type { HarnessHostId, HarnessKind, HarnessSourceView } from '../harness/types.js';
import { SOURCES as SOURCES_VIEW } from '../harness/market/source-views.js';
import {
  browseMarketplace,
  getMarketplaceEntry,
  listMarketplaces,
  latestSnapshot,
  marketplaceSourceId,
  probeMarketplace,
  snapshotHistory,
  updateMarketplace,
} from '../harness/market/marketplaces.js';
import { harvestAll } from '../harness/plugin/catalog.js';

/**
 * Harness admin surface (ADR-0015): sources, hosts, inventory, install, uninstall, translate.
 *
 * Install goes through the source SPI (adapter.resolve → kind writer). MCP/plugin writers land
 * with their milestones; a request they cannot serve answers `unsupported_source`/`unsupported_kind`
 * — an endpoint that accepts a plan it cannot execute would be worse than a typed refusal.
 *
 * Measured accessibility, 2026-10-24: skills.sh API 401 (Vercel OIDC only), npm registry 200
 * anonymous. Measured 2026-10-25: `pi.dev/packages` 200 anonymous
 * (server-rendered HTML, no JSON API — the reader keys off the catalog's own card attributes), and
 * `skills.sh`'s leaderboard PAGES 200 anonymous (`/`, `/trending`, `/hot`, each shipping its 600-row
 * board in the RSC flight payload) and so does its own search endpoint (`/api/search`, 200 anonymous,
 * capped at 200 rows per query) even though its API stays closed. Measured the same day, ClawHub's
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
const SOURCES: HarnessSourceView[] = SOURCES_VIEW;

/** One operator git-marketplace chip, materialized from the store: enabled state from the entry,
 *  browsable only once a probe has left a snapshot to browse. */
function mpSourceView(slug: string): HarnessSourceView | undefined {
  const entry = getMarketplaceEntry(slug);
  if (!entry) return undefined;
  return {
    id: marketplaceSourceId(slug),
    label: `${slug} (git marketplace)`,
    kinds: ['skill', 'plugin'],
    trust: 'community',
    auth: 'none',
    enabled: entry.enabled,
    browsable: entry.enabled && latestSnapshot(slug) !== null,
  };
}

export function registerHarnessRoutes(app: FastifyInstance, opts: { marketplaceFetch?: typeof fetch } = {}): void {
  // Source registry + health. The console derives its tab row from this, never from a hardcoded list.
  app.get('/api/admin/harness/sources', async () => ({
    status: 'ok',
    sources: [...SOURCES, ...listMarketplaces().map((e) => mpSourceView(e.slug)!)],
  }));

  // Per-harness plugin market (ADR-0015 §D10): the maintenance verbs live HERE, scoped to the
  // harness whose market tab is showing them — never on a global surface. The adapter forwards to
  // the SHARED marketplace store; the store being global is stated in §D11, and every mutation
  // re-harvests all served harnesses' indexes so no sibling tab goes stale.
  const pluginAdapterFor = (harness: string) => {
    if (!HOSTS.some((h) => h.id === harness)) return undefined;
    return createPluginAdapter(harness as HarnessHostId, opts.marketplaceFetch);
  };

  app.get('/api/admin/harness/plugins/:harness/sources', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    // Kind isolation (§D11): the dialog that opens on the skill tab must not list plugin sources
    // and vice versa. `kind` narrows BOTH lists — the built-in chips by their declared `kinds`,
    // the operator entries by what their snapshot actually carries. A source with no rows of the
    // kind is not listed there: a chip that cannot serve the open tab is noise, not information.
    const kindQ = ((req.query || {}) as { kind?: string }).kind;
    const kindOk = (kinds: readonly string[]) => !kindQ || kinds.includes(kindQ);
    return {
      status: 'ok',
      sources: SOURCES_VIEW.filter((s) => kindOk(s.kinds)).map((s) => ({
        id: s.id,
        label: s.label,
        tier: 'federated' as const,
        sorts: [] as string[],
        counts: false,
      })),
      operator: listMarketplaces()
        .map((e) => {
          const snap = latestSnapshot(e.slug);
          const kinds = [
            ...((snap?.rows.length ?? 0) > 0 ? ['skill' as const] : []),
            ...((snap?.plugins.length ?? 0) > 0 ? ['plugin' as const] : []),
          ];
          return { ...e, kinds };
        })
        .filter((e) => kindOk(e.kinds)),
    };
  });

  // Full CRUD (§D11): the dialog edits the entry config in place — enable/disable and the rescan
  // schedule. Toggling enabled changes which snapshots the harvest reads, so the mutation
  // re-harvests every served harness, same as register/remove.
  app.patch('/api/admin/harness/plugins/:harness/sources/:slug', async (req, reply) => {
    if (!pluginAdapterFor((req.params as { harness: string }).harness)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    const body = (req.body || {}) as { enabled?: boolean; rescan?: { enabled?: boolean; intervalMs?: number } };
    const updated = updateMarketplace(slug, body);
    if (!updated) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    harvestAll();
    return { status: 'ok', entry: updated };
  });

  // Manual rescan: same probe as the scheduler, persisted, then a full re-harvest. The diff
  // REPORTS additions/removals — it never rewrites installed copies (§D9).
  app.post('/api/admin/harness/plugins/:harness/sources/:slug/rescan', async (req, reply) => {
    if (!pluginAdapterFor((req.params as { harness: string }).harness)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    const entry = getMarketplaceEntry(slug);
    if (!entry) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    const outcome = await probeMarketplace(entry, opts.marketplaceFetch);
    if (!outcome.ok) {
      reply.code(409);
      return { status: 'error', code: outcome.code ?? 'unavailable', message: outcome.message };
    }
    harvestAll();
    return { status: 'ok', diff: outcome.snapshot.lastDiff ?? null, rows: outcome.snapshot.rows.length };
  });

  // Bounded snapshot history (§D9): probes are summarized, never a raw dump.
  app.get('/api/admin/harness/plugins/:harness/sources/:slug/snapshots', async (req, reply) => {
    if (!pluginAdapterFor((req.params as { harness: string }).harness)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    if (!getMarketplaceEntry(slug)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    return {
      status: 'ok',
      snapshots: snapshotHistory(slug).map((s) => ({
        probedAt: s.probedAt,
        sha: s.sha,
        stars: s.stars,
        rows: s.rows.length,
        added: s.lastDiff?.added ?? null,
        removed: s.lastDiff?.removed ?? null,
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
    const body = (req.body || {}) as { url?: string; rescan?: { enabled?: boolean; intervalMs?: number } };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    const outcome = await adapter.registerSource(body.url, { rescan: body.rescan });
    if (!outcome.ok) {
      const message = outcome.message ?? '';
      const conflict = message.includes('already configured');
      reply.code(conflict ? 409 : 400);
      return { status: 'error', code: conflict ? 'conflict' : 'bad_request', message };
    }
    return { status: 'ok', message: outcome.message };
  });

  // Dry-run probe: reports counts without writing anything (the operator's "check before add").
  app.post('/api/admin/harness/plugins/:harness/sources/check', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const body = (req.body || {}) as { url?: string };
    if (!body.url) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'url is required' };
    }
    const check = await adapter.checkSource(body.url);
    return { status: 'ok', ...check };
  });

  app.delete('/api/admin/harness/plugins/:harness/sources/:slug', async (req, reply) => {
    const adapter = pluginAdapterFor((req.params as { harness: string }).harness);
    if (!adapter) {
      reply.code(404);
      return { status: 'error', code: 'unknown_harness', message: `unknown harness` };
    }
    const { slug } = req.params as { slug: string };
    if (!adapter.unregisterSource(slug)) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${slug}'` };
    }
    return { status: 'ok' };
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
    const body = (req.body || {}) as { row?: never; scope?: 'global' | 'project' };
    if (!body.row || typeof body.row !== 'object') {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'row is required' };
    }
    const result = await adapter.install(body.row, { scope: body.scope });
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
    const source = SOURCES.find((s) => s.id === (query.source || 'github')) ?? mpSourceView((query.source || '').startsWith('mp-') ? (query.source || '').slice(3) : '');
    if (!source) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${query.source}'` };
    }
    // An operator git marketplace browses from its own snapshot, not the live-source dispatcher.
    if (source.id.startsWith('mp-')) {
      const page = Math.max(Number(query.page) || 1, 1);
      const browsed = browseMarketplace(source.id.slice(3), { query: query.q, page, pageSize: Math.min(Number(query.limit) || 24, 100) });
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
    // The market axis the console is browsing. Only npm forks on it today (default query + row
    // install kind); a value outside the kind vocabulary is dropped, never forwarded.
    const kind: HarnessKind | undefined = ['skill', 'mcp', 'plugin'].includes(query.kind ?? '')
      ? (query.kind as HarnessKind)
      : undefined;
    // `page` is 1-based; a nonsense value falls back to the first page rather than answering empty.
    const page = Math.max(Number(query.page) || 1, 1);
    const result = await browseSource(source, query.q || '', Number(query.limit) || 24, {
      ...(query.harness ? { harness: query.harness } : {}),
      ...(kind ? { kind } : {}),
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
    const source = SOURCES.find((s) => s.id === (query.source || 'github'));
    if (!source) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${query.source}'` };
    }
    const detail = await readMarketDetail({
      ...(query.key ? { key: query.key } : {}),
      ...(query.repo ? { repo: query.repo } : {}),
    });
    return { status: 'ok', source: source.id, detail };
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
