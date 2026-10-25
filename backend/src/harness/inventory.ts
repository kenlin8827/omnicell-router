import fs from 'node:fs';
import path from 'node:path';
import { resolveEnvName, getEnvRootDir } from '../config/env.js';
import { copyDrift } from './drift.js';
import { readSkillMeta } from './skill-md.js';
import { adapterFor, skillLocationRoots, skillReaders } from './adapters/index.js';
import { claimOwner, readManifest } from './manifest.js';
import { discoverExtensions, discoverMcp, extensionSources, mcpSources, mcpTrackedKey, trackedKey } from './discover.js';
import { isEnabledScope } from './scopes.js';
import type {
  ArtifactRecord,
  ArtifactView,
  CopyRecord,
  CopyState,
  CopyView,
  DiscoveredArtifact,
  HarnessHostId,
  HarnessScope,
  InventoryResponse,
} from './types.js';

/**
 * Inventory — "what is installed where", reconciled against the manifest (ADR-0015 §D8.7).
 *
 * Read-only. A copy's state is the ONLY persisted vocabulary; `rollup` is derived here and never
 * written. Hashing uses the mtime+size fast path first: an unchanged copy is `clean` without I/O;
 * otherwise `copyDrift` hashes it with the algorithm its writer recorded (a tree for a skill
 * directory, the single file for a config copy).
 */

function isSkillDir(abs: string): boolean {
  return fs.existsSync(path.join(abs, 'SKILL.md'));
}

function fingerprint(abs: string): { mtimeMs: number; bytes: number } | null {
  try {
    const stat = fs.statSync(abs);
    return { mtimeMs: stat.mtimeMs, bytes: stat.size };
  } catch {
    return null;
  }
}

function copyState(copy: CopyRecord, envName: string): CopyState {
  // A package-manager-owned copy has no path of ours: `path` is an identity token, so every
  // existence/hash check would report 'missing' (the pi-extension bug) or 'dirty'. There is no
  // content WE own to reconcile — the runtime's own store is the truth, and the apply-time
  // subprocess exit code already proved the install — so the copy is reported clean.
  if (copy.external === true) return 'clean';
  if (!fs.existsSync(copy.path)) return 'missing';
  const owner = claimOwner(copy.path);
  if (owner && owner !== envName) return 'foreign';
  const fp = fingerprint(copy.path);
  if (fp && copy.mtimeMs === fp.mtimeMs && copy.bytes === fp.bytes) return 'clean';
  try {
    // Same algorithm the writer recorded with, chosen per copy shape (file config vs skill tree):
    // `hashTree` on a config FILE returns the empty-tree digest and would report every MCP copy
    // dirty as soon as another server is merged into the same file.
    return copyDrift(copy, copy.path) ? 'dirty' : 'clean';
  } catch {
    return 'missing';
  }
}

function rollupOf(copies: CopyView[]): ArtifactView['rollup'] {
  if (copies.length === 0) return 'missing';
  if (copies.some((c) => c.state === 'dirty')) return 'dirty';
  if (copies.some((c) => c.state === 'missing')) return 'missing';
  if (copies.some((c) => c.state === 'foreign')) return 'partial';
  return 'clean';
}

function toView(record: ArtifactRecord, envName: string, projectRoot: string): ArtifactView {
  const copies: CopyView[] = record.copies.map((copy) => ({
    scope: copy.scope,
    host: copy.host,
    rootId: copy.rootId,
    path: copy.path,
    ...(copy.external ? { external: true } : {}),
    state: copyState(copy, envName),
    placement: copy.placement,
    contentHash: copy.contentHash,
    // Skills only: a directory is read by its owner plus every `readsUniversal` runtime, and the
    // console's rail asks exactly that question. The ROOT is the copy's parent — a skill target is
    // always `<root>/<name>` (enforced by `skillTarget`), never nested. Config-shaped copies carry
    // no readers.
    ...(record.kind === 'skill' && copy.external !== true
      ? { readers: skillReaders(path.dirname(copy.path), copy.scope, projectRoot) }
      : {}),
  }));
  return {
    id: record.id,
    canonicalKey: record.canonicalKey,
    kind: record.kind,
    ...(record.harness ? { harness: record.harness } : {}),
    name: record.name,
    // Installed text wins when the copy carries it (a skill's `SKILL.md` is the authoritative prose);
    // the manifest's recorded description is the fallback for kinds whose copy has no file of ours to
    // read — an npm package living in the runtime's own store, an MCP entry inside a host config.
    description:
      record.copies.map((c) => (fs.existsSync(c.path) ? readSkillMeta(c.path).description ?? null : null)).find((d) => d) ??
      record.description ??
      null,
    sourceId: record.sourceId ?? null,
    // A record written before the facet existed has no `listedOn`: the writer source is then the
    // only surface it is known to have been listed on, never an empty claim.
    listedOn: record.listedOn ?? (record.sourceId ? [record.sourceId] : []),
    trust: record.trust,
    audit: null,
    copies,
    rollup: rollupOf(copies),
  };
}

/** Every skills directory the host adapters resolve, deduplicated, BOTH scopes (project roots use
 *  cwd). The scan below narrows to `ENABLED_SCOPES`; the removal guard needs the full set so a copy
 *  installed while project scope was open stays removable. */
export function skillRoots(projectRoot: string = process.cwd()): { host: HarnessHostId; scope: HarnessScope; root: string }[] {
  return skillLocationRoots(projectRoot);
}

export function scanInventory(projectRoot: string = process.cwd()): InventoryResponse {
  const envName = resolveEnvName();
  const manifest = readManifest();
  const artifacts = manifest.artifacts.map((record) => toView(record, envName, projectRoot));

  const tracked = new Set<string>();
  for (const record of manifest.artifacts) {
    // An `external` copy's `path` is an identity token, not a location — resolving it would put a
    // nonsense entry in the tracked set (and could never match a scanned directory anyway).
    for (const copy of record.copies) if (copy.external !== true) tracked.add(path.resolve(copy.path));
  }

  const untracked: CopyView[] = [];
  let hostsScanned = 0;
  for (const { host, scope, root } of skillRoots(projectRoot)) {
    // Project discovery is deferred (ADR-0015 §D2 "Scope"): an enabled-scope filter, not an adapter
    // change — the project roots stay declared in the adapters as the seam.
    if (!isEnabledScope(scope)) continue;
    hostsScanned += 1;
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = path.join(root, name);
      if (tracked.has(abs) || !isSkillDir(abs)) continue;
      const owner = claimOwner(abs);
      untracked.push({
        scope,
        host,
        rootId: adapterFor(host)?.configRootEnv ?? 'default',
        path: abs,
        state: owner ? 'foreign' : 'untracked',
        placement: 'materialized',
        // The same readership answer a tracked copy gets: a directory found on disk is read by every
        // runtime whose skills roots resolve to it, not only by the adapter that reported it.
        readers: skillReaders(root, scope, projectRoot),
      });
    }
  }

  // Group per skill NAME, not per directory: one skill commonly lives in several host roots, and
  // listing each directory separately turns a normal machine into a wall of duplicate paths.
  const byName = new Map<string, DiscoveredArtifact>();
  for (const copy of untracked) {
    const name = path.basename(copy.path);
    const entry = byName.get(name) ?? {
      kind: 'skill' as const,
      name,
      description: readSkillMeta(copy.path).description ?? null,
      copies: [],
      hosts: [],
    };
    entry.copies.push(copy);
    if (!entry.hosts.includes(copy.host)) entry.hosts.push(copy.host);
    byName.set(name, entry);
  }

  // Extensions get the mirror treatment (ADR-0015 §D8.10): the runtime's own store is read-only
  // observation, and an artifact this environment already tracks is excluded so one install is
  // never reported twice under two different owners.
  const trackedExtensions = new Set(
    manifest.artifacts
      .filter((record) => record.kind === 'extension' && record.harness)
      .map((record) => trackedKey(record.harness!, record.canonicalKey))
  );
  const extensions = discoverExtensions(extensionSources(projectRoot).filter((s) => isEnabledScope(s.scope)), { tracked: trackedExtensions });

  // MCP gets the same mirror treatment over the OBJECT-shaped landing: each server key inside a
  // host's `mcp` container is observed, tagged with the host it was read from, and excluded when this
  // environment already tracks that `(host, serverKey)` — see `discoverMcp`.
  const trackedMcp = new Set(
    manifest.artifacts
      .filter((record) => record.kind === 'mcp')
      .flatMap((record) => record.copies.map((copy) => mcpTrackedKey(copy.host, record.name)))
  );
  const mcp = discoverMcp(mcpSources(projectRoot).filter((s) => isEnabledScope(s.scope)), { tracked: trackedMcp });

  return {
    envName,
    envRoot: getEnvRootDir(),
    hostsScanned,
    artifacts,
    discovered: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).concat(extensions, mcp),
    discoveredCopies:
      untracked.length +
      extensions.reduce((total, row) => total + row.copies.length, 0) +
      mcp.reduce((total, row) => total + row.copies.length, 0),
  };
}
