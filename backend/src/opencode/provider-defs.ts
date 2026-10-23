import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_SLOT, readJsonc } from './user-config.js';
import { resolveDefaultPaths, resolveOpencodeConfigPath, type CredentialPaths } from './credentials/paths.js';

/**
 * OCR-owned provider definitions — <ocrHome>/providers.json.
 *
 * Contract: connection defs (id/name/package/settings/headers/env/canonical/body/models)
 * have ONE truth and it is THIS file, GLOBAL (not per-environment, same book as
 * credentials.json). opencode.jsonc is a sync-client materialization target:
 * after the one-shot port below, nothing here reads it for truth, and no console
 * route, boot path or view may treat it as a def source.
 *
 * There is NO provider class system: EVERY provider — built-in (connected via
 * the catalog) or self-declared relay — gets a node here at connect time, with
 * its model list auto-filled (live /v1/models first, static catalog fallback).
 * The "custom" badge is DYNAMIC (derived from builtin-catalog coverage at
 * aggregation time), never stored.
 *
 * The node shape is the verbatim port of the jsonc `providers` slot (the opencode
 * v2 file spelling). This module stores and migrates; it does not reinterpret —
 * consumers keep using the user-config.ts normalizer.
 */

export interface ProviderDefsFile {
  version: 1;
  updated: number;
  /** Verbatim v2-shaped provider nodes, keyed by provider id. */
  providers: Record<string, any>;
}

/** Completion record of the one-shot jsonc port (persisted in credential-store.json). */
export interface ProviderDefsImportRecord {
  doneAt: number;
  imported: number;
}

export function getProviderDefsPath(paths: CredentialPaths = resolveDefaultPaths()): string {
  return path.join(paths.ocrHome, 'providers.json');
}

/**
 * CatalogModel → models.dev FILE-shaped model def (the defs-file `models` slot
 * spelling). CatalogModel already is the OpenCode schema — strip id/source,
 * pass the rest through; flat catalog npm becomes the model-level
 * `provider: { npm }` override so added models keep their exact wire shape.
 */
export function catalogModelToDef(m: Record<string, any>): Record<string, any> {
  const def: Record<string, any> = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'id' || k === 'source') continue;
    if (v === undefined) continue;
    if (k === 'npm') {
      def.provider = { ...(def.provider || {}), npm: v };
      continue;
    }
    def[k] = v;
  }
  // Name fallback: bare /v1/models payloads carry no name — derive it from
  // the last '/' segment of the id (e.g. 'zhipu/glm-4.7' → 'glm-4.7').
  if (!def.name) def.name = String(m.id).split('/').pop();
  return def;
}

/** Tolerant read: missing / corrupt / wrong version → null. */
export function readProviderDefsFile(paths: CredentialPaths = resolveDefaultPaths()): ProviderDefsFile | null {
  try {
    const file = getProviderDefsPath(paths);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.providers !== 'object' || parsed.providers === null) {
      return null;
    }
    return parsed as ProviderDefsFile;
  } catch {
    return null;
  }
}

/** Atomic merge-write of the node map (temp + rename). Throws — callers decide loudness. */
export function writeProviderDefs(
  providers: Record<string, any>,
  paths: CredentialPaths = resolveDefaultPaths()
): void {
  const file = getProviderDefsPath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next: ProviderDefsFile = { version: 1, updated: Date.now(), providers };
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  defsMutationHook?.(); // defs changed → the sync engine's debounced auto-write converges clients
}

/** Boot seam: the sync engine registers its auto-write debounce here (null = detached). */
let defsMutationHook: (() => void) | null = null;

export function setProviderDefsMutationHook(hook: (() => void) | null): void {
  defsMutationHook = hook;
}

/**
 * One-shot verbatim port of the jsonc `providers` slot into the defs file.
 *
 * Returns the completion record (the boot bind persists it in the
 * credential-store.json ledger), or undefined when the pass must be DEFERRED:
 * the source file exists but is unparsable, or the defs write failed — no
 * marker, loud warn, retried next boot. An absent config or an empty slot
 * completes with imported: 0 (the port is done; later jsonc edits are client
 * materialization, never re-imported).
 *
 * Idempotent by construction: per-id whole-node upsert over the current defs
 * file. The jsonc file itself is READ ONCE here and never written.
 */
export function migrateJsoncProviderDefs(
  opts: { paths?: CredentialPaths; now?: () => number } = {}
): ProviderDefsImportRecord | undefined {
  const paths = opts.paths ?? resolveDefaultPaths();
  const now = opts.now ?? Date.now;
  // The SAME resolver the materializer writes through: the port must read the
  // client config the sync client will later converge, never a sibling file.
  const configPath = resolveOpencodeConfigPath(paths);
  let slot: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    const parsed = readJsonc(configPath);
    if (parsed === undefined) {
      console.warn(`[provider-defs] opencode.jsonc unparsable — def port deferred to next boot: ${configPath}`);
      return undefined;
    }
    const node = (parsed as Record<string, any>)[PROVIDER_SLOT];
    slot = node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, any>) : {};
  }
  const existingFile = readProviderDefsFile(paths);
  const existing = existingFile?.providers ?? {};
  const merged = { ...existing, ...slot };
  if (Object.keys(merged).length === 0 && !existingFile) {
    return { doneAt: now(), imported: 0 }; // nothing to port, nothing to create
  }
  try {
    writeProviderDefs(merged, paths);
  } catch (e) {
    console.warn(
      `[provider-defs] providers.json write failed — def port deferred to next boot: ${e instanceof Error ? e.message : String(e)}`
    );
    return undefined;
  }
  return { doneAt: now(), imported: Object.keys(slot).length };
}
