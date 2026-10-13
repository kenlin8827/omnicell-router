import fs from 'node:fs';
import path from 'node:path';
import type { OpenCodeServiceConfig } from '../connector.js';
import { maskSecret, readJsonc } from '../user-config.js';
import { CredentialPaths, defaultEnv, resolveDefaultPaths, serviceJsonCandidates } from './paths.js';
import {
  AccountMeta,
  AccountNotFoundError,
  AccountOverview,
  CapabilityUnsupportedError,
  CredentialStore,
  CredentialType,
  EmptyCredentialTableError,
  IntegrationUnmatchedError,
  RawCred,
  ResolvedCredential,
  StoreCapabilities,
  StoreKind,
  StoreProbeResult,
  StoreUnreadableError,
  WriteFailedError,
  keyHashPrefix,
  sha256KeyHash,
} from './types.js';

/**
 * OpencodeV2Store (ADR-0019 Decision 1 + 3) — reads the v2 credential table via
 * bun:sqlite READONLY (bounded busy retry), writes ONLY through the v2
 * managed-service HTTP API (raw keys are not exportable over HTTP by design;
 * the official rule "do not edit the database to manage credentials" is
 * honored: this store never issues a sqlite write).
 *
 * Fallback rule: a failed write NEVER lands in OcrStore — read-side
 * degradation gets a badge, write-side proliferation does not.
 */

// ---------------------------------------------------------------------------
// SQLite seam — structural so tests can inject fakes without bun:sqlite
// ---------------------------------------------------------------------------

export interface OpencodeV2Database {
  query(sql: string): { all(params?: unknown[]): unknown[] };
  close(): void;
}

export type DbOpener = (file: string) => Promise<OpencodeV2Database>;

/** Dynamic-import + readonly open, mirroring trace/persist.ts:53-56,190-197. */
export const defaultOpenDatabase: DbOpener = async (file) => {
  let Database: typeof import('bun:sqlite').Database;
  try {
    ({ Database } = await import('bun:sqlite'));
  } catch {
    throw new StoreUnreadableError('cannot_open', 'bun:sqlite unavailable on this runtime', file);
  }
  const db = new Database(file, { readonly: true, create: false });
  try {
    db.run('PRAGMA busy_timeout = 2000');
  } catch {
    // older sqlite builds may reject on a readonly handle — bounded retry in
    // create() still covers contention
  }
  // Structural cast: bun's Statement satisfies the narrowed query seam above.
  return db as unknown as OpencodeV2Database;
};

/** ADR-0019 Decision 3 — expected v2 schema; a missing/renamed column is a loud bind failure, never a partial read. */
const REQUIRED_COLUMNS = ['id', 'integration_id', 'label', 'value', 'active', 'time_created', 'time_updated'] as const;

// P3-13: deterministic row order (active first, newest updated first) — the
// in-memory selection still applies its own ADR Decision 3 order, but a
// stable SQL order makes ties + TTL reloads reproducible.
const SELECT_CREDENTIALS = `SELECT ${REQUIRED_COLUMNS.join(', ')} FROM credential ORDER BY active DESC, time_updated DESC`;

// ---------------------------------------------------------------------------
// WIRE ADAPTER — v2 HTTP surface (live-probed on 2.0.15; ADR Context).
//
// Every assumption about the opencode v2 service wire lives in THIS section: routes,
// request bodies, response field extraction, service.json fields. A
// point-release drift is a one-file fix here and nowhere else.
//
// Deliberately NOT used: the documented GET/POST /api/credential COLLECTION
// routes — they 404 on 2.0.15 (docs run ahead of the build).
// ---------------------------------------------------------------------------

const API = {
  /** masked per-integration connections metadata */
  integrations: () => '/api/integration',
  /** re-read config files and re-register providers — the ONLY way a running
   *  service picks up a config-declared provider (live-probed 2.0.15, 2026-10-13). */
  reload: () => '/api/location/reload',
  connectKey: (integrationId: string) => `/api/integration/${encodeURIComponent(integrationId)}/connect/key`,
  activate: (credentialId: string) => `/api/credential/${encodeURIComponent(credentialId)}/activate`,
  rename: (credentialId: string) => `/api/credential/${encodeURIComponent(credentialId)}`,
  disconnect: (credentialId: string) => `/api/credential/${encodeURIComponent(credentialId)}`,
} as const;

const BODIES = {
  connectKey: (key: string, label?: string) => ({ key, ...(label !== undefined ? { label } : {}) }),
  rename: (label: string) => ({ label }),
} as const;

// Sent secrets < 8 chars are not secrets (maskSecret already exposes 4),
// and the floor keeps short non-secret body values (labels/flags) from
// over-redacting the diagnostic limb.
const REDACT_MIN_LEN = 8;

/**
 * An upstream error response may ECHO the request body (debug-style
 * validation errors repeating the offending value). The submitted secret
 * must never re-surface through error messages: those flow into management
 * route bodies (502 error), reconcile push-failure reasons persisted to the
 * state file, push failed[].reason and log lines (ADR-0019 Decision 1 risk
 * limb: no management surface ever carries raw keys).
 * Exported: probe.ts reuses the same containment for upstream echo bodies.
 */
export function redactBodySecrets(text: string, body: unknown): string {
  if (!body || typeof body !== 'object') return text;
  let out = text;
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length >= REDACT_MIN_LEN && out.includes(v)) {
      out = out.split(v).join('[redacted]');
    }
  }
  return out;
}

/** credential row id from any plausible response wrapper (id | credential.id | data.id | result.id). */
function extractId(json: unknown): string | null {
  for (const path of [['id'], ['credential', 'id'], ['data', 'id'], ['result', 'id']] as const) {
    const v = dig(json, path);
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** integration array from any plausible response wrapper (bare array | data | integrations). */
function extractIntegrations(json: unknown): { id: string; connections: unknown[] }[] {
  const arr = Array.isArray(json) ? json : Array.isArray(dig(json, ['data'])) ? dig(json, ['data']) : dig(json, ['integrations']);
  if (!Array.isArray(arr)) return [];
  const out: { id: string; connections: unknown[] }[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== 'string' || !id) continue;
    const conns = (item as Record<string, unknown>).connections;
    out.push({ id, connections: Array.isArray(conns) ? conns : [] });
  }
  return out;
}

/** service.json fields we accept: password (Basic auth), port or baseUrl (endpoint drift). */
function readFileServiceConfig(file: string): { password?: string; url?: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or unparsable candidate — try the next one
  }
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const password = typeof rec.password === 'string' && rec.password ? rec.password : undefined;
  let url: string | undefined;
  if (typeof rec.baseUrl === 'string' && rec.baseUrl) url = rec.baseUrl;
  else if (typeof rec.port === 'number' || typeof rec.port === 'string') url = `http://127.0.0.1:${String(rec.port)}`;
  return { ...(password ? { password } : {}), ...(url ? { url } : {}) };
}

/**
 * Security P2-1 — write-target policy for the opencode v2 service endpoint. Raw keys
 * are POSTed to this URL, so a non-loopback plaintext HTTP target is refused
 * (first-boot reconcile would otherwise auto-push every auth.json key over
 * cleartext to a stale remote URL). No config knob: an explicit opt-in is
 * deliberately DEFERRED (loopback and https cover the real deployments; an
 * operator who needs plain HTTP to a remote host is a loud, rare ask that
 * deserves a designed flag, not a silent default).
 */
export type ServiceTargetPolicy = 'loopback' | 'remote_tls' | 'insecure_remote';

export interface OpencodeV2ServiceConfig extends OpenCodeServiceConfig {
  targetPolicy: ServiceTargetPolicy;
}

/** Literal loopback hosts per the security review (127.0.0.1 / localhost / ::1). */
function classifyServiceTarget(baseUrl: string): ServiceTargetPolicy {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Unparsable endpoint: fail closed for writes (reads never touch HTTP).
    return 'insecure_remote';
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return 'loopback';
  if (parsed.protocol === 'https:') return 'remote_tls';
  return 'insecure_remote';
}

/**
 * opencode v2 service discovery over INJECTED paths/env (connector.ts semantics, but
 * the password resolves from the injected candidate paths so the homedir-only
 * fallback connector.ts:27-28 is never reached — touchpoint gap #5).
 * Module-level so the Decision 2 push endpoint can re-probe reachability
 * without a store instance; OpencodeV2Store.resolveServiceConfig delegates here.
 * Returns null when no Basic-auth password exists = no reachable service.
 */
export function resolveServiceConfigForPaths(
  paths: CredentialPaths,
  env: Readonly<Record<string, string | undefined>> = defaultEnv()
): OpencodeV2ServiceConfig | null {
  let password = env.OPENCODE_SERVER_PASSWORD;
  let url = env.OPENCODE_SERVER_URL;
  if (!password || !url) {
    for (const candidate of serviceJsonCandidates(paths)) {
      const fromFile = readFileServiceConfig(candidate);
      if (!fromFile) continue;
      password = password ?? fromFile.password;
      url = url ?? fromFile.url;
      if (password) break; // first candidate holding a password wins (connector parity)
    }
  }
  if (!password) return null;
  // P2-7 (contract fix): construct the config EXPLICITLY from injected values.
  // OpenCodeConnector would fall through to the REAL process.env.OPENCODE_SERVER_URL
  // when the injected env carries no url — violating paths.ts' sole-env-read
  // contract and leaking ambient state into injected-seam resolution.
  const baseUrl = url ?? 'http://127.0.0.1:49374'; // connector.ts default (loopback)
  const targetPolicy = classifyServiceTarget(baseUrl);
  if (targetPolicy === 'remote_tls') {
    console.warn(
      `[credentials] opencode v2 service target ${baseUrl} is NON-LOOPBACK over HTTPS — allowed, flagged in StoreStatus.detail`
    );
  }
  if (targetPolicy === 'insecure_remote') {
    console.warn(
      `[credentials] opencode v2 service target ${baseUrl} is NON-LOOPBACK over PLAINTEXT HTTP — credential writes are REFUSED (insecure_remote_target); sqlite reads unaffected`
    );
  }
  return {
    baseUrl,
    authHeader: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
    password,
    targetPolicy,
  };
}
// ---------------------------------------------------------------------------
// end WIRE ADAPTER
// ---------------------------------------------------------------------------

function dig(obj: unknown, keys: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** SQLITE_BUSY / -shm contention markers — retried, NOT misclassified as unreadable (false red badge forbidden). */
function looksBusy(e: unknown): boolean {
  return /busy|locked|shm/i.test(msgOf(e));
}

interface OpencodeV2Row {
  id: string;
  integrationId: string;
  label: string | null;
  type: CredentialType;
  key?: string;
  active: boolean;
  timeUpdated: number | null;
  routable: boolean;
}

function mapValue(raw: unknown): { type: CredentialType; key?: string } {
  if (typeof raw !== 'string') return { type: 'unknown' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { type: 'unknown' };
  }
  if (!v || typeof v !== 'object') return { type: 'unknown' };
  const rec = v as Record<string, unknown>;
  if (rec.type === 'key' && typeof rec.key === 'string') return { type: 'api', key: rec.key };
  if (rec.type === 'oauth') return { type: 'oauth' };
  // {type:'key'} without a string key — malformed; listed and badged, never routed.
  return { type: 'unknown' };
}

function rowToMeta(row: OpencodeV2Row): AccountMeta {
  return {
    id: row.id,
    providerId: row.integrationId,
    ...(row.label !== null ? { label: row.label } : {}),
    type: row.type,
    active: row.active,
    routable: row.routable,
    ...(row.key ? { keyHashPrefix: keyHashPrefix(row.key), maskedKey: maskSecret(row.key) } : {}),
  };
}

function rowToRaw(row: OpencodeV2Row): RawCred {
  // routable rows always carry a key string.
  return {
    accountId: row.id,
    providerId: row.integrationId,
    ...(row.label !== null ? { label: row.label } : {}),
    key: row.key ?? '',
    keyHash: sha256KeyHash(row.key ?? ''),
    active: row.active,
    ...(row.timeUpdated !== null ? { timeUpdated: row.timeUpdated } : {}),
  };
}

export interface OpencodeV2StoreDeps {
  paths?: CredentialPaths;
  /** false constructs the OpencodeV2Store-readonly variant (CLI absent, db present). */
  writable?: boolean;
  fetchImpl?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Poll backoff seam — tests inject an instant resolve so the 30 s budget costs nothing. */
  sleep?: (ms: number) => Promise<void>;
  openDatabase?: DbOpener;
  ttlMs?: number;
  busyAttempts?: number;
  busyBackoffMs?: number;
}

/** View freshness: 60 s TTL + explicit invalidate() (pattern copied from catalog/repository.ts probeService()). */
const VIEW_TTL_MS = 60_000;

/**
 * Post-reload registry polls — upstream applies reload ASYNC (204 arrives before
 * the swap; live-caused 2026-10-13), and v2 carries a config watcher + /reload
 * by design (issue #6719, maintainer-confirmed 2026-10-01) — never a restart.
 * Timing from live probes: the POST blocks ~2.4 s SYNC before 204, then the id
 * lands ~1.7 s after. So each probe SLEEPS FIRST (a GET at +0 ms is a wasted
 * round-trip) and probes at +1 s / +3 s / +7 s — the 7 s horizon keeps headroom
 * for the swap when concurrent reloads queue behind each other on the service.
 * Healthy: heals on probe 1 (~+1 s). Truly unknown id: honest 409 + keep-def,
 * bounded by RELOAD_ROUNDS × (2.4 s sync + 7 s poll) ≈ 20 s — not a 30 s hang.
 * Tests inject `sleep` to make the schedule instant.
 */
const RELOAD_POLL_SCHEDULE_MS = [1000, 2000, 4000];
/** reload+poll rounds before the honest 409 (see resolveIntegrationId — contention cover). */
const RELOAD_ROUNDS = 2;

export class OpencodeV2Store implements CredentialStore {
  readonly kind: StoreKind;
  readonly capabilities: StoreCapabilities;

  private readonly paths: CredentialPaths;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly dbFile: string;
  private readonly ttlMs: number;
  private db: OpencodeV2Database;

  private view: Map<string, OpencodeV2Row[]> | null = null;
  private viewAt = 0;
  private integrations: { ids: string[]; at: number } | null = null;

  private constructor(deps: OpencodeV2StoreDeps, paths: CredentialPaths, db: OpencodeV2Database, private readonly writable: boolean) {
    this.paths = paths;
    this.db = db;
    this.dbFile = paths.opencodeDbPath;
    this.writable = writable;
    this.kind = writable ? 'opencode-v2' : 'opencode-v2-readonly';
    this.capabilities = {
      multiAccount: true,
      activate: writable,
      rename: writable,
      oauth: false, // ADR-0019 P2 write list excludes OAuth on every store
      envVisible: true,
      integrationScoped: true, // writes address a registered integration by id
    };
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.env = deps.env ?? defaultEnv();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ttlMs = deps.ttlMs ?? VIEW_TTL_MS;
  }

  /**
   * Open with bounded busy retry, capability-probe the `credential` columns,
   * and load the first view. "Cannot open" -> StoreUnreadableError; a
   * missing/renamed column -> StoreUnreadableError('schema_mismatch') — loud,
   * never partial. Zero rows is NOT an open failure (EmptyCredentialTableError
   * is a probe() state — a fresh v2 install is legal).
   */
  static async create(deps: OpencodeV2StoreDeps = {}): Promise<OpencodeV2Store> {
    const paths = deps.paths ?? resolveDefaultPaths();
    const opener = deps.openDatabase ?? defaultOpenDatabase;
    const attempts = Math.max(1, deps.busyAttempts ?? 4);
    const backoffMs = deps.busyBackoffMs ?? 20;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let db: OpencodeV2Database | null = null;
      try {
        db = await opener(paths.opencodeDbPath);
        probeColumns(db, paths.opencodeDbPath); // deterministic — never retried
        const store = new OpencodeV2Store(deps, paths, db, deps.writable ?? true);
        store.refreshView(); // first eager load; later loads follow the TTL
        return store;
      } catch (e) {
        try {
          db?.close();
        } catch {
          // already closed / open failed — best effort
        }
        if (e instanceof StoreUnreadableError && e.reason === 'schema_mismatch') throw e;
        lastError = e;
        const contention = looksBusy(e) || (/unable to open/i.test(msgOf(e)) && fs.existsSync(paths.opencodeDbPath));
        if (!contention) {
          throw new StoreUnreadableError('cannot_open', msgOf(e), paths.opencodeDbPath);
        }
        if (attempt < attempts && backoffMs > 0) await sleep(backoffMs * attempt);
      }
    }
    throw new StoreUnreadableError(
      'cannot_open',
      `contention (SQLITE_BUSY/-shm) still present after ${attempts} attempts: ${msgOf(lastError)}`,
      paths.opencodeDbPath
    );
  }

  probe(): StoreProbeResult {
    let view: Map<string, OpencodeV2Row[]>;
    try {
      view = this.refreshView();
    } catch (e) {
      if (e instanceof StoreUnreadableError) {
        return {
          ok: false,
          kind: this.kind,
          state: 'unreadable',
          degradedCode: 'db_unreadable',
          detail: e.message,
          accountCount: 0,
        };
      }
      throw e;
    }
    let total = 0;
    for (const rows of view.values()) total += rows.length;
    if (total === 0) {
      // Distinct from "unreadable" per ADR Decision 3 — consumers (reconcile,
      // badge logic) must handle it separately, so it is a typed throw.
      throw new EmptyCredentialTableError(this.dbFile);
    }
    return { ok: true, kind: this.kind, state: 'ready', accountCount: total };
  }

  listAccounts(providerId: string): AccountMeta[] {
    return (this.currentView().get(providerId) ?? []).map(rowToMeta);
  }

  resolveKey(providerId: string): ResolvedCredential | null {
    const rows = this.routableRows(providerId);
    if (rows.length === 0) return null;
    // ADR Decision 3 order: active=1 first, sole row next, newest time_updated last.
    const picked =
      rows.find((r) => r.active) ??
      (rows.length === 1 ? rows[0] : [...rows].sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0))[0]);
    return picked ? { key: picked.key ?? '', account: rowToMeta(picked) } : null;
  }

  resolveKeyChain(providerId: string): RawCred[] {
    const rows = this.routableRows(providerId);
    const active = rows.filter((r) => r.active);
    const rest = rows.filter((r) => !r.active).sort((a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0));
    return [...active, ...rest].map(rowToRaw);
  }

  /**
   * ADR-0019 Decision 10 — sqlite READ, so the readonly binding
   * (cli-absent-db-present) reveals too: no assertWritable here. opencode's own
   * HTTP surface cannot export keys (ADR Context); the local db read can, which
   * is exactly why the route gating this is password-first.
   */
  revealKey(accountId: string): string {
    const row = this.findRow(accountId);
    if (!row) throw new AccountNotFoundError(accountId);
    if (!row.routable || !row.key) {
      throw new CapabilityUnsupportedError('revealKey', `credential ${accountId} is type '${row.type}' — only api keys reveal`);
    }
    return row.key;
  }

  async connectKey(providerId: string, key: string, label?: string): Promise<AccountMeta> {
    this.assertWritable('connectKey');
    if (!key) throw new Error('connectKey requires a non-empty key');
    const integrationId = await this.resolveIntegrationId(providerId);
    // Baseline of existing row ids: "landed" must mean a NEW row, not an older key
    // under the same integration (second-key adds would otherwise self-verify).
    const prior = new Set((this.currentView().get(integrationId) ?? []).map((r) => r.id));
    const post = () =>
      this.callService('connectKey', (cfg) => this.http(cfg, 'POST', API.connectKey(integrationId), BODIES.connectKey(key, label)));
    const json = await post();
    this.invalidate();
    let credId = extractId(json);
    // [Fact-observed 2026-10-13, twice] the service can answer 2xx WITHOUT an id and
    // WITHOUT persisting the credential (operator zhipu4 row appeared then vanished;
    // probe e2e-store-x identical). The operator's fix was "try again" — so the CODE
    // now tries again: verify a new row landed, one retry, and never fabricate a
    // synthetic-id success for a write that did not happen.
    if (!credId) {
      let row = await this.waitForNewRow(integrationId, prior);
      if (!row) {
        const retry = await post();
        this.invalidate();
        credId = extractId(retry);
        row = await this.waitForNewRow(integrationId, prior);
      }
      if (!credId && !row) {
        throw new WriteFailedError('connectKey', `credential_not_landed: service accepted connect/key for '${providerId}' but no credential row exists after one retry — the key was NOT stored`);
      }
      credId = credId ?? row!.id;
    }
    return {
      id: credId,
      providerId,
      ...(label !== undefined ? { label } : {}),
      type: 'api',
      active: true,
      routable: true,
      keyHashPrefix: keyHashPrefix(key),
      maskedKey: maskSecret(key),
    };
  }

  async activate(accountId: string): Promise<AccountMeta> {
    this.assertWritable('activate');
    await this.callService('activate', (cfg) => this.http(cfg, 'POST', API.activate(accountId)));
    const known = this.findRow(accountId);
    this.invalidate();
    return known ? { ...rowToMeta(known), active: true } : { id: accountId, providerId: '(unknown)', type: 'api', active: true, routable: true };
  }

  async rename(accountId: string, label: string): Promise<AccountMeta> {
    this.assertWritable('rename');
    await this.callService('rename', (cfg) => this.http(cfg, 'PATCH', API.rename(accountId), BODIES.rename(label)));
    const known = this.findRow(accountId);
    this.invalidate();
    return known ? { ...rowToMeta(known), label: label || undefined } : { id: accountId, providerId: '(unknown)', type: 'api', active: false, routable: false };
  }

  async disconnect(accountId: string): Promise<void> {
    this.assertWritable('disconnect');
    await this.callService('disconnect', (cfg) => this.http(cfg, 'DELETE', API.disconnect(accountId)));
    this.invalidate();
  }

  async beginOAuth(): Promise<unknown> {
    throw new CapabilityUnsupportedError('beginOAuth', 'ADR-0019 P2 write list excludes OAuth (all stores)');
  }

  async completeOAuth(): Promise<AccountMeta> {
    throw new CapabilityUnsupportedError('completeOAuth', 'ADR-0019 P2 write list excludes OAuth (all stores)');
  }

  /** Any console credential action calls this (Decision 3 — no zombie keys). */
  invalidate(): void {
    this.view = null;
    this.viewAt = 0;
    this.integrations = null;
  }

  accountsOverview(): AccountOverview[] {
    const out: AccountOverview[] = [];
    for (const [providerId, rows] of this.currentView()) {
      out.push({
        providerId,
        total: rows.length,
        routable: rows.filter((r) => r.routable).length,
        activeAccountId: rows.find((r) => r.active && r.routable)?.id ?? null,
      });
    }
    return out;
  }

  /** Class-only — factory/test cleanup of the readonly handle. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed — best effort
    }
  }

  // --- internals -----------------------------------------------------------

  private assertWritable(method: string): void {
    if (!this.writable) {
      throw new CapabilityUnsupportedError(method, 'cli-absent-db-present'); // factory-built readonly variant
    }
  }

  private routableRows(providerId: string): OpencodeV2Row[] {
    return (this.currentView().get(providerId) ?? []).filter((r) => r.routable);
  }

  private findRow(accountId: string): OpencodeV2Row | null {
    for (const rows of this.currentView().values()) {
      const hit = rows.find((r) => r.id === accountId);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Post-write confirmation for connect/key: the credential COMMIT can trail the
   * HTTP response (observed), so poll the sqlite view ~2.2 s for a row id that
   * was not there before the POST. Cheap (local reads), never blocks longer
   * than the backoff horizon.
   */
  private async waitForNewRow(integrationId: string, priorIds: ReadonlySet<string>): Promise<OpencodeV2Row | null> {
    for (const waitMs of [0, 600, 1600]) {
      if (waitMs) await this.sleep(waitMs);
      this.invalidate();
      const hit = (this.currentView().get(integrationId) ?? []).find((r) => !priorIds.has(r.id));
      if (hit) return hit;
    }
    return null;
  }

  private currentView(): Map<string, OpencodeV2Row[]> {
    if (!this.view || this.now() - this.viewAt >= this.ttlMs) return this.refreshView();
    return this.view;
  }

  /** Re-query the credential table (the open handle is retained; busy_timeout bounds blocking). */
  private refreshView(): Map<string, OpencodeV2Row[]> {
    let raw: unknown[];
    try {
      raw = this.db.query(SELECT_CREDENTIALS).all();
    } catch (e) {
      throw new StoreUnreadableError('cannot_open', `credential read failed: ${msgOf(e)}`, this.dbFile);
    }
    const view = new Map<string, OpencodeV2Row[]>();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const id = asString(rec.id);
      const integrationId = asString(rec.integration_id);
      if (!id || !integrationId) continue; // structurally unusable row — loud via overview count anyway
      const value = mapValue(rec.value);
      // P2-2: shape assertions — non-coercible active/time_updated is a loud
      // schema drift, never a silent false-active or dropped timestamp.
      const active = coerceActive(rec.active, id, this.dbFile);
      const timeUpdated = coerceTimeUpdated(rec.time_updated, id, this.dbFile);
      const row: OpencodeV2Row = {
        id,
        integrationId,
        label: asString(rec.label) ?? null,
        type: value.type,
        ...(value.key !== undefined ? { key: value.key } : {}),
        active,
        timeUpdated,
        routable: value.type === 'api' && typeof value.key === 'string' && value.key.length > 0,
      };
      const bucket = view.get(integrationId);
      if (bucket) bucket.push(row);
      else view.set(integrationId, [row]);
    }
    this.view = view;
    this.viewAt = this.now();
    return view;
  }

  /**
   * Service discovery for writes — delegates to the module-level
   * resolveServiceConfigForPaths (uncached on purpose: a failed write
   * re-reads service.json to pick up password rotation / port drift).
   */
  private resolveServiceConfig(): OpencodeV2ServiceConfig | null {
    return resolveServiceConfigForPaths(this.paths, this.env);
  }

  /**
   * The provider ids this sink will accept a credential write for — the registry
   * `resolveIntegrationId()` consults, UNIONED with the config-declared providers
   * in our own `opencode.jsonc`: an unmatched write self-heals via
   * `POST /api/location/reload` (boot-registered ids become resolvable), so a
   * declared id IS writable and the gate must say so — the "gates can never
   * disagree with the 409" contract holds through the reload path, not despite it.
   * Empty array = the registry itself was unreachable: callers must read that as
   * UNKNOWN and not disable anything (a false refusal is worse than a real 409).
   */
  async listIntegrationIds(): Promise<string[]> {
    try {
      return [...new Set([...(await this.integrationIds()), ...this.declaredProviderIds()])];
    } catch {
      return [];
    }
  }

  /**
   * Provider ids declared in the `providers` node of our config file — the ids a
   * reload can register upstream. Read errors (no file, junk) = empty, never fatal.
   */
  private declaredProviderIds(): string[] {
    try {
      const cfg = readJsonc(path.join(this.paths.configDir, 'opencode.jsonc'));
      return Object.keys((cfg?.providers ?? {}) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  private reloadInFlight: Promise<boolean> | null = null;

  /**
   * Ask the service to re-read config files (`POST /api/location/reload`, 204).
   * Live probe on the operator's 2.0.15: a just-written def is absent from
   * GET /api/integration, appears after this call, disappears (def removed +
   * reload). Returns false when the endpoint refuses/fails — older builds simply
   * 404, and the caller then falls through to the honest unmatched refusal.
   * Bounded: exactly ONE reload per unmatched write attempt, never on the happy path.
   * Single-flight: the endpoint is GLOBAL and blocks ~2.4 s per call, so
   * concurrent misses SHARE one in-flight reload instead of stacking POSTs
   * (each queued reload delays every other caller's swap — operator-observed
   * contention 2026-10-13). A caller that joins mid-flight can have its def miss
   * the shared reload's config read; its +7 s poll horizon usually still lands,
   * and the next attempt's fresh reload covers the pathological case.
   */
  private reloadConfiguration(): Promise<boolean> {
    if (!this.reloadInFlight) {
      this.reloadInFlight = this.reloadOnce().finally(() => {
        this.reloadInFlight = null;
      });
    }
    return this.reloadInFlight;
  }

  private async reloadOnce(): Promise<boolean> {
    try {
      await this.callService('reloadConfig', (cfg) => this.http(cfg, 'POST', API.reload()));
      this.integrations = null; // the registry just changed upstream
      return true;
    } catch {
      return false;
    }
  }

  private async integrationIds(): Promise<string[]> {
    if (this.integrations && this.now() - this.integrations.at < this.ttlMs) return this.integrations.ids;
    const json = await this.callService('listIntegrations', (cfg) => this.http(cfg, 'GET', API.integrations()));
    const ids = extractIntegrations(json).map((i) => i.id);
    this.integrations = { ids, at: this.now() };
    return ids;
  }

  /** auth-path providerId -> v2 integration id: exact, then case-insensitive; unmatched is typed for reconcile (B3). */
  private async resolveIntegrationId(providerId: string): Promise<string> {
    const match = (ids: string[]): string | undefined => {
      const exact = ids.find((i) => i === providerId);
      if (exact) return exact;
      const target = providerId.toLowerCase();
      return ids.find((i) => i.toLowerCase() === target);
    };
    let current = await this.integrationIds();
    const hit = match(current);
    if (hit) return hit;
    // The service registers config-declared providers when it LOADS config, and a
    // running instance loads it at boot — so an id missing here may simply be a def
    // the service has not re-read yet. Reload once, then POLL the refreshed
    // registry (the swap is async upstream); a true unknown id still lands in the
    // honest 409 below.
    // Escalated rounds: a reload queued BEHIND another caller's reload can read
    // config before our def-write lands (observed live 2026-10-13: fresh def
    // missed round-1's window, succeeded on the very next attempt). One more
    // reload+poll round before the honest verdict makes the FIRST gesture succeed.
    for (let round = 0; round < RELOAD_ROUNDS; round++) {
      if (round) await this.sleep(1200); // let any pending swap settle before re-reloading
      if (!(await this.reloadConfiguration())) break; // unsupported/refused: no second round
      for (const waitMs of RELOAD_POLL_SCHEDULE_MS) {
        await this.sleep(waitMs); // sleep BEFORE querying: the swap never lands at +0 ms
        this.integrations = null; // each poll must re-hit the service
        current = await this.integrationIds();
        const healed = match(current);
        if (healed) return healed;
      }
    }
    throw new IntegrationUnmatchedError(providerId, current);
  }

  /**
   * One service call with the ADR retry: on failure, RE-READ service.json
   * (password rotation / port drift — resolveServiceConfig is uncached) and
   * retry once; the second failure surfaces as WriteFailedError.
   */
  private async callService(label: string, fn: (cfg: OpencodeV2ServiceConfig) => Promise<unknown>): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cfg = this.resolveServiceConfig();
      if (!cfg) {
        lastError = new Error('no opencode v2 service config (OPENCODE_SERVER_PASSWORD / service.json absent)');
        continue;
      }
      try {
        return await fn(cfg);
      } catch (e) {
        if (e instanceof IntegrationUnmatchedError) throw e; // not a transport problem — retrying cannot help
        lastError = e;
      }
    }
    throw new WriteFailedError(label, msgOf(lastError), lastError);
  }

  private async http(cfg: OpencodeV2ServiceConfig, method: string, route: string, body?: unknown): Promise<unknown> {
    // Security P2-1: never hand raw keys (or the Basic password) to a
    // non-loopback plaintext HTTP target. Refused BEFORE any fetch — every
    // HTTP call of this store (incl. the integration-list GET a write needs)
    // carries credentials, so the refusal covers all verbs. sqlite reads are
    // unaffected. The reason token lands in the WriteFailedError message and
    // from there into reconcile excluded / push failed[] — machine-readable.
    if (cfg.targetPolicy === 'insecure_remote') {
      throw new Error(
        `insecure_remote_target: refusing ${method} ${route} against non-loopback plaintext HTTP service (${cfg.baseUrl}) — bind the service URL to loopback or https`
      );
    }
    const init: RequestInit = {
      method,
      // P3-4: no automatic redirect following (a 3xx is refused below, never
      // re-issued with the key against the Location target).
      redirect: 'manual',
      headers: {
        Authorization: cfg.authHeader,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // P3-3: every admin-served v2 call is bounded — a hung service must not
      // hold the console request (and the reconcile boot gate) open forever.
      signal: AbortSignal.timeout(ADMIN_HTTP_TIMEOUT_MS),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${cfg.baseUrl}${route}`, init);
    } catch (e) {
      if (isTimeoutError(e)) {
        throw new Error(`timeout: ${method} ${route} exceeded ${ADMIN_HTTP_TIMEOUT_MS}ms against ${cfg.baseUrl}`);
      }
      throw e;
    }
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`redirect_refused: ${method} ${route} -> HTTP ${res.status} (redirects are never followed)`);
    }
    if (!res.ok) {
      // Redact any request-body secret the upstream echoed back BEFORE the
      // 200-char cut — truncating first would let an echo starting near the
      // boundary re-expose key characters (security review, runtime-proven).
      // The method/route/status diagnostic limbs survive (Decision 1 risk limb).
      throw new Error(`${method} ${route} -> HTTP ${res.status}: ${redactBodySecrets(text, body).slice(0, 200)}`);
    }
    if (!text) return undefined; // 2xx empty body = accepted
    try {
      return JSON.parse(text);
    } catch {
      return undefined; // 2xx non-JSON body = accepted without payload
    }
  }
}

// P3-3: bound for admin-served opencode v2 service calls (writes, integration probes).
const ADMIN_HTTP_TIMEOUT_MS = 8_000;

/** AbortSignal.timeout() surfaces as a TimeoutError-named rejection. */
function isTimeoutError(e: unknown): boolean {
  if (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'TimeoutError') return true;
  return /the operation was aborted due to timeout|timeout expired/i.test(msgOf(e));
}

// ---------------------------------------------------------------------------
// P2-2 value-shape assertions — the row shape IS the contract. A column
// drift (TEXT 'true' in active, garbage time_updated) must fail the whole
// read LOUD (schema_mismatch -> db_unreadable badge), never silently resolve
// a wrong key or drop the row.
// ---------------------------------------------------------------------------

function coerceInteger(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN; // booleans, objects, empty strings, null-ish handled by callers
}

function coerceActive(v: unknown, rowId: string, file: string): boolean {
  if (v === null || v === undefined) return false; // NULL column = inactive (Number-0 parity)
  const n = coerceInteger(v);
  if (!Number.isInteger(n) || (n !== 0 && n !== 1)) {
    throw new StoreUnreadableError(
      'schema_mismatch',
      `credential row ${rowId}: active is not a 0/1 integer (${String(v)})`,
      file
    );
  }
  return n === 1;
}

function coerceTimeUpdated(v: unknown, rowId: string, file: string): number | null {
  if (v === null || v === undefined) return null;
  const n = coerceInteger(v);
  if (!Number.isInteger(n)) {
    throw new StoreUnreadableError(
      'schema_mismatch',
      `credential row ${rowId}: time_updated is not an integer (${String(v)})`,
      file
    );
  }
  return n;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
}

function probeColumns(db: OpencodeV2Database, file: string): void {
  const info = db.query('PRAGMA table_info(credential)').all();
  const names = new Set(
    info
      .map((r) => (r && typeof r === 'object' ? asString((r as Record<string, unknown>).name) : undefined))
      .filter((n): n is string => Boolean(n))
  );
  if (names.size === 0) {
    throw new StoreUnreadableError('schema_mismatch', 'table credential does not exist', file);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !names.has(c));
  if (missing.length > 0) {
    throw new StoreUnreadableError('schema_mismatch', `missing/renamed columns on credential: ${missing.join(', ')}`, file);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
