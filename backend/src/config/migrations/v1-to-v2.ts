/**
 * Migration v1 → v2 (ADR-0031) — retires the model-profile mechanism.
 *
 * The model profile (a named slot→modelRef table mass-assigned to hooked
 * clients' agents, with write-through on profile save) is removed whole:
 * zero adoption in the field, its only irreplaceable value (cross-client
 * batch rebinding) never materialized, and the tier aliases + the clients
 * page's direct per-agent rows + smart-assign already cover the workflow.
 * The step:
 *   1. drops `routing.modelProfiles` (a v1-only section; never a routing
 *      target, so nothing observable changes at request time);
 *   2. strips the stale profile-link bookkeeping (`profile` / `bindings`
 *      keys) from every `routing.profileMemory` entry — the entry keeps the
 *      still-live form-memory fields (models / agentModels / extraModels /
 *      virtualModels / modelMode / apiKeyId / linksOn);
 *   3. removes the `routing.modelProfiles` row from the layout table, so the
 *      retired key can never re-persist (same vanish-on-migrate contract as
 *      the v0 retired surfaces).
 *
 * FROZEN after release: later schema versions MUST NOT edit this file —
 * the chain v0→v1→v2→… only appends. schema.ts binds `SECTION_MOVES_V2`
 * as the CURRENT layout (see LATEST_LAYOUT there) — bump that pointer when
 * v3 ships.
 */
import type { ClientProfileMemoryEntry } from '../types.js';
import { SECTION_MOVES_V1, type DiskConfigV1 } from './v0-to-v1.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/**
 * THE v2 layout: the v1 moves minus the retired `routing.modelProfiles`
 * row. Derived (not re-declared) so the frozen v1 table stays the single
 * source for everything v2 did not touch.
 */
export const SECTION_MOVES_V2: ReadonlyArray<SectionMove> = SECTION_MOVES_V1.filter(
  ([diskPath]) => diskPath !== 'routing.modelProfiles'
);

/** Disk format of schemaVersion 2: v1 minus the retired model-profile section. */
export type DiskConfigV2 = Omit<DiskConfigV1, 'routing'> & {
  routing?: Omit<NonNullable<DiskConfigV1['routing']>, 'modelProfiles'>;
};

/** Strip a profile-memory entry down to the still-live form-memory fields. */
function cleanMemoryEntry(entry: unknown): ClientProfileMemoryEntry {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const { profile: _profile, bindings: _bindings, ...rest } = entry as Record<string, unknown>;
  return rest as ClientProfileMemoryEntry;
}

export const migrationV1ToV2: Migration = {
  from: 1,
  to: 2,
  warn: [
    'the model-profile mechanism is removed: routing.modelProfiles is dropped and the /model-profiles console page is gone — per-agent model assignment on the clients page (direct rows + smart-assign) is unaffected',
    'stale profile-link bookkeeping (profile/bindings keys) is stripped from routing.profileMemory entries',
  ],
  migrate: (raw) => {
    const disk = { ...raw } as Record<string, unknown>;
    // Touch the routing group only when it exists — a junk input must
    // migrate to the same minimal skeleton as before this step shipped.
    const src = disk.routing;
    if (src === null || typeof src !== 'object' || Array.isArray(src)) return disk;
    const routing = { ...(src as Record<string, unknown>) };
    delete routing.modelProfiles;
    const memory = routing.profileMemory;
    if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
      routing.profileMemory = Object.fromEntries(
        Object.entries(memory as Record<string, unknown>).map(([client, entry]) => [
          client,
          cleanMemoryEntry(entry),
        ])
      );
    }
    disk.routing = routing;
    return disk;
  },
};
