import fs from 'node:fs';
import type { CredentialPaths } from './paths.js';
import { resolveOpencodeConfigPath } from './paths.js';
import { patchJsonc, PROVIDER_SLOT, readJsonc } from '../user-config.js';
import { readProviderDefsFile } from '../provider-defs.js';

export interface DefMaterializeOutcome {
  ok: boolean;
  /** provider nodes rendered into the client jsonc `providers` slot. */
  rendered: number;
  /**
   * True when the client slot actually had to be rewritten (target map differs
   * from what the client already had). Drives the reload decision: an unchanged
   * render must never cost a service reload.
   */
  changed: boolean;
  detail?: string;
}

/** Pre-sync capture of the operator's client config (refreshed on every change). */
const CLIENT_BACKUP_SUFFIX = '.bak.ocr-defs';

/**
 * Does the client's `providers` slot differ from the defs book?
 *
 * The ONE comparison in the codebase: `materializeDefs` decides whether to
 * write with it, and the sync status view decides the `defsDrift` badge with it,
 * so the badge can never disagree with what a push would do. Order-sensitive by
 * intent — the defs file is the order truth (the console grid renders in its
 * sequence), so an order change IS a change.
 */
export function defsRenderChanged(
  clientNodes: unknown,
  providers: Record<string, unknown>
): boolean {
  return JSON.stringify(clientNodes ?? null) !== JSON.stringify(providers);
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
 * the render. The pre-sync file is kept as `<config><.bak.ocr-defs>`.
 *
 * Failure doctrine: an unparsable client jsonc is REFUSED, never clobbered
 * (we could not preserve what we cannot parse); a MISSING defs book is refused
 * too when the client slot holds nodes — "absent" is not "empty", and REPLACE
 * over an unreadable book would delete client defs we cannot reproduce. A
 * genuinely empty (but valid) defs book still REPLACEs: that is def delete
 * propagation. A missing jsonc is created — that is the point of the write.
 */
export function materializeDefs(paths: CredentialPaths, configPathOverride?: string): DefMaterializeOutcome {
  const configPath = configPathOverride ?? resolveOpencodeConfigPath(paths);
  const clientConfig = fs.existsSync(configPath) ? readJsonc(configPath) : undefined;
  if (fs.existsSync(configPath) && clientConfig === undefined) {
    return {
      ok: false,
      rendered: 0,
      changed: false,
      detail: `opencode.jsonc unparsable — refusing to materialize (never clobber what cannot be parsed): ${configPath}`,
    };
  }
  const clientSlot = clientConfig?.[PROVIDER_SLOT];
  const clientNodes = clientSlot && typeof clientSlot === 'object' && !Array.isArray(clientSlot) ? clientSlot : undefined;

  const file = readProviderDefsFile(paths);
  if (!file) {
    // Missing / corrupt / wrong-version defs book. Distinguishing this from
    // `providers: {}` is the whole guard: REPLACE over an unreadable book
    // would silently delete every provider node in the client config.
    const existingNodes = clientNodes ? Object.keys(clientNodes).length : 0;
    if (existingNodes > 0) {
      return {
        ok: false,
        rendered: 0,
        changed: false,
        detail: `provider defs file missing or unreadable — refusing to REPLACE ${existingNodes} client provider node(s): ${configPath}`,
      };
    }
    return { ok: true, rendered: 0, changed: false }; // nothing to render, nothing to destroy
  }

  const providers = file.providers;
  const rendered = Object.keys(providers).length;
  const changed = defsRenderChanged(clientNodes, providers);
  if (!changed) return { ok: true, rendered, changed: false };
  // Refresh the pre-sync copy on EVERY change (the CLI setup backup doctrine):
  // a stale first-capture .bak would be useless for the wipe the operator
  // actually needs to undo. Best-effort — a backup failure never blocks the
  // converge (the defs book is the truth and is still intact on disk).
  try {
    fs.copyFileSync(configPath, `${configPath}${CLIENT_BACKUP_SUFFIX}`);
    // copyFileSync lands the copy with umask defaults (0644 on POSIX) — the
    // backup can carry secret-bearing headers, so it is restricted to the
    // owner like the auth-side backup. Best-effort (Windows chmod advisory).
    fs.chmodSync(`${configPath}${CLIENT_BACKUP_SUFFIX}`, 0o600);
  } catch {
    // missing client file (first write) / unreadable — nothing to preserve
  }
  try {
    patchJsonc(configPath, [PROVIDER_SLOT], providers);
    return { ok: true, rendered, changed: true };
  } catch (e) {
    return {
      ok: false,
      rendered: 0,
      changed: false,
      detail: `opencode.jsonc materialization write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
