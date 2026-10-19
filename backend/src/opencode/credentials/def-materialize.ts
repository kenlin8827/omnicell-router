import fs from 'node:fs';
import path from 'node:path';
import type { CredentialPaths } from './paths.js';
import { patchJsonc, PROVIDER_SLOT, readJsonc } from '../user-config.js';
import { readProviderDefsFile } from '../provider-defs.js';

export interface DefMaterializeOutcome {
  ok: boolean;
  /** provider nodes rendered into the client jsonc `providers` slot. */
  rendered: number;
  detail?: string;
}

/**
 * Materialize the OCR defs file into the opencode client's config — the def
 * half of the v2 sync client's write direction (the key half lives in sync.ts).
 *
 * REPLACE semantics: the defs file's `providers` map REPLACES the whole jsonc
 * `providers` node VERBATIM — an identity render, never re-shaped through the
 * def builder (fields the builder does not know would be silently dropped; the
 * defs file already stores the v2 file spelling). Comment-preserving text-level
 * edit: comments OUTSIDE the slot survive; comments inside the slot die with
 * the render.
 *
 * Failure doctrine: an unparsable client jsonc is REFUSED, never clobbered
 * (we could not preserve what we cannot parse); a missing jsonc is created —
 * that is the point of the write.
 */
export function materializeDefs(paths: CredentialPaths, configPathOverride?: string): DefMaterializeOutcome {
  const providers = readProviderDefsFile(paths)?.providers ?? {};
  const configPath = configPathOverride ?? path.join(paths.configDir, 'opencode.jsonc');
  if (fs.existsSync(configPath)) {
    if (readJsonc(configPath) === undefined) {
      return {
        ok: false,
        rendered: 0,
        detail: `opencode.jsonc unparsable — refusing to materialize (never clobber what cannot be parsed): ${configPath}`,
      };
    }
  }
  try {
    patchJsonc(configPath, [PROVIDER_SLOT], providers);
    return { ok: true, rendered: Object.keys(providers).length };
  } catch (e) {
    return {
      ok: false,
      rendered: 0,
      detail: `opencode.jsonc materialization write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
