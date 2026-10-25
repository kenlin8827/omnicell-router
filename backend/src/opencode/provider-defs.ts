import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_ID_RULE, isValidProviderId, readJsonc } from './user-config.js';
import { resolveDefaultPaths, resolveOpencodeConfigPath, type CredentialPaths } from './credentials/paths.js';
import { detectClientFlavor, type OpencodeFlavor } from './credentials/paths.js';
import { providerDefAdapter } from './provider-def-adapters.js';
import { renameWithRetry } from '../utils/atomic-write.js';

/**
 * OCR-owned provider definitions — <ocrHome>/providers.json.
 *
 * Contract: connection defs (id/name/package/settings/headers/env/canonical/body/models)
 * have ONE truth and it is THIS file, GLOBAL (not per-environment, same book as
 * credentials.json). opencode.jsonc is a sync-client materialization target:
 * after the one-shot import below, nothing here reads it for truth, and no
 * console route, boot path or view may treat it as a def source.
 *
 * There is NO provider class system: EVERY provider — built-in (connected via
 * the catalog) or self-declared relay — gets a node here at connect time, with
 * its model list auto-filled (live /v1/models first, static catalog fallback).
 * The "custom" badge is DYNAMIC (derived from builtin-catalog coverage at
 * aggregation time), never stored.
 *
 * The node shape is the client's `providers` slot spelling (the opencode v2
 * package/settings form) copied as-is. This module stores and migrates; it does
 * not reinterpret — consumers keep using the user-config.ts normalizer.
 */

export interface ProviderDefsFile {
  version: 1;
  updated: number;
  /** Verbatim v2-shaped provider nodes, keyed by provider id. */
  providers: Record<string, any>;
}

/**
 * Ledger entry written after a completed boot import (persisted in
 * credential-store.json). `version` gates the import: a marker written by an
 * older importer (or none) is STALE and the import runs again — that is how an
 * existing install picks up newly-supported sources (the legacy singular
 * `provider` slot, retired node shapes). Counts stay display-safe.
 */
export interface ProviderDefsImportMarker {
  doneAt: number;
  imported: number;
  version?: number;
  converted?: number;
  skipped?: number;
  failed?: number;
}

/** Bump when the import learns a new source or a new shape conversion. */
export const PROVIDER_DEFS_IMPORT_VERSION = 2;

/** One provider node the client config offered to the import. */
export interface ProviderImportEntry {
  provider: string;
  /** imported/converted = written to providers.json; skipped/failed = not written. */
  action: 'imported' | 'converted' | 'skipped' | 'failed';
  /** Which client flavor's defs the node came from. */
  source?: OpencodeFlavor;
  reason?: string;
}

/** Outcome of one provider import pass over the client config. */
export interface ProviderImportResult {
  /** false when at least one node failed (the rest may still have been written). */
  ok: boolean;
  /** Nothing was recorded (unreadable config / write failure) — retry on next boot. */
  retryOnNextBoot: boolean;
  configPath: string;
  imported: number;
  converted: number;
  skipped: number;
  failed: number;
  entries: ProviderImportEntry[];
  detail?: string;
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
  renameWithRetry(tmp, file);
  defsMutationHook?.(); // defs changed → the sync engine's debounced auto-write converges clients
}

/** Boot seam: the sync engine registers its auto-write debounce here (null = detached). */
let defsMutationHook: (() => void) | null = null;

export function setProviderDefsMutationHook(hook: (() => void) | null): void {
  defsMutationHook = hook;
}

/**
 * The client→OCR provider import — the ONE motion that ever reads defs off the
 * client.
 *
 * Why it exists: opencode configs are hand-editable (that is how a one-off relay
 * lands there), but the defs truth is one-way — the materializer REPLACEs the
 * canonical slot from `<ocrHome>/providers.json`, and no other path reads client
 * defs back. Without this import a hand-written node either gets wiped by the
 * next push or lives outside OCR forever.
 *
 * Flavor-owned spelling — the same dispatch the credential sync clients use. The
 * caller's client id (the sync client being run) OR this machine's detected
 * flavor (`credentials/paths.ts`) selects the adapter (`provider-def-adapters.ts`),
 * which owns the slot key AND the node shape:
 *  - opencode-v2 → `providers` (`package`/`settings`, verbatim);
 *  - opencode-v1 → `provider` (`npm`/`options`, translated by its adapter).
 * Exactly one adapter runs per pass, so an id can only be seen once and the
 * retired spelling of the other flavor is never read.
 *
 * Add-only: an id already in the defs file is SKIPPED, never overwritten — once
 * imported, the OCR file is the truth, so a re-run (the marker-version re-arm)
 * can never reset an operator's edit.
 *
 * The client file is READ ONLY here (cp-dataloss: never delete another tool's
 * artifact, and never let a def read flow back as a write).
 */
export function importProviderDefsFromClient(
  opts: { paths?: CredentialPaths; flavor?: OpencodeFlavor; onlyProvider?: string } = {}
): ProviderImportResult {
  const paths = opts.paths ?? resolveDefaultPaths();
  // The SAME resolver the materializer writes through: the import must read the
  // client config the sync client will later converge, never a sibling file.
  const configPath = resolveOpencodeConfigPath(paths);
  const empty = (extra: Partial<ProviderImportResult>): ProviderImportResult => ({
    ok: true,
    retryOnNextBoot: false,
    configPath,
    imported: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    entries: [],
    ...extra,
  });

  if (!fs.existsSync(configPath)) return empty({});

  const parsed = readJsonc(configPath);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) {
    return empty({
      ok: false,
      retryOnNextBoot: true,
      detail: `client config unparsable — import skipped (never clobber what cannot be read): ${configPath}`,
    });
  }

  const existing = { ...(readProviderDefsFile(paths)?.providers ?? {}) };
  const entries: ProviderImportResult['entries'] = [];
  let imported = 0;
  let converted = 0;
  let skipped = 0;
  let failed = 0;

  const adapter = providerDefAdapter(opts.flavor ?? detectClientFlavor(paths));
  const only = opts.onlyProvider?.toLowerCase();
  const slot = parsed[adapter.slot];

  if (typeof slot === 'object' && slot !== null && !Array.isArray(slot)) {
    for (const [id, rawNode] of Object.entries(slot as Record<string, unknown>)) {
      // A provider-narrowed gesture must not sweep the whole book — and must not
      // report anything about ids it was not asked about either.
      if (only && id.toLowerCase() !== only) continue;
      if (!isValidProviderId(id)) {
        entries.push({ provider: id, action: 'failed', source: adapter.flavor, reason: `invalid provider id — ${PROVIDER_ID_RULE}` });
        failed += 1;
        continue;
      }
      if (typeof rawNode !== 'object' || rawNode === null || Array.isArray(rawNode)) {
        entries.push({ provider: id, action: 'failed', source: adapter.flavor, reason: 'node is not an object' });
        failed += 1;
        continue;
      }
      if (existing[id] !== undefined) {
        entries.push({
          provider: id,
          action: 'skipped',
          source: adapter.flavor,
          reason: 'already defined in the OCR defs file — edit it there (the OCR file is the truth)',
        });
        skipped += 1;
        continue;
      }

      const read = adapter.read(id, rawNode as Record<string, any>);
      if (read.error || !read.node) {
        entries.push({
          provider: id,
          action: 'failed',
          source: adapter.flavor,
          reason: `node could not be read as ${adapter.flavor} defs: ${read.error ?? 'empty node'}`,
        });
        failed += 1;
        continue;
      }
      existing[id] = read.node;
      if (read.converted) {
        entries.push({
          provider: id,
          action: 'converted',
          source: adapter.flavor,
          reason: `translated ${adapter.flavor} node shape → package/settings`,
        });
        imported += 1;
        converted += 1;
      } else {
        entries.push({ provider: id, action: 'imported', source: adapter.flavor });
        imported += 1;
      }
    }
  }

  if (imported > 0) {
    try {
      // Single atomic write; `writeProviderDefs` fires the defs mutation hook,
      // so an auto-write-enabled client converges without a second gesture.
      writeProviderDefs(existing, paths);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return empty({
        ok: false,
        retryOnNextBoot: true,
        entries: [{ provider: '*', action: 'failed', reason: `providers.json write failed: ${msg}` }],
        failed: 1,
        detail: msg,
      });
    }
  }

  return { ...empty({}), ok: failed === 0, imported, converted, skipped, failed, entries };
}

/**
 * Boot-time import (marker-gated by the credential factory).
 *
 * Returns the ledger marker, or undefined when the pass must be retried
 * (unparsable client config / defs write failure) — no new marker, loud warn,
 * retried next boot. An absent config or empty slots completes with imported: 0.
 */
export function importProviderDefsAtBoot(
  opts: { paths?: CredentialPaths; now?: () => number } = {}
): ProviderDefsImportMarker | undefined {
  const now = opts.now ?? Date.now;
  const outcome = importProviderDefsFromClient({ paths: opts.paths });
  if (outcome.retryOnNextBoot) {
    console.warn(`[provider-defs] provider import deferred to next boot: ${outcome.detail}`);
    return undefined;
  }
  if (outcome.failed > 0) {
    console.warn(
      `[provider-defs] provider import: ${outcome.imported} imported, ${outcome.skipped} skipped, ${outcome.failed} failed — ` +
        outcome.entries
          .filter((e) => e.action === 'failed')
          .map((e) => `${e.provider} (${e.reason})`)
          .join('; ')
    );
  }
  return {
    doneAt: now(),
    imported: outcome.imported,
    version: PROVIDER_DEFS_IMPORT_VERSION,
    converted: outcome.converted,
    skipped: outcome.skipped,
    failed: outcome.failed,
  };
}
