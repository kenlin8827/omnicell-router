import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import { getEnvRootDir, resolveEnvName } from '../config/env.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import type { ArtifactRecord, ClaimsFile, CopyRecord, HarnessHostId, ManifestFile } from './types.js';

/**
 * Ownership records for harness artifacts (ADR-0015 §D4).
 *
 * Two layers:
 *  - intent   `<env>/harness/manifest.json`      — what THIS environment wants installed
 *  - claims   `<ocrHome>/harness/claims.json`    — which environment owns a materialized path
 *
 * The split is what prevents the data-loss case: two environments claiming one path would let either
 * one delete the other's files. A foreign claim is transfer-only.
 *
 * Manifest v2 adds the artifact-level `harness` dimension for extensions. v1 files are migrated in
 * memory on read and persisted as v2 by the next write — a read never rewrites `manifest.json`.
 * The one side-file a read may append is `manifest.orphans.json`: a v1 extension record with no copy
 * has no host, so v2 cannot name it; retiring it quietly would delete the only record that it ever
 * existed, and keeping it in v2 would leave a row no harness page can show or remove.
 */

const EMPTY_MANIFEST: ManifestFile = { version: 2, artifacts: [] };
const EMPTY_CLAIMS: ClaimsFile = { version: 1, claims: {} };

/** Version this process WRITES. v1 files are migrated in memory on read (see `readManifest`). */
const MANIFEST_VERSION = 2;

export function harnessEnvDir(): string {
  return path.join(getEnvRootDir(), 'harness');
}

export function manifestPath(): string {
  return path.join(harnessEnvDir(), 'manifest.json');
}

/** Retirement file for v1 extension records that carry no host (see `migrateV1`). */
export function orphansPath(): string {
  return path.join(harnessEnvDir(), 'manifest.orphans.json');
}

/** One retired record plus when it was retired — the append-only audit trail behind the migration. */
export interface ManifestOrphan {
  migratedAt: string;
  record: ArtifactRecord;
}

export function claimsPath(): string {
  return path.join(getOcrHomeDir(), 'harness', 'claims.json');
}

/** Move an unusable state file aside so its bytes survive the next whole-file write. */
function setAside(file: string, why: string): void {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    // A rename that fails leaves the original in place — still not a reason to overwrite it.
    throw new Error(`${path.basename(file)} is not usable (${why}) and could not be set aside`);
  }
  console.error(`[harness] ${path.basename(file)} is not usable (${why}); kept as ${path.basename(aside)}`);
}

/**
 * Read a JSON state file. Absent means "first run" and answers the fallback; everything else is a
 * failure to report, never an empty baseline — every caller writes this file back whole, so a
 * fallback returned over an UNREADABLE file would silently replace the ledger it could not read.
 *
 *  · read error (EBUSY from an indexer/AV, EACCES): throw. A transient lock must fail the operation,
 *    not become a fresh empty state.
 *  · unparsable bytes: move the file aside, then answer the fallback — the next write starts a new
 *    file instead of eating it.
 */
function readJson<T>(file: string, fallback: T): T {
  let raw: string;
  try {
    if (!fs.existsSync(file)) return fallback;
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    setAside(file, 'not valid JSON');
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameWithRetry(tmp, file);
}

export function readManifest(): ManifestFile {
  const file = manifestPath();
  const data = readJson<ManifestFile>(file, EMPTY_MANIFEST);
  if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.artifacts)) {
    // Present but unrecognised: the same rule as unparsable bytes — set aside, never overwrite.
    if (fs.existsSync(file)) setAside(file, 'unrecognised manifest shape');
    return EMPTY_MANIFEST;
  }
  return data.version === 1 ? migrateV1(data) : data;
}

/**
 * v1 → v2 in memory (no `manifest.json` write here; the next `writeManifest` persists it).
 *
 * v1 predates the harness dimension: an extension record was `extension:<canonicalKey>` with ONE
 * copy per host, i.e. the same package installed into several runtimes shared one identity. In v2
 * the runtime is part of the identity, so such a record SPLITS into one record per copy host —
 * `extension:<host>:<canonicalKey>`, that host's copies only, `harness` set to that host.
 * Every other kind is unchanged: for skills/MCP the host is a landing, never an identity.
 *
 * v1 also had no `external` marker: the subprocess branch recorded a placeholder token
 * `<canonicalKey>#<host>` as if it were a location, which is why every pi extension reported
 * 'missing'. The token was written verbatim by that branch, so an EXACT match re-marks the copy —
 * a migrated record then behaves exactly like a fresh single-harness apply.
 *
 * A copy-less legacy record carries no host, so its harness is unknowable. It cannot stay in v2
 * (`extension:<canonicalKey>` names no harness, so every harness page hides it — installed, yet
 * invisible and unremovable) and it must not be dropped either (that erases the only record it ever
 * existed). It is retired to `manifest.orphans.json` instead, and only then removed from v2.
 */
function migrateV1(data: ManifestFile): ManifestFile {
  const artifacts: ArtifactRecord[] = [];
  const orphans: ArtifactRecord[] = [];
  for (const record of data.artifacts) {
    const legacyExtensionId = `extension:${record.canonicalKey}`;
    if (record.kind !== 'extension' || record.id !== legacyExtensionId) {
      artifacts.push(record);
      continue;
    }
    const byHost = new Map<HarnessHostId, CopyRecord[]>();
    for (const copy of record.copies) {
      const migrated =
        copy.external === undefined && copy.path === `${record.canonicalKey}#${copy.host}`
          ? { ...copy, external: true }
          : copy;
      const list = byHost.get(copy.host) ?? [];
      list.push(migrated);
      byHost.set(copy.host, list);
    }
    if (byHost.size === 0) {
      orphans.push(record);
      continue;
    }
    for (const [host, copies] of byHost) {
      artifacts.push({
        ...record,
        id: `extension:${host}:${record.canonicalKey}`,
        harness: host,
        copies,
      });
    }
  }
  return { version: 2, artifacts: retireOrphans(orphans, artifacts) };
}

/**
 * Persist host-less legacy records and return the v2 artifact list WITHOUT them.
 *
 * Losing the record is worse than leaving a ghost: if the side-file cannot be written, the records
 * stay in the migrated manifest verbatim (and the reason is logged), because an unwritable retirement
 * file must never turn into data loss.
 */
function retireOrphans(orphans: ArtifactRecord[], artifacts: ArtifactRecord[]): ArtifactRecord[] {
  if (orphans.length === 0) return artifacts;
  let appended: number;
  try {
    appended = appendOrphans(orphans);
  } catch (e) {
    // Keep the records rather than lose them: an unwritable side-file must not become data loss.
    console.warn(
      `[harness] could not retire ${orphans.length} v1 extension record(s) with no host — kept in manifest.json: ${e instanceof Error ? e.message : String(e)}`
    );
    return [...artifacts, ...orphans];
  }
  if (appended > 0) {
    console.warn(
      `[harness] retired ${appended} v1 extension record(s) with no host to ${orphansPath()} (they name no harness, so no harness page can show or remove them)`
    );
  }
  return artifacts;
}

/** Append new orphans by id (idempotent: a re-read of the same v1 file adds nothing). */
function appendOrphans(records: ArtifactRecord[]): number {
  const file = orphansPath();
  const existing = readJson<ManifestOrphan[]>(file, []);
  const rows = Array.isArray(existing) ? existing : [];
  const known = new Set(rows.map((row) => row?.record?.id).filter((id): id is string => typeof id === 'string'));
  const migratedAt = new Date().toISOString();
  const fresh: ManifestOrphan[] = records
    .filter((record) => !known.has(record.id))
    .map((record) => ({ migratedAt, record }));
  if (fresh.length === 0) return 0;
  writeJson(file, [...rows, ...fresh]);
  return fresh.length;
}

export function writeManifest(data: ManifestFile): void {
  // Always v2 on disk: the writer owns the version, callers never have to remember to bump it.
  writeJson(manifestPath(), { ...data, version: MANIFEST_VERSION });
}

export function readClaims(): ClaimsFile {
  const data = readJson<ClaimsFile>(claimsPath(), EMPTY_CLAIMS);
  if (!data || data.version !== 1 || typeof data.claims !== 'object') return EMPTY_CLAIMS;
  return data;
}

export function writeClaims(data: ClaimsFile): void {
  writeJson(claimsPath(), data);
}

export type ClaimVerdict =
  | { ok: true }
  | { ok: false; reason: 'foreign'; env: string; artifactId: string };

/** Can the active environment own this path? */
export function canClaim(absPath: string, envName: string = resolveEnvName()): ClaimVerdict {
  const claim = readClaims().claims[absPath];
  if (!claim) return { ok: true };
  if (claim.env === envName) return { ok: true };
  return { ok: false, reason: 'foreign', env: claim.env, artifactId: claim.artifactId };
}

/** Register a claim; refuses to steal another environment's path. */
export function claimPath(absPath: string, artifactId: string, envName: string = resolveEnvName()): ClaimVerdict {
  const verdict = canClaim(absPath, envName);
  if (!verdict.ok) return verdict;
  const data = readClaims();
  data.claims[absPath] = { env: envName, artifactId };
  writeClaims(data);
  return { ok: true };
}

export function releaseClaim(absPath: string, envName: string = resolveEnvName()): void {
  const data = readClaims();
  const claim = data.claims[absPath];
  if (!claim || claim.env !== envName) return;
  delete data.claims[absPath];
  writeClaims(data);
}

/** Environment a path is claimed by, if any. */
export function claimOwner(absPath: string): string | null {
  return readClaims().claims[absPath]?.env ?? null;
}

export function findArtifact(artifactId: string): ArtifactRecord | undefined {
  return readManifest().artifacts.find((a) => a.id === artifactId);
}
