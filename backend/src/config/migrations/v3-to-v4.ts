/**
 * Migration v3 → v4 — the client-form memory value `none` becomes `default`.
 *
 * `routing.profileMemory.<client>.modelMode` is CONSOLE FORM MEMORY (UI-only,
 * never routed): it records which model-list tab was applied at the last
 * setup. Its `none` member always rendered as the console's "Default" tab —
 * no concrete models are added and the adapter's own virtual-entry block
 * applies — so the stored spelling read as "no models", the exact opposite of
 * what it meant. v4 renames the VALUE to `default`; the field, the shape and
 * every other member are untouched.
 *
 * The step rewrites ONLY an existing `modelMode: 'none'` value. It never
 * creates `routing` / `profileMemory` / an entry that the file did not carry
 * (a junk input must migrate to the same minimal skeleton as before this step
 * shipped), and it leaves unknown spellings alone — value cleaning stays in
 * loadConfig, migrations move shapes/vocabulary, never enforce semantics.
 *
 * The layout is unchanged (no section moved), so `SECTION_MOVES_V4` is the v3
 * table verbatim — derived, never re-declared, so the frozen tables stay the
 * single source.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file —
 * the chain v0→v1→v2→v3→v4→… only appends. schema.ts binds
 * `SECTION_MOVES_V4` as the CURRENT layout (see LATEST_LAYOUT there) — bump
 * that pointer when v5 ships.
 */
import { SECTION_MOVES_V3, type DiskConfigV3 } from './v2-to-v3.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/** THE v4 layout: identical to v3 (the section path did not move). */
export const SECTION_MOVES_V4: ReadonlyArray<SectionMove> = SECTION_MOVES_V3;

/** Disk format of schemaVersion 4: v3 with one enum value renamed. */
export type DiskConfigV4 = DiskConfigV3;

/** Plain-object guard for the hand-edited YAML this step must tolerate. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const migrationV3ToV4: Migration = {
  from: 3,
  to: 4,
  warn: [
    'console form memory modelMode: none was renamed to default (the tab always meant "Default": no concrete models are added and the adapter’s virtual-entry block applies)',
  ],
  migrate: (raw) => {
    const disk = { ...raw } as Record<string, unknown>;
    const routing = disk.routing;
    if (!isPlainObject(routing)) return disk;
    const profileMemory = routing.profileMemory;
    if (!isPlainObject(profileMemory)) return disk;

    let changed = false;
    const nextMemory: Record<string, unknown> = { ...profileMemory };
    for (const [client, entry] of Object.entries(profileMemory)) {
      if (!isPlainObject(entry) || entry.modelMode !== 'none') continue;
      nextMemory[client] = { ...entry, modelMode: 'default' };
      changed = true;
    }
    if (!changed) return disk;
    disk.routing = { ...routing, profileMemory: nextMemory };
    return disk;
  },
};
