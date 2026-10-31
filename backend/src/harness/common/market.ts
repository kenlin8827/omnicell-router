import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { createBackup, safeWriteJson } from '../../cli/clients/base.js';
import { githubHeaders } from './github.js';
import type { CatalogRow, CatalogSection } from '../plugin/types.js';
import { skillDirs } from '../tree.js';
import type { TreeEntry } from '../tree.js';
import type { HarnessHostId, HarnessSourceView } from '../types.js';
import { fetchWithRetry, type FailureReason } from '../net.js';

/**
 * The shared market core (ADR-0015 §D6/§D9/§D10): the row contract every market answers in, the
 * browse cache and dispatcher, and the operator-added git-source store with its probe.
 *
 * Harness-specific behavior does NOT live here. Each harness file (`plugin/pi-dev.ts`, `plugin/claude.ts`,
 * `skill/clawhub.ts`, …) declares its own source view and browse function; this module only owns what
 * every market shares. A source whose upstream cannot be read answers `unavailable` with the measured
 * reason rather than rendering an empty market that looks broken.
 */

// ---------------------------------------------------------------------------
// Row contract
// ---------------------------------------------------------------------------

export interface MarketItem {
  /** Stable across sources: `<sourceId>:<repo or package>`. */
  id: string;
  sourceId: string;
  /**
   * The catalog or showcase collection this item belongs to.
   * Defaults to 'default' when unspecified.
   */
  catalog?: string;
  /**
   * Channel alias for `sourceId` ('pi-dev', 'clawhub', etc.).
   */
  channel?: string;
  /**
   * Multi-dimensional category tags (e.g. ['plugin', 'devops'] or ['skill']).
   */
  categories?: string[];
  /**
   * Portable install handle — what the install endpoint takes as `key`
   * (`github:<owner/repo>` / `npm:<name>`). `id` carries the same value; `key` names its role.
   */
  key: string;
  /**
   * Which writer serves this row: a skill copy tree, an plugin package, or an MCP server merged
   * into a host's own config. It is the WRITER's kind, not the page's — an npm package reached from
   * the skills page is an plugin (ADR-0015 §8).
   */
  installKind: 'skill' | 'mcp' | 'plugin';
  /** Display name — the repo name, or the skill directory when a repo holds several. */
  name: string;
  /** `owner/repo` when the row has a GitHub project; absent for sources whose identity is only a
   *  package name. */
  repo?: string;
  description: string | null;
  url: string;
  /**
   * GitHub stars, or `null` when this source publishes no popularity signal at all.
   *
   * `null` is NOT `0`: a catalog that never states a star count (npm, the Pi catalog, the community
   * registries) must not claim "nobody starred this". The console renders the two differently, and a
   * row may still ACQUIRE a number later — `common/stars.ts` resolves stars on demand for the
   * repositories a page references, one batched GitHub search per page.
   */
  stars: number | null;
  /**
   * The SOURCE'S OWN popularity counters, when the source has a popularity system of its own that is
   * NOT GitHub stars — today only ClawHub (its own star unit, plus downloads/installs).
   *
   * Kept in a separate field, never folded into `stars`: the star column means "GitHub stars", and
   * printing a registry rating under it would relabel one number as another (ADR-0015 §D6).
   */
  registryStats?: {
    stars: number | null;
    downloads: number | null;
    installs: number | null;
  };
  updatedAt: string;
  topics: string[];
}

export type BrowseResult =
  | {
      ok: true;
      items: MarketItem[];
      /** True when the source has another page for this query — the console's "next" affordance. */
      hasMore: boolean;
      /** Rows the source reports for this query, when it reports one. Absent = unknown, and the
       *  console then shows the page number without inventing a total. */
      total?: number;
      /**
       * What `total` COUNTS. Absent means "the catalog, as far as the source can see it". `window`
       * says the number is only the reachable slice — a windowed search caps every answer, so the
       * console must not print it as the population. The pager still needs it to draw the page buttons.
       */
      totalScope?: 'catalog' | 'window';
      /** English copy, kept as the fallback the console shows when it has no string for `noteCode`. */
      note?: string;
      /** Opaque identity for `note` — the console maps it to its own translation table and fills
       *  `noteParams` into that string. Same rule as the ratelimit ledger's `note`/`noteCode`: the
       *  backend states the fact, the console owns the words. */
      noteCode?: HarnessNoteCode;
      noteParams?: Record<string, string>;
    }
  | {
      ok: false;
      code: 'unsupported_source' | 'unavailable' | 'upstream';
      /** Why the read failed, in vocabulary the console translates (`harness.browseError.*`).
       *  `message` stays as the English fallback: an unmapped reason never shows a bare key. */
      reason?: FailureReason;
      reasonParams?: Record<string, string>;
      message: string;
    };

/** The sentences a browse adapter attaches to an answer (`noteCode`). */
export type HarnessNoteCode =
  /** pi-dev — the catalog's own install command. */
  | 'pi-dev'
  /** clawhub — the catalog endpoint's own ranking, cursor-paged and count-less. */
  | 'clawhub-catalog'
  /** clawhub — a full-catalog search: `{n}` is the limit one request carries (the endpoint has no
   *  paging parameter), so the answer is a window. */
  | 'clawhub-search';

/** Views registered by their own module. `browseSource` prefers the view the caller passed, but a
 *  caller holding a hand-built view (tests, a future adapter) still gets its source's adapter. */
const browseViews = new Map<string, HarnessSourceView>();

export function registerBrowseView(view: HarnessSourceView): void {
  browseViews.set(view.id, view);
}

export function getBrowseView(id: string): HarnessSourceView | undefined {
  return browseViews.get(id);
}

// ---------------------------------------------------------------------------
// Browse cache + dispatch
// ---------------------------------------------------------------------------

/** The shared 60 s read-through window: a quota shield for anonymous upstreams, never a
 *  correctness contract. Keys are prefixed `<sourceId>|` so one source's family can be dropped
 *  without touching another's. */
export const CACHE_TTL_MS = 60_000;

export const cache = new Map<
  string,
  {
    at: number;
    items: MarketItem[];
    hasMore?: boolean;
    total?: number;
    catalogSize?: number;
    rows?: number;
  }
>();

/** Drop ONE source's entries from the shared window (key prefix `<sourceId>|`). */
export function clearPrefix(prefix: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

/**
 * Per-source private caches (a cursor chain, a page-number map) register here so the generic
 * refresh/reset verbs reach them without this module importing any harness file.
 */
const evictors = new Map<string, () => void>();

export function registerBrowseCache(sourceId: string, evict: () => void): void {
  evictors.set(sourceId, evict);
}

/** Drop the whole browse cache (tests, and any caller that cannot name one source): the TTL is a
 *  rate-limit shield, not a correctness contract. */
export function resetBrowseCache(): void {
  cache.clear();
  for (const evict of evictors.values()) evict();
}

/**
 * Drop ONE source's cached pages, so the next read asks upstream again.
 *
 * Only an explicit operator refresh reaches here (`browseSource(..., { refresh: true })`): the 60 s
 * window exists to shield the anonymous quota, and a forced re-read is the one caller that means
 * "that window is stale, ask now". It is narrowed to one source on purpose — refreshing ClawHub must
 * not discard the pi.dev window another tab just warmed.
 */
export function evictBrowseCache(sourceId: string): void {
  clearPrefix(`${sourceId}|`);
  evictors.get(sourceId)?.();
}

/** One browse request, dispatched by the source's OWN browse function. The source's declared sorts
 *  are the only orders that travel upstream — the facade never invents an ordering. */
export async function browseSource(
  source: HarnessSourceView,
  query: string,
  limit: number,
  opts: { harness?: string; page?: number; sort?: string; refresh?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<BrowseResult> {
  const page = Math.max(opts.page ?? 1, 1);
  const sort = opts.sort && source.sorts?.includes(opts.sort) ? opts.sort : source.sorts?.[0];
  if (!source.enabled) {
    return {
      ok: false,
      code: 'unavailable',
      reason: 'unavailable',
      message: source.unavailableReason ?? `${source.label} is unavailable`,
    };
  }
  const adapter = source.browse ?? browseViews.get(source.id)?.browse;
  if (!adapter) {
    return { ok: false, code: 'unsupported_source', reason: 'unsupportedSource', message: `no browse adapter for '${source.id}' yet` };
  }
  // A forced re-read drops this source's window BEFORE the adapter computes its cache key, so the
  // adapter's own read-through starts from an empty family and genuinely asks upstream.
  if (opts.refresh) evictBrowseCache(source.id);
  return adapter(query, limit, page, sort, opts.fetchImpl);
}

// ---------------------------------------------------------------------------
// Operator-added git sources: config + snapshots
// ---------------------------------------------------------------------------

/**
 * Operator-added git marketplace sources (ADR-0015 §D6 "git-repo source type").
 *
 * A marketplace is ANY git repository the operator points at — a Claude-style
 * `.claude-plugin/marketplace.json` catalog (the format grok / Copilot CLI / Goose clone), or a
 * bare skills repository. The probe finds ONE canonical layer regardless of layout:
 *
 *   1. a pinned extension layer (`pi-extension`, `.claude-plugin`, …) when the operator named one;
 *   2. a manifest-declared source directory wins (the author's intent, `plugins[].source`);
 *   3. no manifest → the whole tree is scanned for `SKILL.md` directories.
 *
 * Per-harness adapter litter (`.codex-plugin/`, `.openclaw/skills/`, hooks, commands, rules) is
 * layout noise: it never becomes a row and never enters an install payload. Dedup matters —
 * generated copies (e.g. an `.openclaw/skills/` mirror of the canonical `skills/`) would surface
 * the same skill twice, so a bare-tree scan keeps the SHORTEST path per normalized name and the
 * manifest path wins by construction (it narrows the scan scope).
 *
 * Persistence is harness-domain state, owned here like the manifest and the applies ledger:
 *   - config   `<ocrHome>/harness/marketplaces.json`         — the operator's source list
 *   - snapshots `<ocrHome>/harness/marketplaces/<slug>.json`  — latest probe + bounded history
 *
 * A rescan (opt-in, per source) re-probes and diffs against the last snapshot: it REPORTS
 * additions/removals/pin movement, it never rewrites installed copies — an upgrade still goes
 * through the install route and its gates.
 */

/**
 * Normalize an operator-supplied extension directory. `null` means "scan the whole repository";
 * an object means the value was refused and names why. The grammar is deliberately narrow: the
 * value is joined into a raw.githubusercontent URL, so absolute paths, drive letters, backslashes
 * and `..` segments are refused rather than rewritten.
 */
export function normalizeExtensionDir(raw: unknown): string | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { error: 'extensionDir must be a string' };
  let value = raw.trim().replace(/\\/g, '/');
  if (!value) return null;
  value = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!value) return null;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return { error: `extensionDir '${raw}' must be repository-relative` };
  }
  if (!/^[\w./-]+$/.test(value) || value.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return { error: `invalid extensionDir '${raw}'` };
  }
  return value;
}

/**
 * Operator input for a GitHub repository, normalized to `owner/repo`.
 *
 * The console's add-source box takes whatever the operator pasted: a full URL, a `github.com/...`
 * reference, a `git@github.com:owner/repo.git` clone line, npm-style `github:owner/repo`, or the
 * bare `owner/repo` pair. ONE parser decides all of it, so the skill axis and every plugin adapter
 * accept exactly the same spellings instead of drifting apart. Deep links (a path below the repo)
 * stay refused: that path is what `extensionDir` names, and silently dropping it would register a
 * different layer than the one the operator pointed at.
 */
const GITHUB_REPO_INPUT =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com[/:]|git@github\.com:|github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[?#].*)?$/i;

export function githubRepoFromInput(value: string): string | null {
  const match = GITHUB_REPO_INPUT.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** A slug fragment for one extension directory (`pi-extension`, `claude-plugin`) — used only when
 *  the repo basename is already taken by another layer of the same repository. */
function extensionDirToken(dir: string): string {
  return dir
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'layer';
}

/** Config file for the operator's source list. */
function marketplacesConfigPath(): string {
  return path.join(getOcrHomeDir(), 'harness', 'marketplaces.json');
}

export function snapshotPath(slug: string, harness?: HarnessHostId | string | null): string {
  if (harness) {
    const harnessDir = path.join(getOcrHomeDir(), 'harness', 'marketplaces', harness);
    const target = path.join(harnessDir, `${slug}.json`);
    const fallback = path.join(getOcrHomeDir(), 'harness', 'marketplaces', `${slug}.json`);
    if (fs.existsSync(target) || !fs.existsSync(fallback)) {
      return target;
    }
  }
  const globalPath = path.join(getOcrHomeDir(), 'harness', 'marketplaces', `${slug}.json`);
  if (!fs.existsSync(globalPath)) {
    try {
      const parent = path.join(getOcrHomeDir(), 'harness', 'marketplaces');
      if (fs.existsSync(parent)) {
        for (const sub of fs.readdirSync(parent)) {
          const subFile = path.join(parent, sub, `${slug}.json`);
          if (fs.existsSync(subFile) && fs.statSync(subFile).isFile()) {
            return subFile;
          }
        }
      }
    } catch {}
  }
  return globalPath;
}

export interface MarketplaceEntry {
  /** Showcase catalog grouping ('default', 'enterprise', etc.). */
  catalog?: string;
  /** URL-safe id token: `mp-<slug>` is the sourceId everywhere else. */
  slug: string;
  /**
   * GitHub: `owner/repo`. NPM: the package name, or `@scope/*` for a whole scope as one source.
   */
  repo: string;
  /**
   * Source type (ADR-0015 §D9 amendment): `github` is the default. An `npm` source is a package
   * (or a scope prefix) whose rows install through the npm resolver.
   */
  type?: 'github' | 'npm';
  enabled: boolean;
  addedAt: number;
  rescan: {
    /** Off by default: a rescan is a network caller the operator arms deliberately. */
    enabled: boolean;
    intervalMs: number;
  };
  /**
   * Legacy per-harness pin: the harness whose add form registered this source. Support is now
   * DETECTED from the repository's own form directories (`snapshot.hosts`), so this only
   * disambiguates a manually pinned `extensionDir` and pre-detection snapshots.
   */
  harness?: HarnessHostId | null;
  /**
   * Repo-relative directory the harness's form lives in (`pi-extension`, `.claude-plugin`, …).
   * `null`/absent = detect every served harness's form. When set, the probe never looks outside it.
   */
  extensionDir?: string | null;
}

export interface MarketplaceRow {
  /** Skill directory, repo-relative (`skills/ponytail`). The `#detail` half of an install key. */
  dir: string;
  /** Normalized skill name (writer-facing). */
  name: string;
  /** Frontmatter `name` when stated, else the directory basename. */
  title: string;
  /** Frontmatter `description`, folded to one line; `null` when the author wrote none. */
  description: string | null;
}

/** One installable plugin declared by the repo's marketplace manifest (`plugins[]`).
 *  Only RELATIVE in-repo sources become rows; external sources are counted as an unsupported
 *  shape instead — never guessed at (§D6). */
export interface MarketplacePluginRow {
  /** Manifest-declared plugin name. */
  name: string;
  /** In-repo source path, repo-relative, no leading `./`. */
  source: string;
  /** Manifest `description`, `null` when the author wrote none. */
  description: string | null;
}

export interface MarketplaceDiff {
  probedAt: number;
  shaChanged: boolean;
  added: string[];
  removed: string[];
}

export interface MarketplaceSnapshot {
  slug: string;
  probedAt: number;
  /** HEAD commit at probe time — the pin the next install resolves against. */
  sha: string;
  stars: number | null;
  pushedAt: string | null;
  /** The recognized manifest, when the repo carries one. */
  manifest: { name: string | null; description: string | null; path: string } | null;
  /** The scan root this probe was pinned to, or `null` for a whole-repository scan. */
  extensionDir: string | null;
  /** Installable plugins declared by the manifest (`plugins[]`, relative in-repo sources). */
  plugins: MarketplacePluginRow[];
  /**
   * Harnesses this repository's own forms declare support for — detected from the tree
   * (`<harness extensionDir>/` presence, or a root manifest). This is what the harvest and the
   * console read; nothing is guessed from the harness that happened to run the probe.
   */
  hosts: HarnessHostId[];
  /**
   * The marketplace name the converged manifest declares (`postman`,
   * `claude-plugins-official`); `null` when the repository ships no readable manifest.
   */
  marketplace: string | null;
  /** Per-harness adapter directories DETECTED but not installed (informational, never rows). */
  authorAdapters: string[];
  /** Content shapes seen that this source type does not install, with their file counts. */
  unsupported: { shape: string; count: number }[];
  rows: MarketplaceRow[];
  /** Result of the most recent rescan diff, when one ran. */
  lastDiff?: MarketplaceDiff;
}

/** History cap: enough to see a source's drift, small enough to never matter on disk. */
const SNAPSHOT_HISTORY_MAX = 20;
/** Row cap per source — a directory listing, not a crawler. */
const ROWS_MAX = 30;
/** Slug grammar: `mp-<slug>` must satisfy the install key's sourceId grammar (`^[a-z][/w-]*$`). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_RESCAN_INTERVAL_MS = 86_400_000;
/** Adapter directories that mean "the author shipped a per-harness form" (detection only). */
const ADAPTER_DIR_HINTS: { prefix: string; label: string }[] = [
  { prefix: '.claude-plugin/', label: 'claude' },
  { prefix: '.grok-plugin/', label: 'grok' },
  { prefix: '.codex-plugin/', label: 'codex' },
  { prefix: '.kimi-plugin/', label: 'kimi' },
  { prefix: '.qoder-plugin/', label: 'qoder' },
  { prefix: '.devin-plugin/', label: 'devin' },
  { prefix: '.antigravity-plugin/', label: 'antigravity' },
  { prefix: '.factory-plugin/', label: 'factory' },
  { prefix: '.github/plugin/', label: 'github-copilot' },
  { prefix: '.agents/plugins/', label: 'goose' },
  { prefix: '.opencode/', label: 'opencode' },
  { prefix: '.cursor/', label: 'cursor' },
  { prefix: '.cursor-plugin/', label: 'cursor' },
  { prefix: '.clinerules/', label: 'cline' },
  { prefix: '.openclaw/', label: 'openclaw' },
  { prefix: 'pi-extension/', label: 'pi' },
  { prefix: 'gemini-extension.json', label: 'gemini-cli' },
  { prefix: 'hooks/', label: 'hooks' },
  { prefix: 'commands/', label: 'commands' },
];

export type ProbeOutcome =
  | { ok: true; snapshot: MarketplaceSnapshot }
  | { ok: false; code: 'bad_request' | 'missing_dir' | 'unavailable'; message: string };

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

/** Read entries tolerantly: unknown fields are preserved, malformed extension scopes are dropped
 *  (a source registered before scoping existed keeps its whole-repository scan). */
function readConfigFile(): { marketplaces: MarketplaceEntry[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(marketplacesConfigPath(), 'utf8')) as {
      marketplaces?: MarketplaceEntry[];
    };
    if (!Array.isArray(parsed.marketplaces)) return { marketplaces: [] };
    return {
      marketplaces: parsed.marketplaces
        .filter((e) => e && typeof e.slug === 'string' && typeof e.repo === 'string')
        .map((e) => {
          const scoped = normalizeExtensionDir(e.extensionDir);
          return {
            ...e,
            ...(e.type === 'npm' ? { type: 'npm' as const } : { type: 'github' as const }),
            extensionDir: typeof scoped === 'string' ? scoped : null,
            ...(typeof e.harness === 'string' ? { harness: e.harness } : {}),
          };
        }),
    };
  } catch {
    return { marketplaces: [] };
  }
}

function writeConfigFile(entries: MarketplaceEntry[]): void {
  const file = marketplacesConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) createBackup(file);
  safeWriteJson(file, { marketplaces: entries });
}

export function listMarketplaceEntries(harness?: HarnessHostId | string | null): MarketplaceEntry[] {
  const all = readConfigFile().marketplaces;
  if (!harness) return all;
  return all.filter((e) => !e.harness || e.harness === harness);
}

export function getMarketplaceEntry(slug: string, harness?: HarnessHostId | string | null): MarketplaceEntry | undefined {
  const entries = readConfigFile().marketplaces;
  if (harness) {
    return entries.find((e) => e.slug === slug && (!e.harness || e.harness === harness));
  }
  return entries.find((e) => e.slug === slug);
}

/** The sourceId grammar name for a slug (`mp-<slug>`). */
export function marketplaceSourceId(slug: string): string {
  return `mp-${slug}`;
}

export function validateSlug(slug: string, harness?: HarnessHostId | string | null): string | null {
  if (!SLUG_RE.test(slug)) return `invalid slug '${slug}' (expected ${SLUG_RE})`;
  if (listMarketplaceEntries(harness).some((e) => e.slug === slug)) return `slug '${slug}' is already configured`;
  return null;
}

/**
 * Pick the slug for a (repo, extension directory) pair. The repo basename is the slug; when that
 * basename already names ANOTHER layer of the same repository, the layer joins the slug
 * (`ponytail-pi-extension`), so one repo can ship a pi form and a claude form as two sources.
 * Re-registering the same (repo, directory) pair is a conflict, never a silent second entry.
 */
export function resolveSlug(
  repo: string,
  extensionDir: string | null | undefined,
  harness?: HarnessHostId | string | null,
): { ok: true; slug: string } | { ok: false; message: string } {
  const base =
    repo
      .replace(/\/\*$/, '')
      .split('/')
      .pop()
      ?.toLowerCase()
      .replace(/^@/, '')
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'source';
  const entries = listMarketplaceEntries(harness);
  const dir = extensionDir ?? null;
  const exact = entries.find((e) => e.repo === repo && (e.extensionDir ?? null) === dir);
  if (exact) return { ok: false, message: `'${repo}'${dir ? ` (${dir})` : ''} is already configured as '${exact.slug}'` };
  const allEntries = listMarketplaceEntries();
  const repoLayerTaken = allEntries.some((e) => e.repo === repo && (e.extensionDir ?? null) !== dir);
  const taken = new Set(allEntries.map((e) => e.slug));
  if (!taken.has(base) && !repoLayerTaken) return { ok: true, slug: base };
  // Another layer of the same repo: the extension directory disambiguates. A different repository
  // that happens to share a basename keeps the historical conflict (never silently aliased).
  if (!dir) return { ok: false, message: `slug '${base}' is already configured` };
  const token = extensionDirToken(dir);
  let candidate = `${base}-${token}`.slice(0, 40).replace(/-+$/g, '');
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${token}-${i}`.slice(0, 40).replace(/-+$/g, '');
  if (!SLUG_RE.test(candidate)) return { ok: false, message: `cannot derive a slug for '${repo}' (${dir})` };
  return { ok: true, slug: candidate };
}

export function addMarketplaceEntry(input: {
  slug: string;
  repo: string;
  type?: 'github' | 'npm';
  catalog?: string;
  rescan?: { enabled?: boolean; intervalMs?: number };
  harness?: HarnessHostId | null;
  extensionDir?: string | null;
}): MarketplaceEntry {
  const scoped = normalizeExtensionDir(input.extensionDir);
  const entry: MarketplaceEntry = {
    slug: input.slug,
    catalog: input.catalog?.trim() || 'default',
    repo: input.repo,
    type: input.type === 'npm' ? 'npm' : 'github',
    enabled: true,
    addedAt: Date.now(),
    rescan: {
      enabled: input.rescan?.enabled === true,
      intervalMs: clampInterval(input.rescan?.intervalMs),
    },
    ...(input.harness ? { harness: input.harness } : {}),
    extensionDir: typeof scoped === 'string' ? scoped : null,
  };
  const entries = readConfigFile().marketplaces;
  // Conflict check scoped by harness
  const conflict = entries.some(
    (e) => e.slug === input.slug && ((!input.harness && !e.harness) || (input.harness && e.harness === input.harness)),
  );
  if (conflict) {
    throw new Error(`slug '${input.slug}' is already configured${input.harness ? ` for ${input.harness}` : ''}`);
  }
  entries.push(entry);
  writeConfigFile(entries);
  return entry;
}

export function updateMarketplaceEntry(
  slug: string,
  patch: { enabled?: boolean; catalog?: string; rescan?: { enabled?: boolean; intervalMs?: number } },
  harness?: HarnessHostId | string | null,
): MarketplaceEntry | null {
  const entries = readConfigFile().marketplaces;
  const entry = entries.find((e) => e.slug === slug && (!harness || !e.harness || e.harness === harness));
  if (!entry) return null;
  if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled;
  if (typeof patch.catalog === 'string') entry.catalog = patch.catalog.trim() || 'default';
  if (patch.rescan) {
    if (typeof patch.rescan.enabled === 'boolean') entry.rescan.enabled = patch.rescan.enabled;
    if (patch.rescan.intervalMs !== undefined) entry.rescan.intervalMs = clampInterval(patch.rescan.intervalMs);
  }
  writeConfigFile(entries);
  return entry;
}

/** Removing a source is config-level only: installed copies keep their manifest records and are
 *  uninstalled through the normal removal route — the ledger carries the provenance. */
export function removeMarketplaceEntry(slug: string, harness?: HarnessHostId | string | null): boolean {
  const entries = readConfigFile().marketplaces;
  const next = entries.filter((e) => !(e.slug === slug && (!harness || !e.harness || e.harness === harness)));
  if (next.length === entries.length) return false;
  writeConfigFile(next);
  try {
    fs.rmSync(snapshotPath(slug, harness), { force: true });
  } catch {
    // snapshot cleanup is best-effort; the config removal already committed
  }
  return true;
}

function clampInterval(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_RESCAN_INTERVAL_MS;
  return Math.min(Math.max(Math.round(ms), 60_000), 30 * 86_400_000);
}

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

export function latestSnapshot(slug: string, harness?: HarnessHostId | string | null): MarketplaceSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath(slug, harness), 'utf8')) as {
      latest?: MarketplaceSnapshot;
    };
    return parsed.latest ?? null;
  } catch {
    return null;
  }
}

export function snapshotHistory(slug: string, harness?: HarnessHostId | string | null): MarketplaceSnapshot[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath(slug, harness), 'utf8')) as {
      history?: MarketplaceSnapshot[];
    };
    return Array.isArray(parsed.history) ? parsed.history : [];
  } catch {
    return [];
  }
}

function writeSnapshot(snapshot: MarketplaceSnapshot, harness?: HarnessHostId | string | null): void {
  const file = snapshotPath(snapshot.slug, harness);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const history = [snapshot, ...snapshotHistory(snapshot.slug, harness)]
    // The history dedupes on (sha, rows) — a rescan that saw no change replaces the head instead
    // of appending a twin.
    .filter((s, i, all) => i === 0 || all.findIndex((p) => p.sha === s.sha && rowsFingerprint(s.rows) === rowsFingerprint(p.rows)) === i)
    .slice(0, SNAPSHOT_HISTORY_MAX);
  if (fs.existsSync(file)) createBackup(file);
  safeWriteJson(file, { latest: snapshot, history });
}

function rowsFingerprint(rows: MarketplaceRow[]): string {
  return rows.map((r) => `${r.dir}:${r.name}`).sort().join('|');
}
/**
 * Persist an npm source's packages in the SAME snapshot store the git sources use, so browse and
 * harvest answer from local bytes either way. An npm source has no commit pin, no star count and no
 * repository tree: `sha` stays empty and the packages ARE the plugin rows.
 */
export function writeNpmSourceSnapshot(
  slug: string,
  packages: { name: string; description: string | null }[],
  harness?: HarnessHostId | string | null,
): MarketplaceSnapshot {
  const snapshot: MarketplaceSnapshot = {
    slug,
    probedAt: Date.now(),
    sha: '',
    stars: null,
    pushedAt: null,
    manifest: null,
    extensionDir: null,
    plugins: packages.map((pkg) => ({ name: pkg.name, source: '', description: pkg.description })),
    // An npm package serves every runtime that has a package-manager landing — no detection is
    // possible (and none is claimed): the rows carry no host restriction.
    hosts: [],
    marketplace: null,
    authorAdapters: [],
    unsupported: [],
    rows: [],
  };
  writeSnapshot(snapshot, harness);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface RepoMeta {
  default_branch: string;
  stargazers_count: number;
  pushed_at: string;
}

/** The probe's raw GitHub reads share the market retry policy (one helper, §D6): a repository
 *  tree plus one `SKILL.md` per directory is a long walk, so a stalled socket must fail the read
 *  inside the documented budget instead of hanging the request. */
async function ghJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchWithRetry(url, { headers: githubHeaders() }, undefined, { fetchImpl });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function ghText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchWithRetry(url, { headers: githubHeaders() }, undefined, { fetchImpl });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Minimal SKILL.md frontmatter reader: `name` plus a `description` folded to one line. */
export function readFrontmatter(text: string): { name: string | null; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { name: null, description: null };
  const body = match[1];
  let name: string | null = null;
  let description: string | null = null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = /^name:\s*(.+?)\s*$/.exec(lines[i]);
    if (nameMatch) {
      name = nameMatch[1].replace(/^["']|["']$/g, '');
      continue;
    }
    const descMatch = /^description:\s*(>[-+]?\s*|\|[-+]?\s*|(.+?)\s*)$/.exec(lines[i]);
    if (descMatch) {
      const inline = descMatch[2];
      const parts: string[] = [];
      if (inline) parts.push(inline);
      // Folded/literal block scalars: continuation lines are indented deeper than the key.
      for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || lines[j] === ''); j++) {
        if (lines[j].trim()) parts.push(lines[j].trim());
        i = j;
      }
      description = parts.join(' ').trim() || null;
    }
  }
  return { name, description };
}


/** The RESULT of parsing one marketplace catalog — a discriminated result, so "not a manifest"
 *  (`{ ok: false }`) is never confused with "a manifest that declares nothing". */
export type ParsedManifest =
  | {
      ok: true;
      dirs: string[];
      plugins: MarketplacePluginRow[];
      name: string | null;
      description: string | null;
    }
  | { ok: false };

/**
 * A Claude-format marketplace reader (`marketplace.json` + `plugins[].source`). Supplied ONLY by
 * `plugin/claude.ts`: the base engine and this core never know the format.
 */
export interface CatalogReader {
  /** Manifest paths to try, in order. `layer` is the operator-pinned extension directory. */
  paths(layer: string | null): string[];
  parse(text: string): ParsedManifest;
}

/** One harness's published repository form, as the probe detects support for the repository. */
export interface HostProbe {
  harness: HarnessHostId;
  /** The harness's form directory, or `null` for a host whose form is a root manifest. */
  dir: string | null;
  /** That harness's own reading hooks (catalog / owned manifest / directory-keyed). */
  options: ProbeOptions;
}

/**
 * Per-probe format hooks — the only places a source format enters the shared probe.
 * A harness with neither hook answers from a bare `SKILL.md` scan.
 */
export interface ProbeOptions {
  /** Claude's converged `marketplace.json` catalog reader (the format owner lives in
   *  `plugin/claude.ts`; clones reuse the same parser). */
  catalog?: CatalogReader;
  /** `false` = a dry run: no snapshot is written (the console's check-source). */
  persist?: boolean;
  /** A single-plugin manifest this harness OWNS (codex/claude `plugin.json`, gemini
   *  `gemini-extension.json`, pi's `package.json`). The keys are that vendor's, never a shared
   *  schema. */
  manifest?: PluginManifestReader;
  /** For harnesses whose form is a directory but whose manifest file is not standardized: the
   *  directory's EXISTENCE is the plugin, and its name is the repository. No JSON is guessed. */
  directoryPlugin?: { base: 'layer' | 'repo' };
  /** The harness's published form directory, applied when the entry pins none. A missing default
   *  degrades to the bare `SKILL.md` scan; only an EXPLICIT pin is strict about existence. */
  defaultExtensionDir?: string;
  /**
   * EVERY served harness's form. When supplied, one probe answers which harnesses support the
   * repository (`snapshot.hosts`) instead of trusting the harness that happened to run it. The
   * first detected form that yields rows supplies them.
   */
  hosts?: HostProbe[];
  /**
   * The converged catalog reader used ONLY to read the marketplace/plugin NAMES an install
   * command needs (`<plugin>@<marketplace>`). Directory-keyed harnesses keep their own row shape;
   * this never turns their vendor JSON into rows.
   */
  nameReader?: CatalogReader;
  /**
   * Force the whole-repository `SKILL.md` scan, ignoring a detected form's declared scope. The
   * skill axis owns this: a skill source is a repository that publishes `SKILL.md` anywhere, so a
   * converged catalog's `plugins[].source` paths must not hide a top-level `skills/` tree.
   */
  wholeTreeSkills?: boolean;
}

/**
 * Reads ONE plugin manifest into one row. `atRoot` manifests live at the repository root
 * (`gemini-extension.json`); otherwise the file is resolved inside the pinned layer
 * (`.codex-plugin/plugin.json`, `pi-extension/package.json`). `base` decides where the row's
 * install source points: the layer itself, or the repository root the manifest describes.
 */
export interface PluginManifestReader {
  file: string;
  atRoot?: boolean;
  base: 'layer' | 'repo';
  /** Repo-relative skill directories the manifest declares; `null` = no narrowing. */
  scope?: (manifest: Record<string, unknown>) => string[] | null;
  read: (manifest: Record<string, unknown>) => { name: string; description: string | null } | null;
}

/** Normalize one probe result into rows: scan scope → SKILL.md dirs → frontmatter titles. */
export async function rowsForScope(
  repo: string,
  sha: string,
  scopeDirs: string[] | null,
  tree: TreeEntry[],
  fetchImpl: typeof fetch,
): Promise<MarketplaceRow[]> {
  const dirs = skillDirs(tree)
    .filter((d) => (scopeDirs ? scopeDirs.some((scope) => (scope === '' ? true : d === scope || d.startsWith(`${scope}/`))) : true))
    // Shortest path first: the dedupe below keeps the canonical copy over generated mirrors.
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const rows: MarketplaceRow[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (rows.length >= ROWS_MAX) break;
    const base = dir.split('/').pop() ?? dir;
    if (seen.has(base)) continue;
    const url = `https://raw.githubusercontent.com/${repo}/${sha}/${dir}/SKILL.md`;
    const text = await ghText(url, fetchImpl);
    const frontmatter = text ? readFrontmatter(text) : { name: null, description: null };
    seen.add(base);
    rows.push({
      dir,
      name: base,
      title: frontmatter.name ?? base,
      description: frontmatter.description,
    });
  }
  return rows;
}

/** One harness's form, as the probe read it. */
interface FormRead {
  harness: HarnessHostId;
  layer: string | null;
  manifest: MarketplaceSnapshot['manifest'];
  plugins: MarketplacePluginRow[];
  /** Catalog-declared scan scope (`null` = no narrowing declared). */
  scopeDirs: string[] | null;
  /** Owned-manifest scan scope (`null` = no narrowing declared). */
  manifestScope: string[] | null;
  /** The form's rows are the repository's own tree, not the layer. */
  repoScoped: boolean;
}

export async function probeMarketplace(
  entry: MarketplaceEntry,
  fetchImpl: typeof fetch = fetch,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  if (!REPO_RE.test(entry.repo)) return { ok: false, code: 'bad_request', message: `invalid repo '${entry.repo}'` };
  const scoped = normalizeExtensionDir(entry.extensionDir);
  if (scoped !== null && typeof scoped !== 'string') return { ok: false, code: 'bad_request', message: scoped.error };
  const explicitDir = scoped;
  const fallback = explicitDir === null && opts.defaultExtensionDir ? normalizeExtensionDir(opts.defaultExtensionDir) : null;
  const defaultDir = typeof fallback === 'string' ? fallback : null;
  const api = `https://api.github.com/repos/${entry.repo}`;
  const meta = await ghJson<RepoMeta>(api, fetchImpl);
  if (!meta) return { ok: false, code: 'unavailable', message: `cannot read https://github.com/${entry.repo}` };
  const head = await ghJson<{ sha: string }>(`${api}/commits/${encodeURIComponent(meta.default_branch)}`, fetchImpl);
  if (!head) return { ok: false, code: 'unavailable', message: 'cannot read HEAD commit' };
  const treeRes = await ghJson<{ tree: TreeEntry[] }>(`${api}/git/trees/${head.sha}?recursive=1`, fetchImpl);
  if (!treeRes || !Array.isArray(treeRes.tree)) return { ok: false, code: 'unavailable', message: 'cannot read the git tree' };
  const tree = treeRes.tree;
  const present = (dir: string) => tree.some((e) => e.path === dir || e.path.startsWith(`${dir}/`));
  const raw = (file: string) => `https://raw.githubusercontent.com/${entry.repo}/${head.sha}/${file}`;

  // A pinned layer must exist: silently scanning the repo root instead would harvest another
  // harness's form and report success over a directory the operator asked for but never got.
  if (explicitDir && !present(explicitDir)) {
    return { ok: false, code: 'missing_dir', message: `'${entry.repo}' has no '${explicitDir}' directory` };
  }

  const probes: HostProbe[] =
    opts.hosts && opts.hosts.length > 0
      ? opts.hosts
      : [
          {
            harness: entry.harness ?? 'claude',
            dir: defaultDir,
            options: opts,
          },
        ];

  // SUPPORT IS DETECTED, not declared: a harness supports the repository when its own form
  // directory exists, or — for a root-manifest host — when that manifest is at the repo root.
  const detected = probes.filter((probe) => {
    if (probe.dir) return present(probe.dir);
    const atRoot = probe.options.manifest?.atRoot;
    return !!atRoot && tree.some((e) => e.path === probe.options.manifest!.file && e.type === 'blob');
  });

  /** Read ONE host's form. The layer is the operator pin, else that host's own published dir. */
  const readForm = async (probe: HostProbe): Promise<FormRead | null> => {
    const hostOpts = probe.options;
    const layer = explicitDir ?? (probe.dir && present(probe.dir) ? probe.dir : null);
    let manifest: MarketplaceSnapshot['manifest'] = null;
    let plugins: MarketplacePluginRow[] = [];
    let scopeDirs: string[] | null = null;
    for (const manifestPath of hostOpts.catalog?.paths(layer) ?? []) {
      if (!tree.some((e) => e.path === manifestPath && e.type === 'blob')) continue;
      const text = await ghText(raw(manifestPath), fetchImpl);
      if (!text) continue;
      const parsed = hostOpts.catalog!.parse(text);
      if (!parsed.ok) continue; // an unparseable file is not a manifest — try the next family member
      manifest = { name: parsed.name, description: parsed.description, path: manifestPath };
      plugins = parsed.plugins.slice(0, ROWS_MAX);
      // `dirs: []` (all sources external) narrows to NOTHING: a whole-tree scan would surface
      // mirror copies the author never meant as installable.
      scopeDirs = parsed.dirs;
      break;
    }

    let manifestScope: string[] | null = null;
    let repoScoped = false;
    const reader = hostOpts.manifest;
    const declaredPath = reader ? (reader.atRoot ? reader.file : layer ? `${layer}/${reader.file}` : null) : null;
    if (!manifest && !plugins.length && declaredPath && tree.some((e) => e.path === declaredPath && e.type === 'blob')) {
      const text = await ghText(raw(declaredPath), fetchImpl);
      let declared: Record<string, unknown> | null = null;
      try {
        declared = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        declared = null; // a broken manifest is not a manifest
      }
      const read = declared ? reader!.read(declared) : null;
      if (read) {
        plugins = [{ name: read.name, source: reader!.base === 'layer' ? (layer ?? '') : '', description: read.description }];
        manifestScope = declared && reader!.scope ? reader!.scope(declared) : null;
        repoScoped = reader!.base === 'repo';
      }
    }
    if (!manifest && !plugins.length && hostOpts.directoryPlugin && layer) {
      plugins = [
        {
          name: entry.repo.split('/').pop() ?? entry.repo,
          source: hostOpts.directoryPlugin.base === 'layer' ? layer : '',
          description: null,
        },
      ];
      repoScoped = hostOpts.directoryPlugin.base === 'repo';
    }
    if (!manifest && plugins.length === 0) return null;
    return { harness: probe.harness, layer, manifest, plugins, scopeDirs, manifestScope, repoScoped };
  };

  // Detected forms first; the registrant/pinned host is the fallback (a skills-only repo has no
  // form at all and is answered by the whole-tree `SKILL.md` scan below).
  const candidates = [...detected, ...probes.filter((probe) => !detected.includes(probe))];
  let form: FormRead | null = null;
  for (const probe of candidates) {
    form = await readForm(probe);
    if (form) break;
  }
  const primaryHarness = form?.harness ?? detected[0]?.harness ?? probes[0]!.harness;

  // Marketplace/plugin NAMES the install command needs (`<plugin>@<marketplace>`). Read from the
  // converged catalog only — a directory-keyed harness keeps its own row shape.
  let marketplaceName = form?.manifest?.name ?? null;
  if (opts.nameReader) {
    for (const probe of detected) {
      if (!probe.dir) continue;
      const namePath = `${probe.dir}/marketplace.json`;
      if (!tree.some((e) => e.path === namePath && e.type === 'blob')) continue;
      const text = await ghText(raw(namePath), fetchImpl);
      const parsed = text ? opts.nameReader.parse(text) : ({ ok: false } as ParsedManifest);
      if (!parsed.ok) continue;
      marketplaceName ??= parsed.name;
      if (form && form.plugins.length > 0 && !form.manifest) {
        const rootPlugin = parsed.plugins.find((p) => p.source === '' || p.source === '.') ?? parsed.plugins[0];
        if (rootPlugin) form.plugins = [{ ...form.plugins[0]!, name: rootPlugin.name }];
      }
      break;
    }
  }

  // An EXPLICIT layer pin keeps the historical per-harness scope (the operator asked for one
  // harness's form); an unpinned source is detected across every served harness.
  const hosts: HarnessHostId[] = explicitDir
    ? [primaryHarness]
    : detected.length > 0
      ? [...new Set(detected.map((probe) => probe.harness))]
      : [primaryHarness];
  const extensionDir = form?.layer ?? explicitDir ?? (defaultDir && present(defaultDir) ? defaultDir : null);

  // A repo-rooted plugin form (codex, cursor, …) does not turn the layer into the scan scope: its
  // rows are the repository's own `skills` tree, while a layer-rooted form scans the layer itself.
  // The skill axis overrides every narrowing: its source is any repository publishing SKILL.md.
  const scope = opts.wholeTreeSkills
    ? null
    : (form?.scopeDirs ?? form?.manifestScope ?? (form?.repoScoped ? null : extensionDir ? [extensionDir] : null));
  const rows = await rowsForScope(entry.repo, head.sha, scope, tree, fetchImpl);
  const previous = latestSnapshot(entry.slug, entry.harness);
  const diff: MarketplaceDiff = {
    probedAt: Date.now(),
    shaChanged: previous ? previous.sha !== head.sha : false,
    added: rows.filter((r) => !previous?.rows.some((p) => p.dir === r.dir)).map((r) => r.title),
    removed: (previous?.rows ?? []).filter((p) => !rows.some((r) => r.dir === p.dir)).map((p) => p.title),
  };

  const authorAdapters = [...new Set(ADAPTER_DIR_HINTS.filter((h) => tree.some((e) => e.path.startsWith(h.prefix))).map((h) => h.label))];
  const unsupported: MarketplaceSnapshot['unsupported'] = [];
  const pushShape = (shape: string, count: number) => {
    if (count > 0) unsupported.push({ shape, count });
  };
  pushShape('commands', tree.filter((e) => e.type === 'blob' && /\/commands\/.+/.test(e.path)).length);
  pushShape('hooks', tree.filter((e) => e.type === 'blob' && e.path.startsWith('hooks/') && /\.(js|mjs|cjs|ps1|sh)$/.test(e.path)).length);
  pushShape('opencode-plugins', tree.filter((e) => e.type === 'blob' && e.path.startsWith('.opencode/plugins/')).length);

  const snapshot: MarketplaceSnapshot = {
    slug: entry.slug,
    probedAt: diff.probedAt,
    sha: head.sha,
    stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : null,
    pushedAt: typeof meta.pushed_at === 'string' ? meta.pushed_at : null,
    manifest: form?.manifest ?? null,
    extensionDir,
    plugins: form?.plugins ?? [],
    hosts,
    marketplace: marketplaceName ?? entry.repo.split('/').pop() ?? entry.repo,
    authorAdapters,
    unsupported,
    rows,
    ...(previous ? { lastDiff: diff } : {}),
  };
  // A dry-run probe (checkSource on a NOT-yet-registered repo) reports without leaving state.
  if (opts.persist !== false) writeSnapshot(snapshot, entry.harness);
  return { ok: true, snapshot };
}

/** Entries whose rescan is armed and due. Called by the scheduler tick in `server.ts`. */
export function dueMarketplaceEntries(now = Date.now()): { entry: MarketplaceEntry; snapshot: MarketplaceSnapshot | null }[] {
  return listMarketplaceEntries()
    .filter((e) => e.enabled && e.rescan.enabled)
    .map((entry) => ({ entry, snapshot: latestSnapshot(entry.slug) }))
    .filter(({ entry, snapshot }) => !snapshot || now - snapshot.probedAt >= entry.rescan.intervalMs);
}

// ---------------------------------------------------------------------------
// Browse integration for operator sources
// ---------------------------------------------------------------------------

export interface MarketplaceBrowseItem {
  dir: string;
  key: string;
  name: string;
  title: string;
  description: string | null;
}

/** Browse rows for one source, from the latest snapshot (a stale snapshot answers; the market is a
 *  cache view, the rescan loop owns freshness). Filter + page are local — the source declares no
 *  server-side order beyond `name`. */
export function browseMarketplace(
  slug: string,
  opts: { query?: string; page?: number; pageSize?: number } = {},
): { ok: true; items: MarketplaceBrowseItem[]; total: number; hasMore: boolean } | { ok: false; code: 'unknown_source' | 'never_probed'; message: string } {
  const entry = getMarketplaceEntry(slug);
  if (!entry) return { ok: false, code: 'unknown_source', message: `unknown marketplace '${slug}'` };
  const snapshot = latestSnapshot(slug);
  if (!snapshot) return { ok: false, code: 'never_probed', message: `source '${slug}' has not been probed yet` };
  const query = (opts.query ?? '').trim().toLowerCase();
  const matched = snapshot.rows
    .filter((r) => !query || r.title.toLowerCase().includes(query) || (r.description ?? '').toLowerCase().includes(query))
    .sort((a, b) => a.title.localeCompare(b.title));
  const pageSize = opts.pageSize ?? 24;
  const page = Math.max(1, opts.page ?? 1);
  const items = matched.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
    dir: r.dir,
    key: `${marketplaceSourceId(slug)}:${entry.repo}#${r.dir}`,
    name: r.name,
    title: r.title,
    description: r.description,
  }));
  return { ok: true, items, total: matched.length, hasMore: page * pageSize < matched.length };
}

// ---------------------------------------------------------------------------
// Federated tier: live directories answered per source section
// ---------------------------------------------------------------------------

/** Per-source latency ceiling — the facade owns the page's worst-case wait. */
const SECTION_TIMEOUT_MS = 8_000;

/**
 * Ask live federated sources for one page and return one labeled section per source. The tier is
 * shared by every market: which views participate is the adapter's declaration
 * (`BasePluginMarketAdapter.federatedViews()`), never a module-level id list.
 *
 * Co-ordering honesty: a merged global sort across heterogeneous sources is only honest when every
 * participant serves the SAME key, which the live directories cannot do; each answer therefore
 * stays in the source's native order with its own total, and the facade never interleaves them.
 * Failures and timeouts degrade to a labeled note, never a throw.
 */
export async function federatedSections(
  harness: HarnessHostId,
  q: string,
  opts: { page: number; pageSize: number },
  fetchImpl: typeof fetch,
  views: HarnessSourceView[],
): Promise<CatalogSection[]> {
  const jobs = views.map(async (view): Promise<CatalogSection> => {
    try {
      const result = await withTimeout(
        browseSource(view, q, opts.pageSize, { harness, page: opts.page, fetchImpl }),
        SECTION_TIMEOUT_MS,
        `${view.label} did not answer within ${SECTION_TIMEOUT_MS / 1000}s`,
      );
      if (!result.ok) return { sourceId: view.id, label: view.label, rows: [], note: result.message };
      return {
        sourceId: view.id,
        label: view.label,
        rows: result.items.filter((i) => i.installKind === 'plugin').map((i) => toCatalogRow(i, view.hosts ?? [])),
        ...(result.total !== undefined ? { total: result.total, totalExact: result.totalScope !== 'window' } : {}),
      };
    } catch (e) {
      return {
        sourceId: view.id,
        label: view.label,
        rows: [],
        note: e instanceof Error ? e.message : `${view.label} failed`,
      };
    }
  });
  return Promise.all(jobs);
}

/** The ONE `MarketItem` → `CatalogRow` conversion shared by the federated tier and a harness's own
 *  live search. `hosts` is the source view's host claim (empty for an unclaimed directory). */
export function toCatalogRow(item: MarketItem, hosts: HarnessHostId[] = []): CatalogRow {
  return {
    // The MarketItem key IS the portable install handle (`npm:<pkg>`); it doubles as the merge key.
    key: item.key,
    name: item.name,
    summary: item.description,
    stars: item.stars,
    updatedAt: item.updatedAt ? Date.parse(item.updatedAt) || null : null,
    sourceId: item.sourceId,
    surfaces: [item.sourceId],
    hosts,
    repo: item.repo ?? null,
    // A live directory row carries no marketplace manifest of its own; it installs via its key.
    marketplace: (item as any).marketplace ?? null,
    catalog: item.catalog ?? 'default',
    channel: item.channel ?? item.sourceId,
    categories: item.categories ?? [],
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
