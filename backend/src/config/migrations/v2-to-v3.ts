/**
 * Migration v2 → v3 (ADR-0008 §1) — the streaming posture becomes two axes.
 *
 * schemaVersion 2 carried one flag, `upstream.streaming.enabled`, which
 * conflated two independent questions. v3 splits them:
 *   `upstream.streaming.client.mode`   — the response SHAPE written to the
 *                                         caller: allow | deny | always;
 *   `upstream.streaming.upstream.mode` — the provider-leg transport:
 *                                         follow | stream | buffered.
 *
 * The step reads the retired flag and writes its exact behavioral equivalent,
 * then drops the key so it can never re-persist:
 *   `enabled: false` → `upstream.mode: buffered` (never use the upstream SSE
 *   reader — the old rollback lever, byte-for-byte the old behavior);
 *   `enabled: true` / absent → nothing (v3 defaults are `client: allow` +
 *   `upstream: follow`, which IS what `enabled: true` meant).
 *
 * The layout table is unchanged (the section still lives at
 * `upstream.streaming`), so `SECTION_MOVES_V3` is the v2 table verbatim —
 * derived, never re-declared, so the frozen tables stay the single source.
 *
 * FROZEN after release: later schema versions MUST NOT edit this file —
 * the chain v0→v1→v2→v3→… only appends. schema.ts binds
 * `SECTION_MOVES_V3` as the CURRENT layout (see LATEST_LAYOUT there) — bump
 * that pointer when v4 ships.
 */
import { SECTION_MOVES_V2, type DiskConfigV2 } from './v1-to-v2.js';
import type { SectionMove } from '../layout.js';
import type { Migration } from '../schema.js';

/** THE v3 layout: identical to v2 (the section path did not move). */
export const SECTION_MOVES_V3: ReadonlyArray<SectionMove> = SECTION_MOVES_V2;

/** Disk format of schemaVersion 3: v2 with the retired streaming flag rewritten. */
export type DiskConfigV3 = DiskConfigV2;

/** Plain-object guard for the hand-edited YAML this step must tolerate. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const migrationV2ToV3: Migration = {
  from: 2,
  to: 3,
  warn: [
    'streaming.client.mode (allow | deny | always) is the response shape sent to the caller; streaming.upstream.mode (follow | stream | buffered) is how the provider leg is called — two independent axes now',
    'the retired upstream.streaming.enabled:false was rewritten to streaming.upstream.mode: buffered (same behavior) and removed from the file',
  ],
  migrate: (raw) => {
    const disk = { ...raw } as Record<string, unknown>;
    // Touch the tree only when it exists — a junk input must migrate to the
    // same minimal skeleton as before this step shipped.
    const upstream = disk.upstream;
    if (!isPlainObject(upstream)) return disk;
    const streaming = upstream.streaming;
    if (!isPlainObject(streaming)) return disk;
    const nextStreaming: Record<string, unknown> = { ...streaming };
    const hadFlag = Object.prototype.hasOwnProperty.call(nextStreaming, 'enabled');
    const wasEnabled = nextStreaming.enabled;
    delete nextStreaming.enabled;
    if (hadFlag && wasEnabled === false) {
      const nextUpstream = isPlainObject(nextStreaming.upstream) ? { ...nextStreaming.upstream } : {};
      // `buffered` is the value the flag meant; anything an operator already
      // wrote at the new path is newer intent and therefore wins.
      if (!Object.prototype.hasOwnProperty.call(nextUpstream, 'mode')) nextUpstream.mode = 'buffered';
      nextStreaming.upstream = nextUpstream;
    }
    disk.upstream = { ...upstream, streaming: nextStreaming };
    return disk;
  },
};
