import { allHostProbes } from '../plugin/adapters/index.js';
import { harvestIndex } from '../plugin/catalog.js';
import { HOSTS } from '../host/hosts.js';
import {
  addMarketplaceEntry,
  getMarketplaceEntry,
  latestSnapshot,
  listMarketplaceEntries,
  marketplaceSourceId,
  probeMarketplace,
  removeMarketplaceEntry,
  resolveSlug,
  githubRepoFromInput,
  updateMarketplaceEntry,
  type MarketplaceEntry,
} from '../common/market.js';

/**
 * Skill-source maintenance (ADR-0015 §D6/§D11): the GLOBAL half of the operator source store.
 *
 * A skill is not bound to a runtime — one directory is read by many harnesses (and ClawHub answers
 * every harness alike) — so a skill source is registered WITHOUT a harness scope. That is the one
 * structural difference from `plugin/` sources, whose entries are per-harness. The store itself is
 * shared (`marketplaces.json`); what this module owns is the skill-axis semantics:
 *
 * - only GitHub repositories are accepted (npm packages resolve to plugins/MCP, never skills);
 * - a repository with no `SKILL.md` rows is refused — a source that cannot serve this axis is noise;
 * - probes use every served harness's form for DETECTION but pin no layer, so the snapshot is a
 *   whole-repository skill scan;
 * - the entry carries no `harness`, so it is visible to every harness's skill market and its
 *   snapshot lives in the global (not per-harness) snapshot path;
 * - a mutation re-harvests every served harness's index, because the source is shared.
 */

/** Operator input, normalized: full URL, `github.com/...`, `git@github.com:...` or bare `owner/repo`. */
const repoFromUrl = githubRepoFromInput;

const NOT_A_REPO = (url: string) => `not a GitHub repository: '${url}' (use owner/repo or a github.com URL)`;

/** The transient entry a dry-run probe runs against — never persisted as config. */
function probeEntry(slug: string, repo: string): MarketplaceEntry {
  return {
    slug,
    repo,
    type: 'github',
    enabled: true,
    addedAt: Date.now(),
    rescan: { enabled: false, intervalMs: 86_400_000 },
    extensionDir: null,
  };
}

/** Every served harness's form: detection is measured, and no harness's layer is pinned. The scan
 *  itself is the whole repository — a catalog's declared scope must not hide a `skills/` tree. */
const probeOptions = () => ({ hosts: allHostProbes(), wholeTreeSkills: true });

/** A skill source is global: every harness's index must reflect the mutation. */
function harvestAll(): void {
  for (const host of HOSTS) harvestIndex(host.id);
}

export interface SkillSourceCheck {
  ok: boolean;
  skills: number;
  plugins: number;
  message?: string;
}

/** Dry-run: report what the repository carries without writing anything. */
export async function checkSkillSource(url: string, fetchImpl: typeof fetch = fetch): Promise<SkillSourceCheck> {
  const repo = repoFromUrl(url);
  if (!repo) return { ok: false, skills: 0, plugins: 0, message: NOT_A_REPO(url) };
  const read = await probeMarketplace(probeEntry('probe', repo), fetchImpl, { ...probeOptions(), persist: false });
  if (!read.ok) return { ok: false, skills: 0, plugins: 0, message: read.message };
  return { ok: true, skills: read.snapshot.rows.length, plugins: read.snapshot.plugins.length };
}

export interface SkillSourceWrite {
  catalog?: string;
  rescan?: { enabled?: boolean; intervalMs?: number };
}

/** Probe first, refuse a repository that carries no skill, then store a GLOBAL entry. */
export async function registerSkillSource(
  url: string,
  opts: SkillSourceWrite = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message?: string }> {
  const repo = repoFromUrl(url);
  if (!repo) return { ok: false, message: NOT_A_REPO(url) };
  const slug = resolveSlug(repo, null);
  if (!slug.ok) return { ok: false, message: slug.message };
  // The store is shared with the per-harness plugin sources, so the duplicate gate spans scopes:
  // the same repository registered twice under two axes would answer ONE identity twice.
  if (listMarketplaceEntries().some((e) => e.slug === slug.slug || e.repo === repo)) {
    return { ok: false, message: `slug '${slug.slug}' is already configured` };
  }
  const read = await probeMarketplace(probeEntry(slug.slug, repo), fetchImpl, probeOptions());
  if (!read.ok) return { ok: false, message: read.message };
  if (read.snapshot.rows.length === 0) {
    return { ok: false, message: `'${repo}' publishes no SKILL.md — not a skill source` };
  }
  addMarketplaceEntry({
    slug: slug.slug,
    repo,
    type: 'github',
    catalog: opts.catalog,
    rescan: opts.rescan,
    harness: null,
    extensionDir: read.snapshot.extensionDir,
  });
  harvestAll();
  return { ok: true, message: `registered '${repo}' as '${marketplaceSourceId(slug.slug)}' (${read.snapshot.rows.length} skill(s))` };
}

/** The entry behind a skill-axis request: an entry whose snapshot carries NO `SKILL.md` row serves
 *  the plugin axis only, so the skill route must not edit or delete it (§D11 route isolation). */
export function skillSourceEntry(slug: string): MarketplaceEntry | undefined {
  const entry = getMarketplaceEntry(slug);
  if (!entry) return undefined;
  const snap = latestSnapshot(slug, entry.harness ?? null);
  return (snap?.rows.length ?? 0) > 0 ? entry : undefined;
}

/** In-place edit of a global entry (enable + catalog + rescan schedule). */
export function updateSkillSource(slug: string, patch: SkillSourceWrite & { enabled?: boolean }): boolean {
  const entry = skillSourceEntry(slug);
  if (!entry) return false;
  const updated = updateMarketplaceEntry(slug, patch, entry.harness ?? null) !== null;
  // Catalog rows move with `enabled`/`catalog`: the harvest is a local snapshot read, so every
  // served harness re-reads it now instead of serving the pre-edit rows until the next mutation.
  if (updated) harvestAll();
  return updated;
}

export function removeSkillSource(slug: string): boolean {
  // Remove the entry at its OWN scope; a skill source registered by this module has none.
  const entry = skillSourceEntry(slug);
  if (!entry) return false;
  const removed = removeMarketplaceEntry(slug, entry.harness ?? null);
  if (removed) harvestAll();
  return removed;
}

/** Manual rescan: re-probe the repository and report the diff against the previous snapshot. */
export async function rescanSkillSource(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; rows: number; diff: { added: string[]; removed: string[] } } | { ok: false; message: string }> {
  const entry = skillSourceEntry(slug);
  if (!entry) return { ok: false, message: `no source '${slug}'` };
  const prev = latestSnapshot(slug, entry.harness ?? null);
  const read = await probeMarketplace(entry, fetchImpl, probeOptions());
  if (!read.ok) return { ok: false, message: read.message };
  harvestAll();
  const added = prev ? read.snapshot.rows.filter((r) => !prev.rows.some((p) => p.name === r.name)).map((r) => r.name) : [];
  const removed = prev ? prev.rows.filter((p) => !read.snapshot.rows.some((r) => r.name === p.name)).map((p) => p.name) : [];
  return { ok: true, rows: read.snapshot.rows.length, diff: { added, removed } };
}
