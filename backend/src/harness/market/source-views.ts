import type { HarnessSourceView } from '../types.js';

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
/**
 * The built-in harness source views (moved out of `routes/harness.ts` so the harness domain —
 * including the plugin catalog — can declare capabilities without importing the route layer).
 */
export const SOURCES: HarnessSourceView[] = [
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
    id: 'pi-dev',
    label: 'pi.dev (official)',
    kinds: ['plugin'],
    trust: 'official',
    auth: 'none',
    enabled: true,
    browsable: true,
    // The official Pi package catalog (`pi.dev/packages`): plugins plus untyped Pi packages, every
    // row printed with its own `pi install npm:<pkg>` command. Rows therefore carry an `npm:<pkg>`
    // handle and install through the npm source — one package, ONE identity, and the console's
    // installed-state join stays exact. This source produces no payload of its own (browse-only).
    //
    // First for the plugin axis on purpose: a pi page should open on its own official catalog, not
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
    id: 'npm',
    label: 'npm registry',
    // The PLUGIN axis dropped npm as a browse chip by owner decision: the plugin market is a
    // directory (pi.dev + operator git sources), not a registry-wide search — npm remains the
    // INSTALL resolver for every `npm:<pkg>` handle and the MCP axis' wide net.
    kinds: ['skill', 'mcp'],
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

/** Id-indexed lookup over the built-in views. */
export const SOURCES_VIEW_LOOKUP: Record<string, HarnessSourceView> = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
