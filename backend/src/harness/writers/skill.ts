import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../../cli/paths.js';
import { hashTree } from '../hash.js';
import { adapterFor, isSkillsHost, skillOwner } from '../adapters/index.js';
import { claimPath, readManifest, releaseClaim, writeManifest } from '../manifest.js';
import { normalizeName } from '../spi.js';
import type { SkillFile } from '../spi.js';
import type { HarnessHostId, HarnessScope, Pin, TrustTier } from '../types.js';

/**
 * Skill kind writer (ADR-0015 §8) — the disk half of a skill install.
 *
 * Order matters: every byte is written into the content-addressed store BEFORE anything appears in a
 * host directory, and the manifest is written last. A failure at any point leaves no half-installed
 * skill; the store copy is content-addressed, so a retry re-uses it and costs no network.
 *
 * One host can refuse (no skills location, path already occupied, claimed by another environment)
 * while the rest proceed — refusals are reported per host, never silently dropped. Ten hosts read
 * the same project directory, so identical target paths are installed ONCE, labeled by the owner
 * host; the console can then never show "installed under Codex" for a directory the scan reports as
 * universal.
 */

/** One host that did not receive a copy, with the reason. */
export interface InstallSkipped {
  host: string;
  code: 'bad_request' | 'exists' | 'foreign' | 'upstream';
  message: string;
}

export interface SkillApplyRequest {
  sourceId: string;
  /** `<sourceId>:<ref>[#detail]` — the manifest canonicalKey. */
  canonicalKey: string;
  /** Raw artifact name (vendor spelling); normalized here for target paths. */
  rawName: string;
  /** Filesystem-safe store token from the resolving adapter. */
  storeKey: string;
  files: SkillFile[];
  pin: Pin;
  trust: TrustTier;
  /** Listing surfaces recorded with the manifest (writer source first); absent = `[sourceId]`. */
  listedOn?: string[];
  hosts: HarnessHostId[];
  scope: HarnessScope;
  /** Project root for `project` scope resolution; defaults to this process's cwd. */
  projectRoot?: string;
}

export type SkillApplyResult =
  | {
      ok: true;
      artifactId: string;
      name: string;
      storeRef: string;
      files: number;
      bytes: number;
      /** Hosts that were materialized. */
      copies: { host: string; path: string }[];
      /** Hosts that were refused; a partial install succeeds, installing nowhere does not. */
      skipped: InstallSkipped[];
    }
  | {
      ok: false;
      code: 'no_target' | 'invalid_name' | 'exists' | 'foreign' | 'bad_request' | 'upstream';
      message: string;
      skipped?: InstallSkipped[];
    };

export function applySkill(req: SkillApplyRequest): SkillApplyResult {
  const name = normalizeName(req.rawName);
  if (!name) {
    return { ok: false, code: 'invalid_name', message: `derived an unusable skill name from '${req.rawName}'` };
  }
  // The store key becomes a path segment under <ocrHome>/harness/store — a key containing a
  // separator or `..` would escape the store (the install.ts fallback builds it from a raw name).
  if (!/^[\w@.-]+$/.test(req.storeKey) || req.storeKey.includes('..')) {
    return { ok: false, code: 'invalid_name', message: `refusing unsafe store key '${req.storeKey}'` };
  }

  // 1. Resolve every requested target + ownership checks BEFORE any write. All-target refusals fail
  //    with the first refusal's code so the wire keeps distinguishing "exists" from "foreign".
  const artifactId = `skill:${req.canonicalKey}`;
  const targets: { host: HarnessHostId; path: string }[] = [];
  const skipped: InstallSkipped[] = [];
  for (const host of req.hosts) {
    const adapter = adapterFor(host);
    const target = isSkillsHost(adapter)
      ? adapter.skillTarget({ projectRoot: req.projectRoot ?? process.cwd() }, req.scope, name)
      : { ok: false as const, reason: `host '${host}' has no skills location` };
    if (!target.ok) {
      skipped.push({ host, code: 'bad_request', message: target.reason });
      continue;
    }
    if (fs.existsSync(target.path)) {
      skipped.push({ host, code: 'exists', message: `${target.path} already exists — uninstall it first` });
      continue;
    }
    const owner = skillOwner(target.root.root, req.scope, req.projectRoot) ?? host;
    if (targets.some((t) => t.path === target.path)) continue;
    const claim = claimPath(target.path, artifactId);
    if (!claim.ok) {
      skipped.push({ host: owner, code: 'foreign', message: `${target.path} is claimed by environment '${claim.env}'` });
      continue;
    }
    targets.push({ host: owner, path: target.path });
  }
  if (targets.length === 0) {
    return {
      ok: false,
      code: skipped[0]?.code ?? 'no_target',
      message: skipped.map((s) => `${s.host}: ${s.message}`).join('; ') || 'no host location to install into',
      skipped,
    };
  }

  // 2. Stage the payload into the store, then promote it atomically. A store-phase throw must not
  //    leak the phase-1 claims or the staging dir — release + clean, then fail as upstream.
  const storeRef = path.join(getOcrHomeDir(), 'harness', 'store', req.storeKey);
  const staging = `${storeRef}.tmp-${process.pid.toString(36)}${Date.now().toString(36)}`;
  let written = 0;
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const entry of req.files) {
      // Normalize before the traversal check: on win32 `\` is ALSO a separator, so a tarball entry
      // named `..\..\evil` would sail past a `/`-only split and land outside the staging dir.
      const rel = entry.path.replace(/\\/g, '/');
      if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) continue;
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
      written += entry.data.length;
    }
    fs.rmSync(storeRef, { recursive: true, force: true });
    fs.renameSync(staging, storeRef);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    for (const t of targets) releaseClaim(t.path);
    return { ok: false, code: 'upstream', message: `store write failed: ${e instanceof Error ? e.message : e}`, skipped };
  }
  const contentHash = hashTree(storeRef).hash;

  // 3. Materialize one copy per accepted host. A copy that fails is rolled back to nothing rather
  //    than left half-written, and reported instead of hidden.
  const copies: { host: string; path: string }[] = [];
  for (const item of targets) {
    try {
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      fs.cpSync(storeRef, item.path, { recursive: true });
      copies.push(item);
    } catch (e) {
      fs.rmSync(item.path, { recursive: true, force: true });
      releaseClaim(item.path);
      skipped.push({ host: item.host, code: 'upstream', message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (copies.length === 0) {
    return { ok: false, code: 'no_target', message: 'no host copy could be written', skipped };
  }

  // 4. Intent last: a manifest entry only exists for a skill that is fully on disk. Copies already
  //    recorded for this artifact (another host or scope from an earlier install) are preserved.
  const manifest = readManifest();
  const now = new Date().toISOString();
  const previous = manifest.artifacts.find((a) => a.id === artifactId);
  const kept = (previous?.copies ?? []).filter((c) => !copies.some((item) => item.path === c.path));
  manifest.artifacts = [
    ...manifest.artifacts.filter((a) => a.id !== artifactId),
    {
      id: artifactId,
      canonicalKey: req.canonicalKey,
      kind: 'skill',
      name,
      sourceId: req.sourceId,
      ref: req.canonicalKey.slice(req.sourceId.length + 1),
      pin: req.pin,
      contentHash,
      storeRef,
      listedOn: req.listedOn ?? [req.sourceId],
      trust: req.trust,
      copies: [
        ...kept,
        ...copies.map((item) => ({
          scope: req.scope,
          host: item.host as HarnessHostId,
          rootId: 'default',
          path: item.path,
          contentHash,
          placement: 'materialized' as const,
          bytes: written,
          installedAt: now,
        })),
      ],
    },
  ];
  writeManifest(manifest);

  return {
    ok: true,
    artifactId,
    name,
    storeRef,
    files: req.files.length,
    bytes: written,
    copies: copies.map((item) => ({ host: item.host, path: item.path })),
    skipped,
  };
}
