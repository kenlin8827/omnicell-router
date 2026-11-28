/**
 * Migration v6 → v7 — the retired selection vocabulary becomes the
 * industry-standard trio.
 *
 * v6 could store three strategies: `priority`, `weighted` (a weighted RANDOM
 * draw) and `round_robin` (a rotating table of `weight` CONSECUTIVE slots per
 * member — bursty weighted rotation, not equal turns). v7 replaces that
 * vocabulary (ADR-0003): `weighted_round_robin` is smooth weighted round-robin
 * and `round_robin` is PLAIN equal rotation with weights ignored.
 *
 * Both v6 weighting mechanisms therefore become `weighted_round_robin`, which
 * preserves the operator's declared weight proportions while smoothing the
 * order:
 *   - `weighted`    → `weighted_round_robin` (random draw → deterministic
 *                     weighted rotation, the requested replacement);
 *   - `round_robin` → `weighted_round_robin` (the old value WAS weighted, so
 *                     letting it keep its name would silently turn a 3:1 pool
 *                     into 1:1; with every weight at 1 the smooth core
 *                     degenerates to exactly the old equal rotation).
 * `priority` is untouched. A v6 file cannot carry the v7 meaning of
 * `round_robin`, so this step consumes every occurrence of it; the new
 * equal-turn strategy is an explicit post-upgrade choice.
 *
 * The step rewrites ONLY an existing `selection` value under
 * `routing.tiers.<tier>` and `routing.combos[]`. It never creates a section the
 * file did not carry, and it leaves unknown spellings alone — value cleaning
 * stays in loadConfig; migrations move shapes/vocabulary, never enforce
 * semantics (the same contract as v3→v4's `modelMode: none → default`).
 *
 * The layout is unchanged (no section moved), so `SECTION_MOVES_V7` is the v6
 * table verbatim — derived, never re-declared, so the frozen tables stay the
 * single source.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file — the
 * chain v0→…→v6→v7→… only appends. schema.ts binds `SECTION_MOVES_V7` as the
 * CURRENT layout (see LATEST_LAYOUT there) — bump that pointer when v8 ships.
 */
import { SECTION_MOVES_V6, type DiskConfigV6 } from './v5-to-v6.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/** THE v7 layout: identical to v6 (the section paths did not move). */
export const SECTION_MOVES_V7: ReadonlyArray<SectionMove> = SECTION_MOVES_V6;

/** Disk format of schemaVersion 7: v6 with the weighted selection values folded into `weighted_round_robin`. */
export type DiskConfigV7 = DiskConfigV6;

/** Plain-object guard for the hand-edited YAML this step must tolerate. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const LEGACY_WEIGHTED = 'weighted';
const LEGACY_ROUND_ROBIN = 'round_robin';
const WEIGHTED_ROUND_ROBIN = 'weighted_round_robin';

/** The v6 selection values that meant "serve by weight" — both become the smooth rotation. */
function mapsToWeightedRotation(value: unknown): boolean {
  return value === LEGACY_WEIGHTED || value === LEGACY_ROUND_ROBIN;
}

export const migrationV6ToV7: Migration = {
  from: 6,
  to: 7,
  warn: [
    'selection strategies `weighted` (weighted random) and `round_robin` (bursty weighted slots) both became `weighted_round_robin` (smooth weighted round-robin); `priority` is unchanged, and the new equal-turn `round_robin` is an explicit choice after upgrade',
  ],
  migrate: (raw) => {
    const disk = { ...raw } as Record<string, unknown>;
    const routing = disk.routing;
    if (!isPlainObject(routing)) return disk;

    let changed = false;

    // Tier policies: routing.tiers.<lite|plus|pro|ultra>.selection — `exclude`
    // is an array and is skipped by the plain-object guard.
    let nextTiers: Record<string, unknown> | undefined;
    const tiers = routing.tiers;
    if (isPlainObject(tiers)) {
      nextTiers = { ...tiers };
      for (const [tier, entry] of Object.entries(tiers)) {
        if (!isPlainObject(entry) || !mapsToWeightedRotation(entry.selection)) continue;
        nextTiers[tier] = { ...entry, selection: WEIGHTED_ROUND_ROBIN };
        changed = true;
      }
    }

    // Combos: routing.combos[].selection (array order preserved).
    let nextCombos: unknown[] | undefined;
    const combos = routing.combos;
    if (Array.isArray(combos)) {
      nextCombos = combos.map((entry) => {
        if (!isPlainObject(entry) || !mapsToWeightedRotation(entry.selection)) return entry;
        changed = true;
        return { ...entry, selection: WEIGHTED_ROUND_ROBIN };
      });
    }

    if (!changed) return disk;
    disk.routing = {
      ...routing,
      ...(nextTiers ? { tiers: nextTiers } : {}),
      ...(nextCombos ? { combos: nextCombos } : {}),
    };
    return disk;
  },
};
