/**
 * Migration v5 → v6 — follow-catalog auto-resync kill switch.
 *
 * schemaVersion 5 had no operator lever for whether Key/pool mutations rewrite
 * follow-mode client catalogs. v6 adds `client.autoResyncFollowCatalogs` (default
 * ON): an event-driven N-setup service keyed by clientProfileMemory.modelMode
 * and gateway modelListMode=follow — not a profile write-through (ADR-0031).
 *
 * The step MOVES NOTHING and RENAMES NOTHING: `migrate` is the identity. The
 * layout row is what makes the knob persist; bumping SCHEMA_VERSION declares
 * the layout the file was written under.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file — the
 * chain only appends. schema.ts binds SECTION_MOVES_V6 as the CURRENT layout.
 */
import { SECTION_MOVES_V5, type DiskConfigV5 } from './v4-to-v5.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/** THE v6 layout: the v5 moves plus the follow-catalog auto-resync switch. */
export const SECTION_MOVES_V6: ReadonlyArray<SectionMove> = [
  ...SECTION_MOVES_V5,
  ['client.autoResyncFollowCatalogs', 'autoResyncFollowCatalogs'],
];

/** Disk format of schemaVersion 6: v5 with the auto-resync switch available. */
export type DiskConfigV6 = DiskConfigV5 & {
  client?: DiskConfigV5['client'] & { autoResyncFollowCatalogs?: boolean };
};

export const migrationV5ToV6: Migration = {
  from: 5,
  to: 6,
  warn: [
    'schemaVersion 6 adds client.autoResyncFollowCatalogs (default true): event-driven rewrite of follow-mode client/gateway catalogs after Key modelAccess or model-pool changes',
  ],
  migrate: (raw) => ({ ...raw }) as Record<string, unknown>,
};
