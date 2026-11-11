import fs from 'node:fs';
import path from 'node:path';
import { resolveEnvName, getEnvRootDir } from '../../config/env.js';
import { copyDrift } from './drift.js';
import { readSkillMeta } from '../skill/skill-md.js';
import { adapterFor, skillLocationRoots, skillReaders } from './adapters/index.js';
import { claimOwner, readManifest } from './manifest.js';
import { discoverPlugins, discoverMcp, pluginSources, mcpSources, mcpTrackedKey, trackedKey, storeDescription } from './discover.js';
import type { ExtSource } from './adapters/types.js';
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
} from '../types.js';

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
  // existence/hash check would report 'missing' (the pi-plugin bug) or 'dirty'. There is no
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

/**
 * Package names an artifact key can name in a runtime store. The record's `name` may be an install
 * SPEC (`dsh-plugin-codegraph@0.6.5`) rather than a package name, so its version tag is stripped;
 * a scoped name keeps its leading `@`.
 */
function packageNames(record: ArtifactRecord): string[] {
  const names = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    const value = raw?.trim();
    if (value) names.add(value);
  };
  const key = record.canonicalKey;
  const sep = key.indexOf(':');
  const ref = sep === -1 ? key : key.slice(sep + 1);
  if (key.startsWith('npm:')) {
    const at = ref.indexOf('@', 1);
    add(at === -1 ? ref : ref.slice(0, at));
  } else if (key.startsWith('github:') || key.startsWith('git:')) {
    const repoPath = ref.split('#')[0]!.replace(/^github\.com\//, '').replace(/\.git$/, '');
    add(repoPath.split('/').pop());
  } else if (key.startsWith('claude:')) {
    add(ref.split('@')[0]);
  }
  add(record.name);
  const at = record.name.indexOf('@', 1);
  add(at === -1 ? record.name : record.name.slice(0, at));
  return [...names];
}

function toView(record: ArtifactRecord, envName: string, projectRoot: string, sources: readonly ExtSource[]): ArtifactView {
  const copies: CopyView[] = record.copies.map((copy) => ({
    scope: copy.scope,
    host: copy.host,
    rootId: copy.rootId,
    path: copy.path,
    ...(copy.profile ? { profile: copy.profile } : {}),
    ...(copy.external ? { external: true } : {}),
    ...(copy.projectRoot ? { projectRoot: copy.projectRoot } : {}),
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
    // A native-marketplace / git install records no registry line and owns an external copy, so the
    // installed package's own manifest is the last honest source (`storeDescription`).
    description:
      record.copies.map((c) => (fs.existsSync(c.path) ? readSkillMeta(c.path).description ?? null : null)).find((d) => d) ??
      record.description ??
      (record.kind === 'plugin' &&
        record.harness &&
        record.copies.some((copy) => copy.external === true)
        ? storeDescription(sources, record.harness, packageNames(record), {
            profile: record.copies.find((c) => c.external === true)?.profile,
            nativeKey: record.nativeKey,
          })
        : null) ??
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

/**
 * Keys under which discovery must NOT report a runtime row: the artifact's market identity AND,
 * for a native marketplace install, the runtime's own `<plugin>@<marketplace>` identity in both
 * spellings discovery may read it (`claude:postman@postman`, or the bare store key). Without the
 * native form, a `claude plugin install` recorded as an `mp-` artifact is read back from
 * `installed_plugins.json` as a SECOND artifact — one install, two rows.
 */
export function trackedPluginKeys(artifacts: ArtifactRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const record of artifacts) {
    if (record.kind !== 'plugin' || !record.harness) continue;
    for (const key of [record.canonicalKey, record.nativeKey]) {
      if (!key) continue;
      keys.add(trackedKey(record.harness, key));
      // A MAP store's discovery namespaces its key with the host's spec prefix (claude:).
      keys.add(trackedKey(record.harness, `${record.harness}:${key}`));
    }
  }
  return keys;
}

/**
 * `host|name` for plugin artifacts whose recorded identity is NOT a registry key.
 *
 * `trackedPluginKeys` already excludes an `npm:`-keyed artifact because discovery re-derives the
 * same `npm:<name>` key from a declared store. Every OTHER install records an identity the store
 * never repeats: a native marketplace chain writes `mp-*` / `<name>@<marketplace>`, and a Git
 * install records `github:<owner>/<repo>` while DSH's `dsh.profile.bundles` only carries the bare
 * package name. Without the name fallback that one install answers twice — a tracked row plus a
 * discovered "managed by the runtime" row for the very same package (see `discoverPlugins`
 * `trackedNames`).
 */
export function trackedPluginNames(artifacts: ArtifactRecord[]): Set<string> {
  const names = new Set<string>();
  for (const record of artifacts) {
    if (record.kind !== 'plugin' || !record.harness) continue;
    if (record.canonicalKey.startsWith('npm:')) continue;
    names.add(`${record.harness}|${record.name}`);
  }
  return names;
}

export function scanInventory(projectRoot: string = process.cwd()): InventoryResponse {
  const envName = resolveEnvName();
  const manifest = readManifest();
  // One adapter enumeration for the whole scan: tracked rows read their installed manifest from the
  // same sources discovery scans.
  const sources = pluginSources(projectRoot);
  const artifacts = manifest.artifacts.map((record) => toView(record, envName, projectRoot, sources));

  const tracked = new Set<string>();
  for (const record of manifest.artifacts) {
    // An `external` copy's `path` is an identity token, not a location — resolving it would put a
    // nonsense entry in the tracked set (and could never match a scanned directory anyway).
    for (const copy of record.copies) if (copy.external !== true) tracked.add(path.resolve(copy.path));
  }

  const untracked: CopyView[] = [];
  let hostsScanned = 0;
  for (const { host, scope, root } of skillRoots(projectRoot)) {
    // Scope filtering is an enabled-scope filter, not an adapter change (ADR-0015 §D2 "Scope") —
    // the project roots stay declared in the adapters as the single seam.
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


  // Plugins get the mirror treatment (ADR-0015 §D8.10): the runtime's own store is read-only
  // observation, and an artifact this environment already tracks is excluded so one install is
  // never reported twice under two different owners.
  const trackedPlugins = trackedPluginKeys(manifest.artifacts);
  const plugins = discoverPlugins(sources.filter((s) => isEnabledScope(s.scope)), {
    tracked: trackedPlugins,
    trackedNames: trackedPluginNames(manifest.artifacts),
  });

  // MCP gets the same mirror treatment over the OBJECT-shaped landing: each server key inside a
  // host's `mcp` container is observed, tagged with the host it was read from, and excluded when this
  // environment already tracks that `(host, serverKey)` — see `discoverMcp`.
  const trackedMcp = new Set(
    manifest.artifacts
      .filter((record) => record.kind === 'mcp')
      .flatMap((record) =>
        record.copies.map((copy) =>
          mcpTrackedKey(copy.host, record.name, copy.scope, copy.projectRoot ?? projectRoot)
        )
      )
  );
  const mcp = discoverMcp(mcpSources(projectRoot).filter((s) => isEnabledScope(s.scope)), { tracked: trackedMcp });

  return {
    envName,
    envRoot: getEnvRootDir(),
    hostsScanned,
    artifacts,
    discovered: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).concat(plugins, mcp),
    discoveredCopies:
      untracked.length +
      plugins.reduce((total, row) => total + row.copies.length, 0) +
      mcp.reduce((total, row) => total + row.copies.length, 0),
  };
}
