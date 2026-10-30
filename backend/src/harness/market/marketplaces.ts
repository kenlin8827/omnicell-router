import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { createBackup, safeWriteJson } from '../../cli/clients/base.js';
import { githubHeaders } from './browse.js';
import { skillDirs } from '../tree.js';
import type { TreeEntry } from '../tree.js';

/**
 * Operator-added git marketplace sources (ADR-0015 §D6 "git-repo source type").
 *
 * A marketplace is ANY git repository the operator points at — a Claude-style
 * `.claude-plugin/marketplace.json` catalog (the format grok / Copilot CLI / Goose clone), or a
 * bare skills repository. The probe finds ONE canonical skill layer regardless of layout:
 *
 *   1. a manifest-declared source directory wins (the author's intent, `plugins[].source`);
 *   2. no manifest → the whole tree is scanned for `SKILL.md` directories.
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

/** Config file for the operator's source list. */
function marketplacesConfigPath(): string {
  return path.join(getOcrHomeDir(), 'harness', 'marketplaces.json');
}

function snapshotPath(slug: string): string {
  return path.join(getOcrHomeDir(), 'harness', 'marketplaces', `${slug}.json`);
}

export interface MarketplaceEntry {
  /** URL-safe id token: `mp-<slug>` is the sourceId everywhere else. */
  slug: string;
  /** `owner/repo` — the only repo this source's install keys may resolve against. */
  repo: string;
  enabled: boolean;
  addedAt: number;
  rescan: {
    /** Off by default: a rescan is a network caller the operator arms deliberately. */
    enabled: boolean;
    intervalMs: number;
  };
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
  /** Installable plugins declared by the manifest (`plugins[]`, relative in-repo sources). */
  plugins: MarketplacePluginRow[];
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
/** Marketplace manifests recognized, best first. They share the Claude shape. */
const MANIFEST_PATHS = [
  '.claude-plugin/marketplace.json',
  '.grok-plugin/marketplace.json',
  '.github/plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
];
/** Adapter directories that mean "the author shipped a per-harness form" (detection only). */
const ADAPTER_DIR_HINTS: { prefix: string; label: string }[] = [
  { prefix: '.claude-plugin/', label: 'claude' },
  { prefix: '.grok-plugin/', label: 'grok' },
  { prefix: '.codex-plugin/', label: 'codex' },
  { prefix: '.kimi-plugin/', label: 'kimi' },
  { prefix: '.qoder-plugin/', label: 'qoder' },
  { prefix: '.devin-plugin/', label: 'devin' },
  { prefix: '.github/plugin/', label: 'github-copilot' },
  { prefix: '.agents/plugins/', label: 'goose' },
  { prefix: '.opencode/', label: 'opencode' },
  { prefix: '.cursor/', label: 'cursor' },
  { prefix: '.clinerules/', label: 'cline' },
  { prefix: '.openclaw/', label: 'openclaw' },
  { prefix: 'pi-plugin/', label: 'pi' },
  { prefix: 'hooks/', label: 'hooks' },
  { prefix: 'commands/', label: 'commands' },
];

export type ProbeOutcome =
  | { ok: true; snapshot: MarketplaceSnapshot }
  | { ok: false; code: 'bad_repo' | 'unavailable'; message: string };

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

function readConfigFile(): { marketplaces: MarketplaceEntry[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(marketplacesConfigPath(), 'utf8')) as {
      marketplaces?: MarketplaceEntry[];
    };
    if (!Array.isArray(parsed.marketplaces)) return { marketplaces: [] };
    return { marketplaces: parsed.marketplaces.filter((e) => e && typeof e.slug === 'string' && typeof e.repo === 'string') };
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

export function listMarketplaces(): MarketplaceEntry[] {
  return readConfigFile().marketplaces;
}

export function getMarketplaceEntry(slug: string): MarketplaceEntry | undefined {
  return listMarketplaces().find((e) => e.slug === slug);
}

/** The sourceId grammar name for a slug (`mp-<slug>`). */
export function marketplaceSourceId(slug: string): string {
  return `mp-${slug}`;
}

export function validateSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return `invalid slug '${slug}' (expected ${SLUG_RE})`;
  if (listMarketplaces().some((e) => e.slug === slug)) return `slug '${slug}' is already configured`;
  return null;
}

export function addMarketplaceEntry(input: {
  slug: string;
  repo: string;
  rescan?: { enabled?: boolean; intervalMs?: number };
}): MarketplaceEntry {
  const entry: MarketplaceEntry = {
    slug: input.slug,
    repo: input.repo,
    enabled: true,
    addedAt: Date.now(),
    rescan: {
      enabled: input.rescan?.enabled === true,
      intervalMs: clampInterval(input.rescan?.intervalMs),
    },
  };
  const entries = listMarketplaces();
  entries.push(entry);
  writeConfigFile(entries);
  return entry;
}

export function updateMarketplace(slug: string, patch: { enabled?: boolean; rescan?: { enabled?: boolean; intervalMs?: number } }): MarketplaceEntry | null {
  const entries = listMarketplaces();
  const entry = entries.find((e) => e.slug === slug);
  if (!entry) return null;
  if (typeof patch.enabled === 'boolean') entry.enabled = patch.enabled;
  if (patch.rescan) {
    if (typeof patch.rescan.enabled === 'boolean') entry.rescan.enabled = patch.rescan.enabled;
    if (patch.rescan.intervalMs !== undefined) entry.rescan.intervalMs = clampInterval(patch.rescan.intervalMs);
  }
  writeConfigFile(entries);
  return entry;
}

/** Removing a source is config-level only: installed copies keep their manifest records and are
 *  uninstalled through the normal removal route — the ledger carries the provenance. */
export function removeMarketplace(slug: string): boolean {
  const entries = listMarketplaces();
  const next = entries.filter((e) => e.slug !== slug);
  if (next.length === entries.length) return false;
  writeConfigFile(next);
  try {
    fs.rmSync(snapshotPath(slug), { force: true });
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

export function latestSnapshot(slug: string): MarketplaceSnapshot | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath(slug), 'utf8')) as {
      latest?: MarketplaceSnapshot;
    };
    return parsed.latest ?? null;
  } catch {
    return null;
  }
}

export function snapshotHistory(slug: string): MarketplaceSnapshot[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(snapshotPath(slug), 'utf8')) as {
      history?: MarketplaceSnapshot[];
    };
    return Array.isArray(parsed.history) ? parsed.history : [];
  } catch {
    return [];
  }
}

function writeSnapshot(snapshot: MarketplaceSnapshot): void {
  const file = snapshotPath(snapshot.slug);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const history = [snapshot, ...snapshotHistory(snapshot.slug)]
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

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface RepoMeta {
  default_branch: string;
  stargazers_count: number;
  pushed_at: string;
}

async function ghJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  try {
    const res = await fetchImpl(url, { headers: githubHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function ghText(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: githubHeaders() });
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

/** Author-declared source directories from a Claude-shaped marketplace manifest. `parsed` is false
 *  when the file is not JSON at all — an unparseable manifest is NOT a manifest, and the probe
 *  falls back to a whole-tree scan rather than trusting an empty scope. */
export function manifestSourceDirs(manifestText: string): { parsed: boolean; dirs: string[]; plugins: MarketplacePluginRow[]; name: string | null; description: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    return { parsed: false, dirs: [], plugins: [], name: null, description: null };
  }
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const name = typeof root.name === 'string' ? root.name : null;
  const description = typeof root.description === 'string' ? root.description : null;
  const plugins = Array.isArray(root.plugins) ? root.plugins : [];
  const dirs: string[] = [];
  const pluginRows: MarketplacePluginRow[] = [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue;
    const p = plugin as Record<string, unknown>;
    // Phase 1 serves RELATIVE-PATH sources only: in-repo directories. External sources
    // (`git-subdir`, `url`, `npm`, …) are reported as present but unresolved — never guessed at.
    if (typeof p.source === 'string' && p.source.startsWith('./') && !p.source.includes('..')) {
      const dir = p.source.replace(/^\.\//, '');
      dirs.push(dir);
      if (typeof p.name === 'string' && p.name) {
        pluginRows.push({
          name: p.name,
          source: dir,
          description: typeof p.description === 'string' ? p.description : null,
        });
      }
    }
  }
  return { parsed: true, dirs: [...new Set(dirs)], plugins: pluginRows.slice(0, ROWS_MAX), name, description };
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

export async function probeMarketplace(
  entry: MarketplaceEntry,
  fetchImpl: typeof fetch = fetch,
  opts: { persist?: boolean } = {},
): Promise<ProbeOutcome> {
  if (!REPO_RE.test(entry.repo)) return { ok: false, code: 'bad_repo', message: `invalid repo '${entry.repo}'` };
  const api = `https://api.github.com/repos/${entry.repo}`;
  const meta = await ghJson<RepoMeta>(api, fetchImpl);
  if (!meta) return { ok: false, code: 'unavailable', message: `cannot read https://github.com/${entry.repo}` };
  const head = await ghJson<{ sha: string }>(`${api}/commits/${encodeURIComponent(meta.default_branch)}`, fetchImpl);
  if (!head) return { ok: false, code: 'unavailable', message: 'cannot read HEAD commit' };
  const treeRes = await ghJson<{ tree: TreeEntry[] }>(`${api}/git/trees/${head.sha}?recursive=1`, fetchImpl);
  if (!treeRes || !Array.isArray(treeRes.tree)) return { ok: false, code: 'unavailable', message: 'cannot read the git tree' };
  const tree = treeRes.tree;

  // Manifest detection, best match first.
  let manifest: MarketplaceSnapshot['manifest'] = null;
  let manifestPlugins: MarketplacePluginRow[] = [];
  let scopeDirs: string[] | null = null;
  for (const manifestPath of MANIFEST_PATHS) {
    if (!tree.some((e) => e.path === manifestPath && e.type === 'blob')) continue;
    const text = await ghText(`https://raw.githubusercontent.com/${entry.repo}/${head.sha}/${manifestPath}`, fetchImpl);
    if (!text) continue;
    const { parsed, dirs, plugins, name, description } = manifestSourceDirs(text);
    if (!parsed) continue; // an unparseable file is not a manifest — try the next family member
    manifest = { name, description, path: manifestPath };
    manifestPlugins = plugins;
    // The manifest declares the author's canonical layer. `dirs: []` (a manifest whose sources are
    // all external) deliberately narrows to NOTHING: scanning the whole tree would surface mirror
    // copies and whatever else the author never meant as installable.
    scopeDirs = dirs;
    break;
  }

  const rows = await rowsForScope(entry.repo, head.sha, scopeDirs, tree, fetchImpl);
  const previous = latestSnapshot(entry.slug);
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
  pushShape('external-manifest-sources', scopeDirs === null && manifest ? 0 : 0);

  const snapshot: MarketplaceSnapshot = {
    slug: entry.slug,
    probedAt: diff.probedAt,
    sha: head.sha,
    stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : null,
    pushedAt: typeof meta.pushed_at === 'string' ? meta.pushed_at : null,
    manifest,
    plugins: manifestPlugins,
    authorAdapters,
    unsupported,
    rows,
    ...(previous ? { lastDiff: diff } : {}),
  };
  // A dry-run probe (checkSource on a NOT-yet-registered repo) reports without leaving state.
  if (opts.persist !== false) writeSnapshot(snapshot);
  return { ok: true, snapshot };
}

/** Entries whose rescan is armed and due. Called by the scheduler tick in `server.ts`. */
export function dueMarketplaces(now = Date.now()): { entry: MarketplaceEntry; snapshot: MarketplaceSnapshot | null }[] {
  return listMarketplaces()
    .filter((e) => e.enabled && e.rescan.enabled)
    .map((entry) => ({ entry, snapshot: latestSnapshot(entry.slug) }))
    .filter(({ entry, snapshot }) => !snapshot || now - snapshot.probedAt >= entry.rescan.intervalMs);
}

// ---------------------------------------------------------------------------
// Browse integration
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
