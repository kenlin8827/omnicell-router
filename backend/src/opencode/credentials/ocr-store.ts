import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maskSecret } from '../user-config.js';
import { CredentialPaths, ocrCredentialsFile, resolveDefaultPaths } from './paths.js';
import {
  AccountMeta,
  AccountNotFoundError,
  AccountOverview,
  CapabilityUnsupportedError,
  CredentialStore,
  RawCred,
  RESERVED_PROVIDER_IDS,
  ResolvedCredential,
  StoreCapabilities,
  StoreKind,
  StoreProbeResult,
  StoreUnreadableError,
  keyHashPrefix,
  sha256KeyHash,
} from './types.js';

/**
 * OcrStore — OCR-owned credentials file at <ocrHome>/credentials.json, GLOBAL
 * (mirroring opencode's own global credential scope; not per-environment).
 *
 * This store is a second local truth ONLY when opencode is absent (normal
 * standalone) or as a LOUD fallback (badged db_unreadable/unsupported_version by
 * the factory). An opencode v2 NEVER falls back here — read-side degradation is
 * allowed with a badge, write-side proliferation is not (ADR-0019 Decision 3).
 *
 * Schema: { version: 1, providers: Record<providerId, [{ accountId, label?,
 * key, timeCreated, timeUpdated, active }]> }
 */

interface OcrAccount {
  accountId: string;
  label?: string;
  key: string;
  timeCreated: number;
  timeUpdated: number;
  active: boolean;
}

interface OcrFile {
  version: 1;
  providers: Record<string, OcrAccount[]>;
}

export interface OcrStoreDeps {
  paths?: CredentialPaths;
  now?: () => number;
}

const OCR_CAPABILITIES: StoreCapabilities = {
  multiAccount: true,
  activate: true,
  rename: true,
  oauth: false,
  envVisible: false, // OCR-only store — no opencode env-templated sibling surface
  integrationScoped: false, // any provider id is addressable: OCR owns the file
};

function toMeta(providerId: string, account: OcrAccount): AccountMeta {
  return {
    id: account.accountId,
    providerId,
    label: account.label,
    type: 'api', // OcrStore only ever holds raw api keys (oauth capability false)
    active: account.active,
    routable: Boolean(account.key),
    keyHashPrefix: keyHashPrefix(account.key),
    maskedKey: maskSecret(account.key),
  };
}

function toRaw(providerId: string, account: OcrAccount): RawCred {
  return {
    accountId: account.accountId,
    providerId,
    label: account.label,
    key: account.key,
    keyHash: sha256KeyHash(account.key),
    active: account.active,
    timeUpdated: account.timeUpdated,
  };
}

/** active first, sole row next, newest timeUpdated last — shared selection (ADR Decision 3 order). */
function selectKey<T extends { active: boolean; timeUpdated: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const active = rows.find((r) => r.active);
  if (active) return active;
  if (rows.length === 1) return rows[0];
  return [...rows].sort((a, b) => b.timeUpdated - a.timeUpdated)[0] ?? null;
}

function chainOrder<T extends { active: boolean; timeUpdated: number }>(rows: T[]): T[] {
  const active = rows.filter((r) => r.active);
  const rest = rows.filter((r) => !r.active).sort((a, b) => b.timeUpdated - a.timeUpdated);
  return [...active, ...rest];
}

export class OcrStore implements CredentialStore {
  readonly kind: StoreKind = 'ocr';
  readonly capabilities = OCR_CAPABILITIES;
  private readonly file: string;
  private readonly now: () => number;

  constructor(deps: OcrStoreDeps = {}) {
    const paths = deps.paths ?? resolveDefaultPaths();
    this.file = ocrCredentialsFile(paths);
    this.now = deps.now ?? Date.now;
  }

  probe(): StoreProbeResult {
    if (!fs.existsSync(this.file)) {
      return { ok: true, kind: this.kind, state: 'empty', accountCount: 0 };
    }
    let count = 0;
    try {
      count = this.loadRows().length;
    } catch (e) {
      return {
        ok: false,
        kind: this.kind,
        state: 'unreadable',
        detail: e instanceof Error ? e.message : String(e),
        accountCount: 0,
      };
    }
    return { ok: true, kind: this.kind, state: count === 0 ? 'empty' : 'ready', accountCount: count };
  }

  listAccounts(providerId: string): AccountMeta[] {
    return this.load(providerId).map((a) => toMeta(providerId, a));
  }

  resolveKey(providerId: string): ResolvedCredential | null {
    const row = selectKey(this.load(providerId).filter((a) => a.key));
    return row ? { key: row.key, account: toMeta(providerId, row) } : null;
  }

  resolveKeyChain(providerId: string): RawCred[] {
    return chainOrder(this.load(providerId).filter((a) => a.key)).map((a) => toRaw(providerId, a));
  }

  revealKey(accountId: string): string {
    const found = this.findAccount(accountId);
    if (!found) throw new AccountNotFoundError(accountId);
    if (!found.account.key) {
      throw new CapabilityUnsupportedError('revealKey', 'ocr account carries no raw key material');
    }
    return found.account.key;
  }

  async connectKey(providerId: string, key: string, label?: string): Promise<AccountMeta> {
    if (!key) throw new Error('connectKey requires a non-empty key');
    if (!providerId || /[^A-Za-z0-9._\-\/]/.test(providerId)) {
      throw new Error(`Invalid provider id: '${providerId}'`);
    }
    // Security P3-1: reserved Object.prototype member names can never be
    // provider ids — they would turn the plain-object providers map into a
    // prototype-pollution sink on every store reader.
    if (RESERVED_PROVIDER_IDS.has(providerId)) {
      throw new Error(`Invalid provider id: '${providerId}'`);
    }
    const rows = this.load(providerId);
    const account: OcrAccount = {
      accountId: crypto.randomUUID(),
      ...(label !== undefined ? { label } : {}),
      key,
      timeCreated: this.now(),
      timeUpdated: this.now(),
      active: rows.length === 0, // first key for a provider is active by default
    };
    this.save(providerId, [...rows, account]);
    return toMeta(providerId, account);
  }

  async activate(accountId: string): Promise<AccountMeta> {
    const found = this.findAccount(accountId);
    if (!found) throw new AccountNotFoundError(accountId);
    const { providerId, account } = found;
    const rows = this.load(providerId).map((a) => ({
      ...a,
      active: a.accountId === accountId,
      timeUpdated: a.accountId === accountId ? this.now() : a.timeUpdated,
    }));
    this.save(providerId, rows);
    const updated = rows.find((a) => a.accountId === accountId)!;
    return toMeta(providerId, updated);
  }

  async rename(accountId: string, label: string): Promise<AccountMeta> {
    const found = this.findAccount(accountId);
    if (!found) throw new AccountNotFoundError(accountId);
    const { providerId } = found;
    // Empty clears the field entirely (the route's contract): storing "" would
    // leave a ghost label that every reader must remember to treat as absent.
    const rows = this.load(providerId).map((a) => {
      if (a.accountId !== accountId) return a;
      const { label: _dropped, ...rest } = a;
      return { ...rest, ...(label ? { label } : {}), timeUpdated: this.now() };
    });
    this.save(providerId, rows);
    return toMeta(providerId, rows.find((a) => a.accountId === accountId)!);
  }

  async disconnect(accountId: string): Promise<void> {
    const found = this.findAccount(accountId);
    if (!found) throw new AccountNotFoundError(accountId);
    const { providerId } = found;
    this.save(
      providerId,
      this.load(providerId).filter((a) => a.accountId !== accountId)
    );
  }

  async beginOAuth(): Promise<unknown> {
    throw new CapabilityUnsupportedError('beginOAuth', 'ADR-0019 P2 write list excludes OAuth (all stores)');
  }

  async completeOAuth(): Promise<AccountMeta> {
    throw new CapabilityUnsupportedError('completeOAuth', 'ADR-0019 P2 write list excludes OAuth (all stores)');
  }

  invalidate(): void {
    // file read per call — nothing cached
  }

  accountsOverview(): AccountOverview[] {
    const file = this.readFile();
    return Object.entries(file.providers).map(([providerId, rows]) => ({
      providerId,
      total: rows.length,
      routable: rows.filter((r) => r.key).length,
      activeAccountId: rows.find((r) => r.active)?.accountId ?? null,
    }));
  }

  // --- internals -----------------------------------------------------------

  private readFile(): OcrFile {
    if (!fs.existsSync(this.file)) return { version: 1, providers: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      throw new StoreUnreadableError(
        'cannot_open',
        `credentials.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        this.file
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new StoreUnreadableError('cannot_open', 'credentials.json is not an object', this.file);
    }
    const file = parsed as Partial<OcrFile>;
    if (!file.providers || typeof file.providers !== 'object') {
      throw new StoreUnreadableError('cannot_open', 'credentials.json has no providers map', this.file);
    }
    if (file.version !== 1) {
      throw new StoreUnreadableError('cannot_open', `unsupported credentials.json version: ${String(file.version)}`, this.file);
    }
    return { version: 1, providers: file.providers };
  }

  /** @throws StoreUnreadableError when the file exists but cannot be parsed. */
  private load(providerId: string): OcrAccount[] {
    const { providers } = this.readFile();
    // P3-1: own-property-only lookup — a bare `providers['__proto__']` read
    // would surface Object.prototype for a key absent from the file.
    const rows = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is OcrAccount => Boolean(r) && typeof r === 'object' && typeof r.accountId === 'string');
  }

  private loadRows(): OcrAccount[] {
    const file = this.readFile();
    return Object.values(file.providers).flatMap((rows) =>
      Array.isArray(rows) ? rows.filter((r) => Boolean(r) && typeof r === 'object') : []
    );
  }

  private findAccount(accountId: string): { providerId: string; account: OcrAccount } | null {
    for (const providerId of Object.keys(this.readFile().providers)) {
      const account = this.load(providerId).find((a) => a.accountId === accountId);
      if (account) return { providerId, account };
    }
    return null;
  }

  /** Atomic write: temp + rename (user-config.ts:71 precedent), best-effort 0600. */
  private save(providerId: string, rows: OcrAccount[]): void {
    const file = this.readFile();
    const providers = { ...file.providers };
    // An emptied provider loses its key entirely — no `[]` debris in the
    // file after the last disconnect (push/local-removal semantics).
    if (rows.length === 0) delete providers[providerId];
    else providers[providerId] = rows;
    const next: OcrFile = { version: 1, providers };
    const content = `${JSON.stringify(next, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    // P3-2: mode 0o600 AT CREATION — a world-readable window between the
    // write and the chmod is still a window; the open flag closes it (the
    // post-write chmod stays as best-effort belt for pre-existing files).
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      // Best-effort restrictive mode; Windows chmod semantics differ and can
      // fail — acceptable, the ADR calls this "best-effort 0600".
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best effort
    }
    fs.renameSync(tmpPath, this.file);
  }
}
