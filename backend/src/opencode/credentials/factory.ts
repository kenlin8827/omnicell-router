import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonc, type OpenCodeAuthEntry } from '../user-config.js';
import {
  CredentialPaths,
  credentialStoreStateFile,
  defaultEnv,
  ocrCredentialsFile,
  resolveDefaultPaths,
} from './paths.js';
import { OcrStore } from './ocr-store.js';
import {
  CredentialStore,
  StoreDegradedCode,
  StoreKind,
  isStoreKind,
  StoreCapabilities,
  StoreProbeResult,
  StoreUnreadableError,
  AccountOverview,
  EmptyCredentialTableError,
  VersionEvidence,
  keyHashPrefix,
} from './types.js';
import { authSnapshot } from './auth-snapshot.js';
import { OpencodeV2Store, DbOpener, resolveServiceConfigForPaths } from './opencode-v2-store.js';

/**
 * The factory binds ONE store per boot, gated by
 * version evidence. Primary: `opencode --version` (CLI). Fallback:
 * installed.version FILE, only when the CLI is not on PATH — file existence
 * NEVER selects a store alone. Binding is sticky for the process lifetime;
 * the last-known-good decision is persisted at <ocrHome>/credential-store.json
 * with hysteresis so PATH jitter between boots cannot ping-pong the store.
 */

export type VersionProbe = () => Promise<string | null>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  accounts: AccountOverview[];
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

/** One auth.json snapshot entry processed by the Decision 4 reconcile (per-machine record). */
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
 * Completion marker for the STANDALONE landing (last
 * edge: no opencode at all → OcrStore). Fixes the regression where
 * the console kept writing auth.json while the store-backed boot read
 * credentials.json — after the one-shot import the console writes go to
 * OcrStore and auth.json is superseded on this machine (see
 * reconcile.isStandaloneAuthImported for the parallel flag semantics).
 */
export interface StandaloneImportRecord {
  doneAt: number;
  entries: StandaloneImportEntryRecord[];
}

/**
 * Schema of <ocrHome>/credential-store.json. ADDITIVE: `reconcile` appears
 * only after the Decision 4 gate ran, `standaloneImport` only after the B4
 * standalone one-shot import ran; readers must tolerate both absences.
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
}

export interface BindOverrides {
  paths?: CredentialPaths;
  versionProbe?: VersionProbe;
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openDatabase?: DbOpener;
  busyAttempts?: number;
  busyBackoffMs?: number;
  /** Lazy-upgrade poll interval for a readonly-degraded bind (ms). Default 10s. */
  upgradeIntervalMs?: number;
  /** Lazy-upgrade attempt cap. Default 12 (2min at the default interval). */
  upgradeMaxAttempts?: number;
}

const VERSION_REGEX = /v?(\d+)\.(\d+)(?:\.\d+)?/;

export function parseVersionMajor(text: string | null): number | null {
  if (!text) return null;
  const m = VERSION_REGEX.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * CLI evidence: `opencode --version`. Uses node:child_process (typed, works
 * under both bun and node test runtimes; backend/src has no Bun global types
 * — same precedent as cli/daemon.ts) instead of bun.spawn; it stays async so
 * the event loop never blocks. Injectable via BindOverrides.versionProbe —
 * tests never spawn.
 */
export function probeVersionViaCli(timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('opencode', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32', // resolves opencode.cmd shims via PATH on Windows
      });
    } catch {
      done(null);
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c) => {
      out += String(c);
    });
    child.stderr?.on('data', () => undefined); // drain so the child can exit
    child.on('error', (e) => {
      console.warn(
        `[credentials] opencode CLI probe spawn error: ${e.message} ` +
          `(bunBinOnPath=${(process.env.PATH ?? '').includes('D:\\dev\\bun\\bin')} pathLen=${(process.env.PATH ?? '').length})`,
      );
      done(null);
    });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) done(out.trim());
      else {
        console.warn(
          `[credentials] opencode CLI probe failed: exit=${code} out="${out.trim().slice(0, 80)}" ` +
            `(bunBinOnPath=${(process.env.PATH ?? '').includes('D:\\dev\\bun\\bin')} pathLen=${(process.env.PATH ?? '').length})`,
        );
        done(null);
      }
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      console.warn(`[credentials] opencode CLI probe timed out after ${timeoutMs}ms`);
      done(null);
    }, timeoutMs);
    timer.unref();
  });
}

/** installed.version is evidence only when its CONTENT parses as a version (existence alone never selects a store). */
function readInstalledVersion(paths: CredentialPaths): string | null {
  try {
    const text = fs.readFileSync(paths.installedVersionPath, 'utf8').trim();
    return VERSION_REGEX.test(text) ? text : null;
  } catch {
    return null;
  }
}

function authSnapshotProviders(paths: CredentialPaths): string[] {
  try {
    const parsed = readJsonc(paths.authJsonPath);
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(
        ([, e]) =>
          Boolean(e) &&
          typeof e === 'object' &&
          (e as Record<string, unknown>).type === 'api' &&
          typeof (e as Record<string, unknown>).key === 'string' &&
          Boolean((e as Record<string, unknown>).key)
      )
      .map(([id]) => id);
  } catch {
    return []; // the snapshot is best-effort evidence for the excluded list only
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
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastError = e; // EPERM/EBUSY on Windows usually clears within a few ms
      if (attempt < 4) blockingSleep((attempt + 1) * 10);
    }
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // best-effort tmp cleanup
  }
  throw lastError;
}

/** Sync sleep on the boot write path — Atomics.wait, spin fallback. */
function blockingSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // spin — exotic runtimes without SharedArrayBuffer (bounded by ms)
    }
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
    console.warn(`[credentials] failed to persist last-known-good binding: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function safeOverview(store: CredentialStore): AccountOverview[] {
  try {
    return store.accountsOverview();
  } catch {
    return []; // probeResult carries the loud state
  }
}

function safeProbe(store: CredentialStore): StoreProbeResult | null {
  try {
    return store.probe();
  } catch (e) {
    if (e instanceof EmptyCredentialTableError) {
      return { ok: true, kind: store.kind, state: 'empty', accountCount: 0 };
    }
    if (e instanceof StoreUnreadableError) {
      return {
        ok: false,
        kind: store.kind,
        state: 'unreadable',
        degradedCode: 'db_unreadable',
        detail: e.message,
        accountCount: 0,
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
 *    (keyHash dedup against existing accounts — idempotent by construction),
 *  - oauth/wellknown entries are listed and badged, never imported as keys
 *    (OAuth boundary — a token is not an api key),
 *  - auth.json stays on disk BYTE-IDENTICAL (never delete an upstream
 *    artifact; cp-dataloss), the marker in credential-store.json records that
 *    it is superseded, and every later console credential write lands on
 *    OcrStore (the store-bound write routing + isStandaloneAuthImported gate).
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
      localHashes = new Set(store.listAccounts(providerId).map((a) => a.keyHashPrefix ?? ''));
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
 * One bind pass. Every branch lands on a store through the total wrapper
 * below (worst case OcrStore, badged when the landing is a degradation,
 * unbadged for normal standalone).
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
  const evidence: VersionEvidence = { cli: null, file: null, used: 'none', lastKnownGood: lkg?.version ?? null };
  const status: StoreStatus = {
    kind: store.kind,
    capabilities: store.capabilities,
    degradedCode: 'bind_failed',
    evidence,
    excluded: [{ provider: '*', reasonCode: 'bind_failed', detail }],
    accounts: safeOverview(store),
    probeResult: safeProbe(store),
    credentialFile: credentialFileFor(store.kind, paths),
    boundAt: Date.now(),
    detail,
  };
  writeCredentialStoreState(paths, {
    bound: store.kind,
    version: lkg?.version ?? null, // keep the hysteresis pin — a failed bind must not erase LKG
    evidence,
    degradedCode: 'bind_failed',
    updatedAt: status.boundAt,
    ...(lkg?.reconcile ? { reconcile: lkg.reconcile } : {}),
    ...(lkg?.standaloneImport ? { standaloneImport: lkg.standaloneImport } : {}),
  });
  return { store, status, excludedWithReason: status.excluded };
}

async function bindCredentialStoreOnce(overrides: BindOverrides = {}): Promise<StoreBinding> {
  const paths = overrides.paths ?? resolveDefaultPaths();
  lastBoundPaths = paths; // reconcile + the status endpoint read the state file from the bound paths
  const env = overrides.env ?? defaultEnv();
  const now = overrides.now ?? Date.now;
  const versionProbe = overrides.versionProbe ?? probeVersionViaCli;

  let cli: string | null = null;
  try {
    cli = await versionProbe();
    // Boot-contention guard: the 5s probe budget competes with catalog sync
    // / SQLite opens and can time out even when the CLI is on PATH (observed
    // on the desktop sidecar: probe timed out at bind, the SAME binary
    // succeeded post-boot). One delayed retry closes that race. A truly
    // absent CLI fails the spawn fast, so the retry costs it ~2.5s only.
    if (!cli) {
      console.warn(
        '[credentials] CLI probe empty at bind — retrying once after 2500ms (boot-contention guard)',
      );
      await (overrides.sleep ?? defaultSleep)(2500);
      cli = await versionProbe();
    }
  } catch {
    cli = null; // a broken probe is evidence-free, same as "not on PATH"
  }
  const fileVersion = readInstalledVersion(paths);
  const lkg = readCredentialStoreState(paths);
  const lkgMajor = parseVersionMajor(lkg?.version ?? null);

  let effective: string | null;
  let used: VersionEvidence['used'];
  if (cli) {
    effective = cli;
    used = 'cli';
  } else if (fileVersion) {
    effective = fileVersion;
    used = 'installed.version';
  } else if (lkg && lkgMajor !== null) {
    // Hysteresis (Decision 2): live evidence absent but a persisted versioned
    // binding exists -> keep the degraded landing consistent with the
    // persisted evidence; PATH jitter must not ping-pong the store.
    effective = lkg.version;
    used = 'last-known-good';
  } else if (fs.existsSync(paths.opencodeDbPath)) {
    // "CLI absent + db present" — the db file IS the opencode evidence.
    effective = null;
    used = 'db-present';
  } else {
    effective = null;
    used = 'none';
  }

  const evidence: VersionEvidence = { cli, file: fileVersion, used, lastKnownGood: lkg?.version ?? null };
  const major = parseVersionMajor(effective);
  const isV2 = used === 'db-present' || (major !== null && major >= 2);

  let store: CredentialStore;
  let degradedCode: StoreDegradedCode | null = null;
  let excluded: ExcludedCredential[] = [];
  let detail: string | undefined;
  let standaloneImport: StandaloneImportRecord | undefined;

  if (isV2) {
    const writable = used === 'cli'; // CLI evidence => the opencode v2 service API may be written
    try {
      store = await OpencodeV2Store.create({
        paths,
        writable,
        fetchImpl: overrides.fetchImpl,
        env,
        now,
        sleep: overrides.sleep,
        openDatabase: overrides.openDatabase,
        busyAttempts: overrides.busyAttempts,
        busyBackoffMs: overrides.busyBackoffMs,
      });
      if (!writable) degradedCode = 'cli_absent_db_present';
      excluded = safeOverview(store)
        .filter((a) => a.total > 0 && a.routable === 0)
        .map((a) => ({
          provider: a.providerId,
          reasonCode: 'no_routable_credential' as const,
          detail: 'credential rows exist but none is routable (oauth/unknown value shape)',
        }));
      // Security P2-1 surfacing: a non-loopback service target is flagged on
      // the badge detail (https = allowed + flagged; plaintext http = writes
      // refused with insecure_remote_target). resolveServiceConfigForPaths
      // warns LOUD on both; reads unaffected either way.
      const svc = resolveServiceConfigForPaths(paths, env);
      if (svc && svc.targetPolicy !== 'loopback') {
        detail =
          svc.targetPolicy === 'remote_tls'
            ? `remote opencode v2 service over https (${svc.baseUrl}) — allowed, flagged by policy`
            : `remote opencode v2 service over plaintext HTTP (${svc.baseUrl}) — credential writes REFUSED (insecure_remote_target)`;
      }
    } catch (e) {
      if (!(e instanceof StoreUnreadableError)) throw e;
      // falling back from an opencode v2 machine to the
      // auth.json snapshot as a live store is FORBIDDEN. On such a machine
      // auth.json is by definition a stale one-time migration snapshot — serving
      // keys from it would silently route old credentials. Land loudly on
      // OcrStore with a badge instead.
      store = new OcrStore({ paths, now });
      degradedCode = 'db_unreadable';
      detail = e.message;
      const covered = new Set(safeOverview(store).map((a) => a.providerId));
      excluded = authSnapshotProviders(paths)
        .filter((p) => !covered.has(p))
        .map((p) => ({
          provider: p,
          reasonCode: 'db_unreadable' as const,
          detail: 'opencode v2 credential db unreadable; key present in auth.json snapshot — may exist in opencode db only',
        }));
    }
  } else if (major !== null) {
    // opencode v1 detected — NOT SUPPORTED. auth.json on
    // such a machine is not a truth OCR may read on every request. Land on OcrStore
    // with a loud badge, and import the snapshot ONCE so keys that were routing
    // before do not go silent without a visible reason.
    const unsupported = new OcrStore({ paths, now });
    store = unsupported;
    degradedCode = 'unsupported_version';
    detail = `opencode ${effective ?? 'v1'} is not supported — OCR requires opencode v2; credentials are managed in the OCR store`;
    if (lkg?.standaloneImport?.doneAt) {
      standaloneImport = lkg.standaloneImport;
    } else {
      const imported = await runStandaloneImport(unsupported, paths, now);
      standaloneImport = imported.record;
      excluded = imported.excluded;
    }
  } else {
    // No opencode at all — OcrStore unbadged: the normal standalone shape.
    const ocr = new OcrStore({ paths, now });
    // B4 one-shot standalone import (idempotent via the persisted marker).
    if (lkg?.standaloneImport?.doneAt) {
      standaloneImport = lkg.standaloneImport;
    } else {
      const imported = await runStandaloneImport(ocr, paths, now);
      standaloneImport = imported.record;
      excluded = imported.excluded;
    }
    store = ocr;
  }

  const status: StoreStatus = {
    kind: store.kind,
    capabilities: store.capabilities,
    degradedCode,
    evidence,
    excluded,
    accounts: safeOverview(store),
    probeResult: safeProbe(store),
    credentialFile: credentialFileFor(store.kind, paths),
    boundAt: now(),
    ...(detail !== undefined ? { detail } : {}),
  };
  // Bind write-through preserves the marker blocks (additive schema) — the
  // one-shot records must survive every subsequent rebind.
  writeCredentialStoreState(paths, {
    bound: store.kind,
    version: effective,
    evidence,
    degradedCode,
    updatedAt: status.boundAt,
    ...(lkg?.reconcile ? { reconcile: lkg.reconcile } : {}),
    ...(standaloneImport ? { standaloneImport } : {}),
  });

  return { store, status, excludedWithReason: excluded };
}

// ---------------------------------------------------------------------------
// Sticky process-level binding (Decision 2: re-probe happens at next boot).
// ---------------------------------------------------------------------------

let currentBinding: Promise<StoreBinding> | null = null;
let testOverrides: BindOverrides = {};
let lastBoundPaths: CredentialPaths | null = null;
let upgradeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Lazy upgrade for a readonly-degraded bind: the CLI probe can time out at
 * boot (Defender first-execution scans block the spawn for 20s+ on the
 * desktop sidecar) even though the CLI is on PATH. Routing works fine on the
 * readonly store, so instead of blocking boot we re-probe in the background
 * and re-bind (upgrading kind to opencode-v2) once the probe succeeds.
 * Single-flight: armed once per degraded bind, cleared on upgrade/cap.
 */
function maybeScheduleUpgrade(binding: StoreBinding, overrides: BindOverrides): void {
  if (upgradeTimer !== null) return; // a poll loop is already running
  if (binding.status.degradedCode !== 'cli_absent_db_present') return;
  const intervalMs = overrides.upgradeIntervalMs ?? 10_000;
  const maxAttempts = overrides.upgradeMaxAttempts ?? 60;
  let attempts = 0;
  const tick = async (): Promise<void> => {
    upgradeTimer = null;
    attempts += 1;
    if (attempts > maxAttempts) return;
    currentBinding = null; // drop the degraded binding; re-bind for fresh evidence
    try {
      const fresh = await ensureBinding();
      if (fresh.status.degradedCode === null) {
        console.log(
          `[credentials] opencode CLI available again — store upgraded to ${fresh.status.kind} (attempt ${attempts})`,
        );
        return; // upgraded: stop polling
      }
    } catch {
      // re-bind failed — keep polling until the cap
    }
    upgradeTimer = setTimeout(() => void tick(), intervalMs);
  };
  upgradeTimer = setTimeout(() => void tick(), intervalMs);
}

/** The CredentialPaths the most recent bind used (state-file readers: reconcile, status endpoint). */
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
    // Scheduler hook — two-arg form: a REJECTING bind must not surface an
    // unhandled rejection through this derived promise; the scheduler only
    // acts on successful (degraded-but-total) binds.
    void pending.then(
      (b) => maybeScheduleUpgrade(b, testOverrides),
      () => undefined,
    );
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
 * The Decision 2 push endpoint reuses them so a process-wide fetch/db seam
 * (tests) or env (service discovery) applies to the FRESH OpencodeV2Store it builds,
 * not just to the boot-bound store.
 */
export function getBindTestOverrides(): BindOverrides {
  return testOverrides;
}

/**
 * Test seam: clears the sticky cache and injects the whole world (sandboxed
 * CredentialPaths, version evidence, fetch, sqlite opener, clock). Positional
 * core per task spec; `extra` carries the remaining BindOverrides.
 */
export function resetCredentialStoreForTests(
  paths?: CredentialPaths,
  versionProbe?: VersionProbe,
  fetchImpl?: typeof fetch,
  extra?: BindOverrides
): void {
  currentBinding = null;
  upgradeTimer = null; // a pending lazy-upgrade loop must not leak across tests
  const overrides: BindOverrides = {
    // Default a no-op sleep so the bind-time probe-retry never costs real
    // wall time in tests; a test exercising the retry timing injects its
    // own recording sleep via extra.
    ...(extra?.sleep ? {} : { sleep: async () => {} }),
    ...extra,
  };
  if (paths) overrides.paths = paths;
  if (versionProbe) overrides.versionProbe = versionProbe;
  if (fetchImpl) overrides.fetchImpl = fetchImpl;
  testOverrides = overrides;
}
