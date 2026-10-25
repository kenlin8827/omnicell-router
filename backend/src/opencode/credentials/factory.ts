import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_DEFS_IMPORT_VERSION, importProviderDefsAtBoot, type ProviderDefsImportMarker } from '../provider-defs.js';
import type { OpenCodeAuthEntry } from './auth-snapshot.js';
import {
  CredentialPaths,
  credentialStoreStateFile,
  ocrCredentialsFile,
  resolveDefaultPaths,
} from './paths.js';
import { OcrStore } from './ocr-store.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import {
  CredentialStore,
  StoreDegradedCode,
  StoreKind,
  isStoreKind,
  StoreCapabilities,
  StoreProbeResult,
  StoreUnreadableError,
  CredentialOverview,
  EmptyCredentialTableError,
  VersionEvidence,
  keyHashPrefix,
} from './types.js';
import { authSnapshot } from './auth-snapshot.js';
import type { DbOpener } from './opencode-v2-store.js';

/**
 * The factory binds ONE store per boot — always the OcrStore
 * (<ocrHome>/credentials.json). OCR owns its credential truth and never
 * anchors on opencode: the opencode v2 db/CLI are a SYNC CLIENT's territory
 * (credentials/sync.ts), not a store-selection input. Binding is sticky for
 * the process lifetime; the binding record at <ocrHome>/credential-store.json
 * keeps the standalone-import marker so auth.json is imported exactly once.
 */

/** Evidence the bind records for diagnostics only — it selects nothing. */
export type VersionProbe = () => Promise<string | null>;

export interface ExcludedCredential {
  provider: string;
  /** machine-readable code (touchpoint gap #8) — the frontend renders i18n text. */
  reasonCode: 'db_unreadable' | 'no_routable_credential' | 'reconcile_push_failed' | 'bind_failed';
  detail: string;
}

/** The shape B2 (console endpoint) and B4 (badge UI) must consume. */
export interface StoreStatus {
  kind: StoreKind;
  capabilities: StoreCapabilities;
  /** null = bound cleanly (incl. unbadged standalone landing on OcrStore). */
  degradedCode: StoreDegradedCode | null;
  evidence: VersionEvidence;
  excluded: ExcludedCredential[];
  /** Masked per-provider summary — never raw keys. */
  credentials: CredentialOverview[];
  probeResult: StoreProbeResult | null;
  /** The file/db the bound store actually addresses (console display). */
  credentialFile: string;
  boundAt: number;
  detail?: string;
}

export interface StoreBinding {
  store: CredentialStore;
  status: StoreStatus;
  /** Same array as status.excluded, returned separately for boot consumers. */
  excludedWithReason: ExcludedCredential[];
}

/** One auth.json snapshot entry processed by the retired reconcile gate (legacy audit shape). */
export interface ReconcileEntryRecord {
  provider: string;
  action: 'pushed' | 'deduped' | 'failed';
  reason?: string;
}

/** Completion marker + audit trail inside credential-store.json. */
export interface CredentialStoreStateReconcile {
  doneAt: number;
  /** true = the auth.json write path is permanently disabled on this machine (B4 gates on it). */
  authWriteDisabled: boolean;
  entries: ReconcileEntryRecord[];
}

/** One auth.json entry processed by the standalone one-shot import. */
export interface StandaloneImportEntryRecord {
  provider: string;
  /**
   * 'imported'   — type:'api' key copied into <ocrHome>/credentials.json
   * 'deduped'    — same keyHash already present locally (idempotent rerun)
   * 'skipped_oauth'/'skipped_wellknown' — listed and badged, NEVER imported
   * as a key (a token is not an api key).
   * 'failed'     — local write failed; the key stays in auth.json, loudly.
   */
  action: 'imported' | 'deduped' | 'skipped_oauth' | 'skipped_wellknown' | 'failed';
  reason?: string;
}

/**
 * Completion marker for the standalone auth.json one-shot import: after it
 * runs, every console credential write lands on OcrStore and auth.json is
 * superseded on this machine — the OCR file is the only truth read or
 * written.
 */
export interface StandaloneImportRecord {
  doneAt: number;
  entries: StandaloneImportEntryRecord[];
}

/**
 * Schema of <ocrHome>/credential-store.json. ADDITIVE: `reconcile` appears
 * only after the Decision 4 gate ran, `standaloneImport` only after the B4
 * standalone one-shot import ran, `providerDefsImport` only after the jsonc
 * provider import ran; readers must tolerate all absences.
 * B4/F1 consume this shape (bind evidence + hysteresis + markers).
 */
export interface CredentialStoreState {
  bound: StoreKind;
  version: string | null;
  evidence: VersionEvidence;
  degradedCode: StoreDegradedCode | null;
  updatedAt: number;
  reconcile?: CredentialStoreStateReconcile;
  standaloneImport?: StandaloneImportRecord;
  providerDefsImport?: ProviderDefsImportMarker;
}

export interface BindOverrides {
  paths?: CredentialPaths;
  /** Retired: store selection is gone; accepted for signature compatibility, never read. */
  versionProbe?: VersionProbe;
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Retired: the bind no longer sleeps (no CLI probe retry). */
  sleep?: (ms: number) => Promise<void>;
  /** sqlite opener seam — consumed by the sync engine's transient v2 store. */
  openDatabase?: DbOpener;
  /** Retired v2-store-open retry knobs (the bind no longer opens any db). */
  busyAttempts?: number;
  busyBackoffMs?: number;
  /** Retired lazy-upgrade poll knobs (there is no degraded v2 bind to upgrade). */
  upgradeIntervalMs?: number;
  upgradeMaxAttempts?: number;
}

const VERSION_REGEX = /v?(\d+)\.(\d+)(?:\.\d+)?/;

/** installed.version is recorded as diagnostic evidence only (it selects nothing). */
function readInstalledVersion(paths: CredentialPaths): string | null {
  try {
    const text = fs.readFileSync(paths.installedVersionPath, 'utf8').trim();
    return VERSION_REGEX.test(text) ? text : null;
  } catch {
    return null;
  }
}

/** Read the persisted state file (additive schema — readers tolerate a missing reconcile block). */
export function readCredentialStoreState(paths: CredentialPaths = resolveDefaultPaths()): CredentialStoreState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialStoreStateFile(paths), 'utf8'));
    // Fail-closed on an unknown `bound`: no state (re-bind from live evidence next
    // boot) beats a garbage kind leaking into switches and capability branches.
    if (!parsed || typeof parsed !== 'object' || !isStoreKind(parsed.bound)) return null;
    return parsed as CredentialStoreState;
  } catch {
    return null;
  }
}

/**
 * Atomic temp+rename with a bounded retry + blocking backoff: Windows
 * AV/indexers can hold a just-created file long enough to fail the rename
 * with EPERM, and a lost reconcile marker means Decision 4's gate silently
 * never persisted. Retry waits attempt*10ms (blocking — callers are sync fs
 * paths on boot); the CROSS-PROCESS lock remains an accepted risk (P3
 * backlog: two OCR processes racing this file is uncoordinated by design).
 * Exported for direct testing of the retry-sleep path.
 */
export function atomicWriteWithRetry(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    renameWithRetry(tmp, file);
    return;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort tmp cleanup
    }
    throw e;
  }
}

/**
 * Write-through of every persisted state update (no secrets in this file —
 * evidence + reconcile audit trail only). The reconcile marker lives here
 * too; callers merge, never clobber.
 */
export function writeCredentialStoreState(paths: CredentialPaths, rec: CredentialStoreState): void {
  const file = credentialStoreStateFile(paths);
  try {
    atomicWriteWithRetry(file, `${JSON.stringify(rec, null, 2)}\n`);
  } catch (e) {
    // persistence is best-effort — hysteresis degrades to "no LKG", the bind itself is unaffected
    console.warn(`[credentials] failed to persist the binding record: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function safeOverview(store: CredentialStore): CredentialOverview[] {
  try {
    return store.credentialsOverview();
  } catch {
    return []; // probeResult carries the loud state
  }
}

function safeProbe(store: CredentialStore): StoreProbeResult | null {
  try {
    return store.probe();
  } catch (e) {
    if (e instanceof EmptyCredentialTableError) {
      return { ok: true, kind: store.kind, state: 'empty', credentialCount: 0 };
    }
    if (e instanceof StoreUnreadableError) {
      return {
        ok: false,
        kind: store.kind,
        state: 'unreadable',
        degradedCode: 'db_unreadable',
        detail: e.message,
        credentialCount: 0,
      };
    }
    return null;
  }
}

function credentialFileFor(kind: StoreKind, paths: CredentialPaths): string {
  switch (kind) {
    case 'opencode-v2':
    case 'opencode-v2-readonly':
      return paths.opencodeDbPath;
    case 'ocr':
      return ocrCredentialsFile(paths);
  }
}

interface StandaloneImportOutcome {
  /** undefined = no import ran (auth.json absent/empty/unreadable) — no marker, retry next boot. */
  record?: StandaloneImportRecord;
  excluded: ExcludedCredential[];
}

/**
 * Standalone one-shot import ('no opencode at all'
 * landing + the fix for the console-write regression):
 * the machine's credentials.json is the truth, but an operator who used OCR
 * before the store flip may hold keys ONLY in auth.json. At bind time, when
 * no completion marker exists and auth.json has entries:
 *  - type:'api' entries are imported into <ocrHome>/credentials.json
 *    (keyHash dedup against existing credentials — idempotent by construction),
 *  - oauth/wellknown entries are listed and badged, never imported as keys
 *    (OAuth boundary — a token is not an api key),
 *  - auth.json stays on disk BYTE-IDENTICAL (never delete an upstream
 *    artifact; cp-dataloss), the marker in credential-store.json records that
 *    it is superseded, and every later console credential write lands on
 *    OcrStore.
 * Total function: never throws — a crash leaves no marker (next boot retries)
 * and the bind itself stands.
 */
async function runStandaloneImport(
  store: OcrStore,
  paths: CredentialPaths,
  now: () => number
): Promise<StandaloneImportOutcome> {
  let snapshot: Record<string, OpenCodeAuthEntry>;
  try {
    // Injected-path bridge READ (the exported helpers hardcode the operator
    // auth.json location); the import never writes auth.json.
    snapshot = authSnapshot(paths).read();
  } catch (e) {
    console.warn(
      `[credentials] standalone auth.json unreadable — import deferred to next boot: ${e instanceof Error ? e.message : String(e)}`
    );
    return { excluded: [] };
  }
  const providers = Object.entries(snapshot).filter(([, entry]) => Boolean(entry) && typeof entry === 'object');
  if (providers.length === 0) return { excluded: [] }; // nothing to converge — no marker

  const entries: StandaloneImportEntryRecord[] = [];
  const excluded: ExcludedCredential[] = [];
  for (const [providerId, entry] of providers) {
    const type = entry.type;
    if (type === 'oauth' || type === 'wellknown') {
      entries.push({ provider: providerId, action: type === 'oauth' ? 'skipped_oauth' : 'skipped_wellknown' });
      excluded.push({
        provider: providerId,
        reasonCode: 'no_routable_credential',
        detail: `auth.json '${type}' entry listed, never imported as a key (OAuth boundary)`,
      });
      continue;
    }
    if (type !== 'api' || typeof entry.key !== 'string' || !entry.key) {
      // P2-10: malformed entries are LOUD — recorded action:'failed' with the
      // reason and the marker is withheld below (aligns with corrupt-file
      // retry semantics: retried next boot; keyHash dedup prevents double
      // import of the good keys). A silent continue stranded them invisible.
      const reason = `unusable auth.json entry (type=${String(type)}, key=${typeof entry.key === 'string' ? 'empty' : 'missing'})`;
      entries.push({ provider: providerId, action: 'failed', reason });
      excluded.push({ provider: providerId, reasonCode: 'no_routable_credential', detail: reason });
      continue;
    }
    // P2-10b: the docstring promises totality — a hostile local credentials
    // file (unreadable mid-import) must land as a failed entry + retry next
    // boot, not reject the whole bind through this "total" helper.
    let localHashes: Set<string>;
    try {
      localHashes = new Set(store.listCredentials(providerId).map((a) => a.keyHashPrefix ?? ''));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      entries.push({ provider: providerId, action: 'failed', reason: `local store unreadable: ${msg}` });
      excluded.push({
        provider: providerId,
        reasonCode: 'reconcile_push_failed',
        detail: `standalone import could not read the local store, key remains only in auth.json: ${msg}`,
      });
      continue;
    }
    if (localHashes.has(keyHashPrefix(entry.key))) {
      entries.push({ provider: providerId, action: 'deduped' });
      continue;
    }
    try {
      await store.connectKey(providerId, entry.key);
      entries.push({ provider: providerId, action: 'imported' });
    } catch (e) {
      // Loud, never silent: reads now come from the store, so a stranded key
      // must surface as an exclusion with the same push-failure vocabulary.
      const msg = e instanceof Error ? e.message : String(e);
      entries.push({ provider: providerId, action: 'failed', reason: msg });
      excluded.push({
        provider: providerId,
        reasonCode: 'reconcile_push_failed',
        detail: `standalone import write failed, key remains only in auth.json: ${msg}`,
      });
    }
  }
  // Any failed entry WITHHOLDS the marker: the import reruns next boot (good
  // keys dedup). A recorded-only success marker would freeze the stranding.
  const hasFailed = entries.some((e) => e.action === 'failed');
  console.log(
    `[credentials] standalone import: ${entries.length} auth.json entries processed into OcrStore${
      hasFailed ? ' — failures present, marker withheld, retried at next boot' : ''
    }`
  );
  return hasFailed ? { excluded } : { record: { doneAt: now(), entries }, excluded };
}

/**
 * One bind pass: ALWAYS the OcrStore. The standalone auth.json one-shot
 * import runs here regardless of opencode presence — on a machine with a v2
 * db, the SYNC subsystem's own migration (credentials/sync.ts) pulls the db's
 * CURRENT keys, while auth.json-era leftovers land through this import. Both
 * are marker-gated and keyHash-dedup idempotent. Every branch lands through
 * the total wrapper below (worst case OcrStore, badged bind_failed).
 */
export async function bindCredentialStore(overrides: BindOverrides = {}): Promise<StoreBinding> {
  try {
    return await bindCredentialStoreOnce(overrides);
  } catch (e) {
    // P1-2 (never-silent violation): a REJECTED bind used to stick forever —
    // ensureBinding cached the rejected promise, boot's catch could not
    // rescue it, buildDirectPool rethrew into the standalone registry (0
    // providers), and every console credential route + status badge 500'd
    // for the process lifetime. An unexpected error now lands on OcrStore
    // with the machine-readable 'bind_failed' badge. Never reject.
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[credentials] unexpected bind failure — landing on OcrStore, badged bind_failed: ${msg}`);
    return bindFailureLanding(overrides, msg);
  }
}

/** The badged OcrStore landing for an unexpected bind crash (see wrapper). */
function bindFailureLanding(overrides: BindOverrides, detail: string): StoreBinding {
  const paths = overrides.paths ?? resolveDefaultPaths();
  // The injected clock/paths may BE the throwing dependency — rely on
  // Date.now only here, and preserve every persisted marker block.
  const store = new OcrStore({ paths });
  const lkg = readCredentialStoreState(paths);
  const evidence: VersionEvidence = { cli: null, file: null, used: 'none', lastKnownGood: null };
  const status: StoreStatus = {
    kind: store.kind,
    capabilities: store.capabilities,
    degradedCode: 'bind_failed',
    evidence,
    excluded: [{ provider: '*', reasonCode: 'bind_failed', detail }],
    credentials: safeOverview(store),
    probeResult: safeProbe(store),
    credentialFile: credentialFileFor(store.kind, paths),
    boundAt: Date.now(),
    detail,
  };
  writeCredentialStoreState(paths, {
    bound: store.kind,
    version: lkg?.version ?? null,
    evidence,
    degradedCode: 'bind_failed',
    updatedAt: status.boundAt,
    ...(lkg?.reconcile ? { reconcile: lkg.reconcile } : {}),
    ...(lkg?.standaloneImport ? { standaloneImport: lkg.standaloneImport } : {}),
    ...(lkg?.providerDefsImport ? { providerDefsImport: lkg.providerDefsImport } : {}),
  });
  return { store, status, excludedWithReason: status.excluded };
}

async function bindCredentialStoreOnce(overrides: BindOverrides = {}): Promise<StoreBinding> {
  const paths = overrides.paths ?? resolveDefaultPaths();
  lastBoundPaths = paths; // the sync engine + status endpoint read state files from the bound paths
  const now = overrides.now ?? Date.now;

  const ocr = new OcrStore({ paths, now });
  const fileVersion = readInstalledVersion(paths);
  const evidence: VersionEvidence = {
    cli: null,
    file: fileVersion,
    used: fileVersion ? 'installed.version' : 'none',
    lastKnownGood: null,
  };

  // B4 one-shot standalone import (idempotent via the persisted marker).
  const lkg = readCredentialStoreState(paths);
  let standaloneImport: StandaloneImportRecord | undefined;
  let excluded: ExcludedCredential[] = [];
  if (lkg?.standaloneImport?.doneAt) {
    standaloneImport = lkg.standaloneImport;
  } else {
    const imported = await runStandaloneImport(ocr, paths, now);
    standaloneImport = imported.record;
    excluded = imported.excluded;
  }

  // One-shot client→OCR provider import (marker-gated, same ledger pattern). The
  // marker carries the IMPORTER VERSION: a record written by an older importer
  // (or none) is STALE and the import runs again, which is how new sources (the
  // legacy singular `provider` slot, retired node shapes) reach installs whose
  // first import already fired. undefined = retry next boot (unparsable source /
  // write failure) — no NEW marker; the stale record is carried through
  // unchanged so the ledger still shows the last completed pass.
  let providerDefsImport: ProviderDefsImportMarker | undefined;
  if (lkg?.providerDefsImport?.doneAt && lkg.providerDefsImport.version === PROVIDER_DEFS_IMPORT_VERSION) {
    providerDefsImport = lkg.providerDefsImport;
  } else {
    providerDefsImport = importProviderDefsAtBoot({ paths, now }) ?? lkg?.providerDefsImport;
  }

  // Unification doctrine: every store-backed provider owns a defs node, and
  // that node IS the routing universe (an empty node routes nothing — the
  // catalog is a source, never a fallback pool; ADR-0010 amendment). Node
  // creation ONLY here, and BARE: no catalog lookup — the bind must never wait
  // on the aggregation (a real list() fetches remote sources and can hang the
  // boot); name/npm/baseURL ride in on the first connect via
  // ensureConnectedProviderBook, which is also the only place auto-fill
  // (a network operation) happens. A legacy row therefore needs a pull or a
  // re-connect before it serves models again.
  //
  // Every path here is the INJECTED `paths` (never a fresh resolveDefaultPaths),
  // so a sandboxed bind writes its own book.
  try {
    const { upsertProviderDef } = await import('../user-config.js');
    const { readProviderDefsFile } = await import('../provider-defs.js');
    // RAW file check, NOT getProviderNodeById: the normalized view DROPS
    // retired-shape nodes (Decision 9) — a raw check is the only way to avoid
    // "resurrecting" one as a fresh routable node (and it strictly subsumes the
    // normalized one: the view is a filter over this same map). A retired node
    // keeps its boot exclusion (loud, operator migrates it deliberately).
    const rawNodes = readProviderDefsFile(paths)?.providers ?? {};
    for (const overview of safeOverview(ocr)) {
      if (overview.total === 0 || rawNodes[overview.providerId]) continue;
      const up = upsertProviderDef({ id: overview.providerId }, paths);
      if (!up.success) {
        // A persistent write failure (permissions, full disk) silently leaves
        // store-backed providers node-less — say so instead of swallowing it.
        console.warn(`[credentials] provider-def node for '${overview.providerId}' not created: ${up.error ?? 'unknown error'}`);
      }
    }
  } catch (e) {
    // best-effort — a missing node is repaired on the next connect
    console.warn(`[credentials] provider-def node sweep skipped: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Non-routable rows are loud (oauth/unknown shapes hold no api key).
  if (excluded.length === 0) {
    excluded = safeOverview(ocr)
      .filter((a) => a.total > 0 && a.routable === 0)
      .map((a) => ({
        provider: a.providerId,
        reasonCode: 'no_routable_credential' as const,
        detail: 'credential rows exist but none is routable (oauth/unknown value shape)',
      }));
  }

  const status: StoreStatus = {
    kind: ocr.kind,
    capabilities: ocr.capabilities,
    degradedCode: null,
    evidence,
    excluded,
    credentials: safeOverview(ocr),
    probeResult: safeProbe(ocr),
    credentialFile: credentialFileFor(ocr.kind, paths),
    boundAt: now(),
  };
  // Bind write-through preserves the marker blocks (additive schema) — the
  // one-shot records must survive every subsequent rebind.
  writeCredentialStoreState(paths, {
    bound: ocr.kind,
    version: fileVersion,
    evidence,
    degradedCode: null,
    updatedAt: status.boundAt,
    ...(lkg?.reconcile ? { reconcile: lkg.reconcile } : {}),
    ...(standaloneImport ? { standaloneImport } : {}),
    ...(providerDefsImport ? { providerDefsImport } : {}),
  });

  return { store: ocr, status, excludedWithReason: excluded };
}

// ---------------------------------------------------------------------------
// Sticky process-level binding (re-bind happens only via the test seam).
// ---------------------------------------------------------------------------

let currentBinding: Promise<StoreBinding> | null = null;
let testOverrides: BindOverrides = {};
let lastBoundPaths: CredentialPaths | null = null;

/** The CredentialPaths the most recent bind used (state-file readers: sync engine, status endpoint). */
export function getBoundCredentialPaths(): CredentialPaths | null {
  return lastBoundPaths;
}

function ensureBinding(): Promise<StoreBinding> {
  if (!currentBinding) {
    const pending = bindCredentialStore(testOverrides);
    currentBinding = pending;
    // P1-2 (a): bindCredentialStore is total now, but a rejection must NEVER
    // stick — reset the cache so the next call retries instead of serving one
    // boot failure to every console route and the status badge forever.
    void pending.catch(() => {
      if (currentBinding === pending) currentBinding = null;
    });
  }
  return currentBinding;
}

export function getCredentialStore(): Promise<CredentialStore> {
  return ensureBinding().then((b) => b.store);
}

export function getCredentialStoreStatus(): Promise<StoreStatus> {
  return ensureBinding().then((b) => b.status);
}

/**
 * The overrides the current binding was built with (production: mostly {}).
 * The sync endpoints reuse them so a process-wide fetch/db seam (tests) or
 * env (service discovery) applies to the transient OpencodeV2Store the sync
 * engine builds, not just to the boot-bound store.
 */
export function getBindTestOverrides(): BindOverrides {
  return testOverrides;
}

/**
 * Test seam: clears the sticky cache and injects the whole world (sandboxed
 * CredentialPaths, fetch, sqlite opener, clock). `versionProbe` is an
 * accepted-and-IGNORED legacy positional — store selection is gone; the
 * signature survives so existing call sites keep compiling.
 */
export function resetCredentialStoreForTests(
  paths?: CredentialPaths,
  _versionProbe?: VersionProbe,
  fetchImpl?: typeof fetch,
  extra?: BindOverrides
): void {
  currentBinding = null;
  const overrides: BindOverrides = { ...extra };
  if (paths) overrides.paths = paths;
  if (fetchImpl) overrides.fetchImpl = fetchImpl;
  testOverrides = overrides;
}
