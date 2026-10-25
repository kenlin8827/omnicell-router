import type { FastifyInstance } from 'fastify';
import { HOSTS } from '../harness/hosts.js';
import {
  adapterFor,
  isExtensionHost,
  isMcpHost,
  isSkillsHost,
  skillOwner,
  skillRootsFor,
} from '../harness/adapters/index.js';
import { scanInventory } from '../harness/inventory.js';
import { claimsPath, manifestPath } from '../harness/manifest.js';
import { applyRemove, planRemove, type RemoveItem } from '../harness/maintenance.js';
import {
  pruneTranslationStore,
  probeTranslationChain,
  readCachedTranslations,
  translateDescription,
  translateMarkdown,
} from '../harness/translation.js';
import { probeSystemoneDefault } from '../surfaces/systemone-probe.js';
import { browseSource } from '../harness/browse.js';
import { fetchRepoStars, peekStarCache } from '../harness/stars.js';
import { readMarketDetail } from '../harness/detail.js';
import { installArtifact } from '../harness/install.js';
import { recentApplies } from '../harness/ledger.js';
import { ENABLED_SCOPES, isEnabledScope } from '../harness/scopes.js';
import type { HarnessHostId, HarnessKind, HarnessSourceView } from '../harness/types.js';

/**
 * Harness admin surface (ADR-0015): sources, hosts, inventory, install, uninstall, translate.
 *
 * Install goes through the source SPI (adapter.resolve → kind writer). MCP/extension writers land
 * with their milestones; a request they cannot serve answers `unsupported_source`/`unsupported_kind`
 * — an endpoint that accepts a plan it cannot execute would be worse than a typed refusal.
 *
 * Measured accessibility, 2026-10-24: skills.sh API 401 (Vercel OIDC only), MCP official registry 200
 * anonymous, Smithery 200 anonymous, PulseMCP 410 (retired),
 * mcp.so 404, npm registry 200 anonymous. Measured 2026-10-25: `pi.dev/packages` 200 anonymous
 * (server-rendered HTML, no JSON API — the reader keys off the catalog's own card attributes), and
 * `skills.sh`'s leaderboard PAGES 200 anonymous (`/`, `/trending`, `/hot`, each shipping its 600-row
 * board in the RSC flight payload) and so does its own search endpoint (`/api/search`, 200 anonymous,
 * capped at 200 rows per query) even though its API stays closed. Measured the same day, ClawHub's
 * public v1 API (`clawhub.ai`) answers 200 anonymous throughout — cursor-paged catalog, capped
 * whole-catalog search, and deterministic per-version ZIP downloads (3000 reads/min/IP).
 * The curated OpenCode catalog is
 * NOT a network source: it ships as a snapshot
 * (`harness/opencode-ecosystem.ts`), because `raw.githubusercontent.com` and `cdn.jsdelivr.net` both
 * reset the connection from here.
 */

/**
 * The array order IS the console's display order and landing priority: per axis, the chip row
 * follows this sequence and the market opens on the FIRST enabled+browsable source for that axis.
 * The principle is low-noise first — within an axis, the order follows how far a row's claim
 * reaches: a catalog whose row IS the artifact (an official catalog, a curated snapshot, a
 * leaderboard entry) outranks a search over containers that CARRY the artifact (github's
 * topic-qualified repo search — the topic is self-declared, the stars reward the repo), which
 * outranks the one source that searches an entire package registry: npm, the wide net, is LAST
 * on purpose.
 */
const SOURCES: HarnessSourceView[] = [
  {
    id: 'skills-sh',
    label: 'skills.sh',
    kinds: ['skill'],
    trust: 'aggregator',
    // `auth` describes the API (`/api/v1/skills` = 401 without a Vercel workload token), which this
    // console never calls. The market reads the endpoint the SITE's own browser reads, so it needs no
    // credential: measured 2026-10-25, `GET /api/skills/<view>/<page>` answers 200 anonymously with
    // 200 rows per (0-based) page, its own `total` (9 911 on All-time) and `hasMore`
    // (`harness/skills-sh.ts`).
    auth: 'oidc',
    enabled: true,
    browsable: true,
    // The site's three leaderboards in its own tab order. An empty query lands on the chosen board; a
    // query of 2+ characters goes to the site's own search endpoint (`/api/search`, anonymous, whole
    // catalog, capped at 200 rows). Rows install as `github:<owner/repo>#<skill-dir>` — the site's own
    // `npx skills add` identity.
    sorts: ['all-time', 'trending', 'hot'],
    // FIRST on the skills axis on purpose: a row here IS a skill directory, ranked by the site's
    // own install tally. github's topic-qualified search answers with REPOS that self-declare the
    // topic — a noisier unit, one repo holding any number of skills or none — and npm's
    // registry-wide keyword search (whose rows cannot install as skills at all) is the wide net
    // below that.
  },
  {
    id: 'clawhub',
    label: 'ClawHub',
    kinds: ['skill'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // OpenClaw's public skill registry (`clawhub.ai`), measured 2026-10-25: `GET /api/v1/skills`
    // pages by opaque CURSOR with its own `sort` enum, `GET /api/v1/search` covers the whole catalog
    // with NO paging parameter (a `totalScope: 'window'` answer, like skills.sh's search), and
    // `GET /api/v1/download?slug=&ownerHandle=&version=` answers deterministic ZIP bytes. Install
    // reads the newest published semver, downloads THAT version, and pins `{ clawhub: { slug,
    // version } }` — a registry-version pin, not a commit. `ownerHandle` is the disambiguator the
    // registry's own 409 error names; it is undocumented on the endpoints but measured working.
    // AFTER skills-sh, BEFORE github on the skills axis on purpose: a row here IS a skill (a slug
    // in a dedicated registry), while github's search answers with REPOS that self-declare the
    // topic and npm's registry-wide search is the wide net. Rows carry no GitHub repo, so no star
    // count is ever claimed for them.
    sorts: ['downloads', 'stars', 'updated'],
  },
  {
    id: 'mcp-official',
    label: 'MCP official registry',
    kinds: ['mcp'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    // Browse reads `GET /v0/servers?limit=&search=&cursor=&version=latest` (200 anonymous, measured
    // 2026-10-25) and pages by opaque CURSOR, so a market page number walks a chain rather than an
    // offset. No `sorts`: the registry publishes no ordering parameter. Install resolves ONE record
    // through `/v0/servers/<name>/versions/latest` — the bare `/v0/servers/<name>` path answers 404.
  },
  {
    id: 'smithery',
    label: 'Smithery',
    kinds: ['mcp'],
    trust: 'aggregator',
    auth: 'none',
    enabled: true,
    browsable: true,
    // Browse reads `GET /servers?page=&pageSize=&q=` (200 anonymous, measured 2026-10-25). No `sorts`:
    // the registry publishes one order (its own usage ranking) and no parameter to change it. The
    // listing serves 500 rows at most while claiming ~20 765, so the market reports the REACHABLE count
    // and says so (`noteCode: 'smithery-window'`). Install resolves `GET /servers/<qualifiedName>` and
    // emits the HOSTED deployment plus an `Authorization` env reference — Smithery hosts these servers,
    // which is why it is the one aggregator allowed to supply a launch spec (ADR-0015 §D6).
  },
  {
    id: 'pi-dev',
    label: 'pi.dev (official)',
    kinds: ['extension'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    // The official Pi package catalog (`pi.dev/packages`): extensions plus untyped Pi packages, every
    // row printed with its own `pi install npm:<pkg>` command. Rows therefore carry an `npm:<pkg>`
    // handle and install through the npm source — one package, ONE identity, and the console's
    // installed-state join stays exact. This source produces no payload of its own (browse-only).
    //
    // First for the extension axis on purpose: a pi page should open on its own official catalog, not
    // on a keyword search of the whole npm registry.
    hosts: ['pi'],
    // The catalog's sort CONTROL offers three orders (`Most downloads` / `Recently published` / `A-Z`),
    // which map to `?sort=downloads|recent|name` — measured 2026-10-25: each reorders the page, and an
    // unknown value silently falls back to downloads. Those three are the source's whole official set.
    sorts: ['downloads', 'recent', 'name'],
  },
  {
    id: 'github',
    label: 'GitHub',
    kinds: ['skill'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // AFTER skills-sh and clawhub on the skills axis on purpose: both answer with rows that ARE
    // skills — the leaderboard ranked by installs, the registry by its own tally — while a topic
    // is self-declared on the REPO and a star count rewards the repo, not the skill. github is
    // the wider net here, and npm — whose rows cannot install as skills at all — stays below it.
    //
    // GitHub search repositories is the ONE market source with a published ordering contract:
    // `sort=stars|forks|help-wanted-issues|updated` (+ best-match when the parameter is omitted).
    // ALL of them are offered — the official set is the ceiling, not a curation of it; `stars` stays
    // first because it is what this market has always shown.
    sorts: ['stars', 'best-match', 'forks', 'updated', 'help-wanted-issues'],
  },
  {
    id: 'static-opencode',
    label: 'OpenCode ecosystem (curated)',
    kinds: ['extension'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // The curated list is OpenCode's own plugin catalog: those packages are written against the
    // OpenCode plugin API, so the source is bound to that one harness (ADR-0015 §D2 — no free host
    // checkbox list). Browse reads a shipped snapshot (no network); a row that has a verified npm
    // package name carries an `npm:<pkg>` install key, so installing it runs the npm source — this
    // source produces no payload of its own and has no install adapter.
    //
    // First of the opencode cluster on purpose: a curated snapshot whose rows were verified
    // against the registry is the lowest-noise answer for this runtime, so an opencode page opens
    // on it — the community catalogs follow, and npm's registry-wide search closes the axis.
    hosts: ['opencode'],
    // Full-catalog sources are read WHOLE by the backend before paging, so an order computed here is
    // global and honest (unlike a console-side re-sort of the visible page). `catalog` is the
    // snapshot's own order; `name` is the one dimension these rows all carry.
    sorts: ['catalog', 'name'],
  },
  {
    id: 'awesome-opencode',
    label: 'awesome-opencode (community)',
    kinds: ['extension'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // The community list publishes `dist/registry.json` — a flat array with a declared shape
    // (`data/schema.json`), generated from one YAML file per entry. It is read through the GitHub
    // contents API (raw mirrors reset from this environment). Entries carry no package name, so the
    // install adapter resolves one on demand (declared name → repository-verified candidate) and
    // answers the npm identity; the row's key stays this source's until install time.
    hosts: ['opencode'],
    sorts: ['catalog', 'name'],
  },
  {
    id: 'opencode-cafe',
    label: 'opencode.cafe (community)',
    kinds: ['extension'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // A Next.js site over a Convex deployment; the catalog query (`extensions:listAllApproved`) is
    // anonymously readable and is read directly with a POST. Undocumented contract: a re-provisioned
    // deployment answers `upstream`, never an empty catalog. Only `type: 'plugin'` rows are
    // extensions. The public query ships author e-mail addresses, which `opencode-cafe.ts` narrows
    // away before anything else sees a row.
    hosts: ['opencode'],
    sorts: ['catalog', 'name'],
  },
  {
    id: 'npm',
    label: 'npm registry',
    kinds: ['skill', 'extension', 'mcp'],
    trust: 'community',
    auth: 'none',
    enabled: true,
    browsable: true,
    // LAST in the array on purpose — the noisiest surface in the registry. An empty query is a
    // relevance guess across the WHOLE npm registry (the pinned per-runtime tag below narrows it),
    // it is bound to no runtime, and its search serves the most rows. Every source above pins its
    // rows to the artifact kind harder than npm does, so npm is the wide net an operator opts
    // into, never the landing state.
    //
    // npm's registry search has NO `sort` and its documented ranking weights are inert today
    // (measured 2026-10-25). `name`/`updated` are therefore ordered by the BACKEND over one maximum
    // window of the registry's own ranking — server-side, not in the page, and the note names the
    // window. `relevance` is the registry's untouched order.
    sorts: ['relevance', 'updated', 'name'],
    // The MCP axis opens on the author's own `mcp-server` tag (measured 2026-10-25: 10 501
    // packages; the wider `model-context-protocol` tag at 41 344 is mostly SDKs and clients), and
    // an mcp row resolves to a launch over the pinned spec (`npx -y <pkg@version>` + integrity).
    // No `hosts`: a package is not bound to a runtime until the operator names the harness, and
    // only a runtime with a verified package-manager landing can take it.
  },
];

export function registerHarnessRoutes(app: FastifyInstance): void {
  // Source registry + health. The console derives its tab row from this, never from a hardcoded list.
  app.get('/api/admin/harness/sources', async () => ({ status: 'ok', sources: SOURCES }));

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
        hasSkills: isSkillsHost(adapterFor(host.id)),
        /** MCP-capable host: its adapter implements the MCP landing capability. */
        hasMcp: isMcpHost(adapterFor(host.id)),
        /** Extension-capable host: its adapter implements the extension landing capability. */
        hasExt: isExtensionHost(adapterFor(host.id)),
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
    const source = SOURCES.find((s) => s.id === (query.source || 'github'));
    if (!source) {
      reply.code(404);
      return { status: 'error', code: 'unknown_source', message: `unknown source '${query.source}'` };
    }
    // The market axis the console is browsing. Only npm forks on it today (default query + row
    // install kind); a value outside the kind vocabulary is dropped, never forwarded.
    const kind: HarnessKind | undefined = ['skill', 'mcp', 'extension'].includes(query.kind ?? '')
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
    if (body.kind !== 'skill' && body.kind !== 'mcp' && body.kind !== 'extension') {
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
    // this gateway declares, or it is dropped rather than recorded.
    const listedOn = Array.isArray(body.listedOn)
      ? body.listedOn.filter((id): id is string => typeof id === 'string' && SOURCES.some((s) => s.id === id))
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
