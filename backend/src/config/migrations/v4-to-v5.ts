/**
 * Migration v4 → v5 (ADR-0008) — body admission becomes operator-tunable.
 *
 * schemaVersion 4 hard-wired the request-body ceilings to the constants in
 * `config/defaults.ts`: nothing on either HTTP plane read config for admission,
 * so an operator who needed a bigger cap (a 40 MB agent upload) or a smaller one
 * (a memory-constrained box) had no lever — and, worse, no way to *see* the
 * number the gateway would answer with short of triggering a 413. v5 adds
 * `client.bodyLimits`, the disk home for the two per-plane caps.
 *
 * The step MOVES NOTHING and RENAMES NOTHING: `migrate` is the identity, exactly
 * like the v3→v4 layout row. It exists because the layout tables are frozen
 * per version and `toDiskConfigWith` / `toRuntimeConfigWith` iterate ONLY the
 * rows of the bound table — a new disk path that is not a row is silently dropped
 * in both directions (never persisted, never loaded, and therefore never able to
 * re-persist). Appending the row here is what makes the knob real; bumping
 * `SCHEMA_VERSION` is what makes a saved file declare the layout it was written
 * under. No v4 key disappears, so a v4 file keeps every value it had.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file — the chain
 * v0→…→v4→v5→… only appends. schema.ts binds `SECTION_MOVES_V5` as the CURRENT
 * layout (see LATEST_LAYOUT there) — bump that pointer when v6 ships.
 */
import { SECTION_MOVES_V4, type DiskConfigV4 } from './v3-to-v4.js';
import type { BodyLimitsConfig } from '../types.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/** THE v5 layout: the v4 moves plus the new admission-cap section. */
export const SECTION_MOVES_V5: ReadonlyArray<SectionMove> = [
  ...SECTION_MOVES_V4,
  ['client.bodyLimits', 'bodyLimits'],
];

/** Disk format of schemaVersion 5: v4 with `client.bodyLimits` available. */
export type DiskConfigV5 = DiskConfigV4 & {
  client?: DiskConfigV4['client'] & { bodyLimits?: BodyLimitsConfig };
};

export const migrationV4ToV5: Migration = {
  from: 4,
  to: 5,
  warn: [
    'schemaVersion 5 adds client.bodyLimits (maxBytes | adminMaxBytes): the request-body admission caps per HTTP plane, previously fixed constants (ADR-0008)',
  ],
  // Nothing moved, so nothing to rewrite. The identity is deliberate: reading the
  // tree to "helpfully" materialise `client: {}` on files that never had a
  // `client` section would add noise the writer does not need (the section is
  // created on the first real save) and break the migrate-idempotence contract
  // the migration tests pin.
  migrate: (raw) => ({ ...raw }) as Record<string, unknown>,
};
