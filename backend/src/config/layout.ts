/**
 * Version-agnostic disk↔runtime layout mechanics shared by every migration
 * file and by schema.ts's current-version binding (ADR-0016).
 *
 * NOTHING here knows a specific version's section list — a migration file
 * owns its `SECTION_MOVES_V<n>` table; schema.ts binds the LATEST one as the
 * current layout. The retry/escalation split is the one shape rule encoded
 * here (runtime keeps `retry` and `fallback` as siblings; the disk nests
 * `fallback` as `resilience.retry.escalation`).
 */
import type { RouterConfig } from './types.js';

export type SectionMove = readonly [disk: string, runtime: string];

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] === null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
    cur = cur[segs[i]] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

/**
 * Runtime flat config → disk shape under `moves`. Sections are referenced
 * (not cloned) — callers serialize immediately; nobody mutates either side
 * after this returns.
 */
export function toDiskConfigWith(moves: readonly SectionMove[], flat: Partial<RouterConfig> & Record<string, unknown>): Record<string, unknown> {
  const disk: Record<string, unknown> = {};
  for (const [diskPath, runtimePath] of moves) {
    const v = getPath(flat, runtimePath);
    if (v !== undefined) setPath(disk, diskPath, v);
  }
  const retry = flat.retry as Record<string, unknown> | undefined;
  const escalation = flat.fallback;
  if (retry !== undefined || escalation !== undefined) {
    disk.resilience ??= {};
    (disk.resilience as Record<string, unknown>).retry = {
      ...(retry ?? {}),
      ...(escalation !== undefined ? { escalation } : {}),
    };
  }
  return disk;
}

/** Disk shape under `moves` → runtime flat config. */
export function toRuntimeConfigWith(moves: readonly SectionMove[], disk: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [diskPath, runtimePath] of moves) {
    const v = getPath(disk, diskPath);
    if (v !== undefined) setPath(flat, runtimePath, v);
  }
  const diskRetry = getPath(disk, 'resilience.retry');
  if (diskRetry && typeof diskRetry === 'object') {
    const { escalation, ...retryRest } = diskRetry as Record<string, unknown>;
    if (Object.keys(retryRest).length > 0) flat.retry = retryRest;
    if (escalation !== undefined) flat.fallback = escalation;
  }
  return flat;
}

const ESCALATION_DISK_PREFIX = 'resilience.retry.escalation';
const RETRY_DISK_PREFIX = 'resilience.retry';

/**
 * Translate a DISK field path under `moves` into the RUNTIME flat field path
 * — used by the YAML comment annotator, whose comment table is keyed by
 * runtime paths. Longest prefix wins; the retry split is special-cased
 * (disk `resilience.retry.escalation.*` ↔ runtime `fallback.*`).
 */
export function toRuntimePathWith(moves: readonly SectionMove[], diskPath: string): string {
  if (diskPath === 'schemaVersion') return '';
  if (diskPath.startsWith(ESCALATION_DISK_PREFIX)) {
    return 'fallback' + diskPath.slice(ESCALATION_DISK_PREFIX.length);
  }
  const longest: SectionMove[] = [...moves].sort((a, b) => b[0].length - a[0].length);
  for (const [disk, runtime] of longest) {
    if (diskPath === disk) return runtime;
    if (diskPath.startsWith(disk + '.')) return runtime + diskPath.slice(disk.length);
  }
  if (diskPath.startsWith(RETRY_DISK_PREFIX + '.')) {
    return 'retry' + diskPath.slice(RETRY_DISK_PREFIX.length);
  }
  return diskPath;
}
