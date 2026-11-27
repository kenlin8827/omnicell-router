/**
 * Config disk-format schema evolution (ADR-0016).
 *
 * The config.yaml ON-DISK format is versioned (`schemaVersion`, first key) and
 * grouped; the RUNTIME `RouterConfig` stays FLAT (every consumer reads
 * `config.tiers`, `config.retry`, … — grouping is a disk concern only).
 *
 * FILE LAYOUT (version-specific knowledge lives in the version's file):
 *   - `migrations/v0-to-v1.ts`, `v1-to-v2.ts`, … EACH owns the COMPLETE
 *     knowledge of its target version: the layout table
 *     (`SECTION_MOVES_V<n>`), the disk type (`DiskConfigV<n>`), and the
 *     migration transform. FROZEN after release — the chain only appends.
 *   - `layout.ts`: version-agnostic mechanics (path get/set, bidirectional
 *     expansion, disk→runtime path translation for the comment annotator).
 *   - THIS file: the chain machinery only — assemble `MIGRATIONS` in order,
 *     bind the LATEST layout as the current one, and expose
 *     `migrateConfig` (strict one-step-at-a-time walk) plus the
 *     current-version writers/readers used by config/index.ts.
 *
 * Evolution rules (binding):
 *   - Upgrade walks the chain strictly one step at a time (never skipping
 *     versions); the final skeleton is the composition of all steps.
 *   - Business clamping (junk → default, ms floors, …) stays in loadConfig's
 *     value cleaners — migrations move shapes, never enforce semantics.
 *   - Writers ALWAYS emit the current version (a save upgrades the file);
 *     there is no downgrade path.
 *   - A file authored against a NEWER schema than this build refuses to load
 *     (fail-safe: defaults + one warn — the same "upgrade OCR" contract as the
 *     env-container import gate).
 */
import { legacySurfaceWarnings, migrationV0ToV1 } from './migrations/v0-to-v1.js';
import { migrationV1ToV2 } from './migrations/v1-to-v2.js';
import { migrationV2ToV3 } from './migrations/v2-to-v3.js';
import { migrationV3ToV4 } from './migrations/v3-to-v4.js';
import { migrationV4ToV5 } from './migrations/v4-to-v5.js';
import { migrationV5ToV6, SECTION_MOVES_V6, type DiskConfigV6 } from './migrations/v5-to-v6.js';
import {
  toDiskConfigWith,
  toRuntimeConfigWith,
  toRuntimePathWith,
  type SectionMove,
} from './layout.js';
import type { RouterConfig } from './types.js';

export const SCHEMA_VERSION = 6;

/** The current disk type — re-exported from the LATEST version's file. */
export type DiskConfig = DiskConfigV6;

/**
 * The CURRENT layout pointer. Bump to `SECTION_MOVES_V6` (etc.) when the
 * newest migration file ships — the single edit a new version makes here.
 */
const LATEST_LAYOUT: ReadonlyArray<SectionMove> = SECTION_MOVES_V6;

export interface Migration {
  from: number;
  to: number;
  /** Deprecation notices emitted once per process when this step runs. */
  warn: string[];
  /** Pure disk-shape transform. Frozen after release. */
  migrate: (disk: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The evolution chain — assembled IN ORDER from the per-version files.
 * v0 = a config.yaml without `schemaVersion` (every file authored before
 * ADR-0016 — the legacy FLAT runtime-shaped layout).
 */
const MIGRATIONS: ReadonlyArray<Migration> = [
  migrationV0ToV1,
  migrationV1ToV2,
  migrationV2ToV3,
  migrationV3ToV4,
  migrationV4ToV5,
  migrationV5ToV6,
];

/** Runtime flat config → current-version disk shape. */
export function toDiskConfig(flat: Partial<RouterConfig> & Record<string, unknown>): Omit<DiskConfig, 'schemaVersion'> {
  return toDiskConfigWith(LATEST_LAYOUT, flat) as Omit<DiskConfig, 'schemaVersion'>;
}

/** Current-version disk shape → runtime flat config. */
export function toRuntimeConfig(disk: DiskConfig): Record<string, unknown> {
  return toRuntimeConfigWith(LATEST_LAYOUT, disk as unknown as Record<string, unknown>);
}

/** Current-version disk field path → runtime flat field path (comment annotator). */
export function toRuntimePath(diskPath: string): string {
  return toRuntimePathWith(LATEST_LAYOUT, diskPath);
}

export interface MigrationResult {
  disk: DiskConfig;
  fromVersion: number;
  warnings: string[];
  /** File targets a newer schema than this build — refuse (fail-safe). */
  tooNew: boolean;
}

/** Parse ANY-version config object into the current disk version. */
export function migrateConfig(raw: unknown): MigrationResult {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const declared = obj.schemaVersion;
  const version = typeof declared === 'number' && Number.isInteger(declared) && declared >= 0 ? declared : 0;
  if (version > SCHEMA_VERSION) {
    return {
      disk: { schemaVersion: SCHEMA_VERSION },
      fromVersion: version,
      warnings: [],
      tooNew: true,
    };
  }
  let disk: Record<string, unknown> = { ...obj };
  const warnings: string[] = [];
  // v0-only, PRE-migration: retired hand-written surfaces vanish in the v0
  // regroup — surface them once instead of dropping silently (the v0 step
  // owns the wording).
  if (version === 0) warnings.push(...legacySurfaceWarnings(disk));
  let cur = version;
  while (cur < SCHEMA_VERSION) {
    const step = MIGRATIONS.find((m) => m.from === cur);
    if (!step) break; // unreachable for a contiguous chain; guards future gaps
    disk = step.migrate(disk);
    warnings.push(...step.warn);
    cur = step.to;
  }
  // The chain machinery owns the version stamp: each migration file returns
  // the pure layout shape for its target version.
  disk.schemaVersion = SCHEMA_VERSION;
  return { disk: disk as unknown as DiskConfig, fromVersion: version, warnings, tooNew: false };
}
