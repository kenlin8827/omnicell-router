import { npmAdapter } from '../host/resolvers/npm.js';
import type { ResolveOptions, ResolveOutcome } from '../spi.js';

/**
 * Shared "catalog → npm package" identity tools (ADR-0015 §D6).
 *
 * Community catalogs list projects but publish no package name
 * they can be trusted on blindly. Both therefore earn a name the same way, and this module is the one
 * place that decides what "earned" means:
 *
 *  1. a name the entry DECLARES itself (`homepageUrl` pointing at npmjs, or a `plugin: [...]` /
 *     `npm install …` snippet in `installation`) — the operator's upstream stated it;
 *  2. a PROBED candidate confirmed by the package's own `repository` field, matched on BOTH owner and
 *     repo. Existence is not evidence: a squatted `opencode-something` exists too.
 *
 * The payload always comes from the npm adapter, so a catalog row and an npm row for the same package
 * share ONE identity (`npm:<pkg>`) and one installed-state join. The catalog's own `sourceId` records
 * where the row was DISCOVERED — provenance, not identity.
 */

/** The shape both catalogs share, narrowed to what install needs. */
export interface CatalogEntry {
  productId?: string;
  displayName?: string;
  repoUrl?: string;
  homepageUrl?: string;
  installation?: string;
}

/** `https://github.com/owner/repo[/...]` → `{owner, repo}`; anything else → null. */
export function repoSlug(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Normalize a `repository` field to `owner/repo`. Both halves matter: a same-named package under a
 *  different owner is a DIFFERENT project, which is exactly the case this check exists to catch. */
function normalizeRepo(value: string): string | null {
  const v = value.trim().replace(/^git\+/, '').replace(/\.(git)?$/, '');
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+)/i.exec(v) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(v);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * Turn a raw token from an install snippet into a package name, or null.
 *
 * Install instructions are prose, not a manifest: they contain `./plugin/x.js`, `…other plugins`,
 * `&&`, and `pkg@1.2.3`. Only a bare package reference survives; a version or dist-tag is stripped
 * because the npm adapter pins a concrete version itself.
 */
export function sanitizePackageName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let v = raw.trim().replace(/^["'`]|["'`]$/g, '');
  if (!v || v.startsWith('-') || v.startsWith('.') || v.startsWith('/') || /\s|&&|\|\||\.\.\./.test(v)) return null;
  // Strip a trailing version / dist-tag without eating the leading scope `@`.
  const at = v.indexOf('@', 1);
  if (at !== -1) v = v.slice(0, at);
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(v) ? v : null;
}

/** A package name the entry declares itself, if any. */
export function declaredPackageName(entry: CatalogEntry): string | null {
  const npmLink = /npmjs\.com\/package\/(@[^/\s]+\/[^/\s?#]+|[^/\s?#]+)/.exec(entry.homepageUrl ?? '');
  if (npmLink) return sanitizePackageName(npmLink[1]);

  const inst = entry.installation;
  if (!inst) return null;
  // A config snippet is the most explicit statement of what the runtime loads.
  const arr = /"(?:plugin|plugins)"\s*:\s*\[([^\]]*)\]/.exec(inst)?.[1];
  const fromArray = arr ? [...arr.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [];
  for (const candidate of [...fromArray]) {
    const clean = sanitizePackageName(candidate);
    if (clean) return clean;
  }
  const commands = [
    ...inst.matchAll(
      /(?:npm\s+(?:i|install|add)|bun\s+(?:add|x)|pnpm\s+add|yarn\s+add|bunx|npx)\s+(?:-g\s+)?(?:--save\s+)?([^\s`'"]+)/g
    ),
  ].map((m) => m[1]!);
  for (const candidate of commands) {
    const clean = sanitizePackageName(candidate);
    if (clean) return clean;
  }
  return null;
}

/**
 * Candidate package names to PROBE, when the entry declares none.
 *
 * Ordered by how often the live registry confirms it (measured 2026-10-25 over catalog rows
 * plugin entries): the repo name is by far the most common spelling, then the product id, then the
 * author's scope around either.
 */
export function npmCandidates(entry: CatalogEntry): string[] {
  const s = repoSlug(entry.repoUrl);
  const out: string[] = [];
  const push = (v: string | undefined | null) => {
    if (v && !out.includes(v)) out.push(v);
  };
  if (s) {
    push(s.repo);
    push(`@${s.owner.toLowerCase()}/${s.repo}`);
  }
  push(entry.productId);
  if (s) push(`@${s.owner.toLowerCase()}/${entry.productId}`);
  return out;
}

interface LatestDoc {
  name?: string;
  version?: string;
  repository?: { url?: string } | string;
}

/** Confirm a registry package IS the project the entry points at, on owner AND repo. */
export async function verifyNpmIdentity(
  name: string,
  slug: { owner: string; repo: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ pkg: string; version: string; evidence: string } | null> {
  if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return null;
  let res: Response;
  try {
    res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { Accept: 'application/json', 'User-Agent': 'omnicellrouter-harness' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let doc: LatestDoc;
  try {
    doc = (await res.json()) as LatestDoc;
  } catch {
    return null;
  }
  const repoUrl = typeof doc.repository === 'string' ? doc.repository : (doc.repository?.url ?? '');
  const want = `${slug.owner}/${slug.repo}`.toLowerCase();
  if (normalizeRepo(repoUrl) !== want) return null;
  return { pkg: doc.name ?? name, version: doc.version ?? '', evidence: `${doc.name}@${doc.version} ← ${repoUrl}` };
}

/** Resolve one catalog entry to an npm plugin payload, or answer `no_artifact` honestly. */
export async function resolveCatalogPackage(
  entry: CatalogEntry,
  kind: 'skill' | 'mcp' | 'plugin',
  opts: ResolveOptions = {}
): Promise<ResolveOutcome> {
  if (kind !== 'plugin') {
    return {
      ok: false,
      code: 'unsupported_kind',
      message: `catalog sources resolve plugin packages only (kind '${kind}' has no reader here)`,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;

  const declared = declaredPackageName(entry);
  if (declared) {
    const viaNpm = await npmAdapter.resolve(declared, 'plugin', { fetchImpl });
    if (viaNpm.ok) return viaNpm;
  }

  const slug = repoSlug(entry.repoUrl);
  if (slug) {
    for (const candidate of npmCandidates(entry)) {
      const verified = await verifyNpmIdentity(candidate, slug, fetchImpl);
      if (!verified) continue;
      const viaNpm = await npmAdapter.resolve(verified.pkg, 'plugin', { fetchImpl });
      if (viaNpm.ok) return viaNpm;
    }
  }

  return {
    ok: false,
    code: 'no_artifact',
    message: `no npm package could be verified for '${entry.productId ?? entry.displayName ?? 'this entry'}' — install it by hand from ${entry.repoUrl ?? 'its repository'}`,
  };
}
