import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { maskSecret } from '../user-config.js';
import { CredentialPaths, ocrCredentialsFile, resolveDefaultPaths } from './paths.js';
import { renameWithRetry } from '../../utils/atomic-write.js';
import {
  CredentialMeta,
  CredentialNotFoundError,
  CredentialOverview,
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
 * allowed with a badge, write-side proliferation is not.
 *
 * Schema version 2: { version: 2, providers: Record<providerId, [OcrCredential]> }.
 * The ROW-ARRAY ORDER is the authoritative chain order (index 0 = chain head);
 * `active` always follows position 0 (rows[0].active === true). Version 1
 * files (order was DERIVED: active rows first, then !active by timeUpdated
 * DESC) are normalized IN MEMORY to that legacy derived order on read — array
 * order is thereafter authoritative — and written back as version 2 on the
 * next mutation. Version 2 files are never reordered on read.
 */
interface OcrCredential {
  credentialId: string;
  label?: string;
  key: string;
  timeCreated: number;
  timeUpdated: number;
  active: boolean;
}

interface OcrFile {
  version: 2;
  providers: Record<string, OcrCredential[]>;
}

export interface OcrStoreDeps {
  paths?: CredentialPaths;
  now?: () => number;
  /**
   * Mutation notification — fired after every SUCCESSFUL file write
   * (connectKey/activate/rename/disconnect all funnel through save()).
   * The credential-sync engine uses this to debounce an auto-write push.
   * A hook failure is the hook's own problem: save() never throws for it.
   */
  onMutate?: () => void;
}

const OCR_CAPABILITIES: StoreCapabilities = {
  multiCredential: true,
  activate: true,
  reorder: true,
  rename: true,
  oauth: false,
  envVisible: false, // OCR-only store — no opencode env-templated sibling surface
  integrationScoped: false, // any provider id is addressable: OCR owns the file
};

function toMeta(providerId: string, credential: OcrCredential): CredentialMeta {
  return {
    id: credential.credentialId,
    providerId,
    label: credential.label,
    type: 'api', // OcrStore only ever holds raw api keys (oauth capability false)
    active: credential.active,
    routable: Boolean(credential.key),
    keyHashPrefix: keyHashPrefix(credential.key),
    maskedKey: maskSecret(credential.key),
  };
}

function toRaw(providerId: string, credential: OcrCredential): RawCred {
  return {
    credentialId: credential.credentialId,
    providerId,
    label: credential.label,
    key: credential.key,
    keyHash: sha256KeyHash(credential.key),
    active: credential.active,
    timeUpdated: credential.timeUpdated,
  };
}

/** active first, sole row next, newest timeUpdated last — shared selection. */
function selectKey<T extends { active: boolean; timeUpdated: number }>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  const active = rows.find((r) => r.active);
  if (active) return active;
  if (rows.length === 1) return rows[0];
  return [...rows].sort((a, b) => b.timeUpdated - a.timeUpdated)[0] ?? null;
}

/**
 * Legacy v1 read-order normalization: active rows first (file order), then
 * !active rows newest timeUpdated first. Applied to a version-1 file's rows
 * so the v2 array-order invariant holds from the first read — without
 * writing (the file stays v1 until a mutation saves it as v2).
 */
function normalizeLegacyOrder(rows: OcrCredential[]): OcrCredential[] {
  const active = rows.filter((r) => r.active);
  const rest = rows.filter((r) => !r.active).sort((a, b) => b.timeUpdated - a.timeUpdated);
  return [...active, ...rest];
}

export class OcrStore implements CredentialStore {
  readonly kind: StoreKind = 'ocr';
  readonly capabilities = OCR_CAPABILITIES;
  private readonly file: string;
  private readonly now: () => number;
  private mutateHook: (() => void) | null;

  constructor(deps: OcrStoreDeps = {}) {
    const paths = deps.paths ?? resolveDefaultPaths();
    this.file = ocrCredentialsFile(paths);
    this.now = deps.now ?? Date.now;
    this.mutateHook = deps.onMutate ?? null;
  }

  /** Late-binding mutation hook (the sync engine installs it after boot bind). */
  setMutationHook(fn: () => void): void {
    this.mutateHook = fn;
  }

  probe(): StoreProbeResult {
    if (!fs.existsSync(this.file)) {
      return { ok: true, kind: this.kind, state: 'empty', credentialCount: 0 };
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
        credentialCount: 0,
      };
    }
    return { ok: true, kind: this.kind, state: count === 0 ? 'empty' : 'ready', credentialCount: count };
  }

  listCredentials(providerId: string): CredentialMeta[] {
    return this.load(providerId).map((a) => toMeta(providerId, a));
  }

  resolveKey(providerId: string): ResolvedCredential | null {
    const row = selectKey(this.load(providerId).filter((a) => a.key));
    return row ? { key: row.key, credential: toMeta(providerId, row) } : null;
  }

  /**
   * ARRAY ORDER is the chain order (v2 schema; v1 rows were normalized to the
   * legacy derived order on read, so array order is authoritative here).
   */
  resolveKeyChain(providerId: string): RawCred[] {
    return this.load(providerId).filter((a) => a.key).map((a) => toRaw(providerId, a));
  }

  revealKey(credentialId: string): string {
    const found = this.findCredential(credentialId);
    if (!found) throw new CredentialNotFoundError(credentialId);
    if (!found.credential.key) {
      throw new CapabilityUnsupportedError('revealKey', 'ocr credential carries no raw key material');
    }
    return found.credential.key;
  }

  async connectKey(providerId: string, key: string, label?: string): Promise<CredentialMeta> {
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
    const credential: OcrCredential = {
      credentialId: crypto.randomUUID(),
      ...(label !== undefined ? { label } : {}),
      key,
      timeCreated: this.now(),
      timeUpdated: this.now(),
      active: rows.length === 0, // first key for a provider is active by default
    };
    this.save(providerId, [...rows, credential]);
    return toMeta(providerId, credential);
  }

  async activate(credentialId: string): Promise<CredentialMeta> {
    const found = this.findCredential(credentialId);
    if (!found) throw new CredentialNotFoundError(credentialId);
    const { providerId } = found;
    const rows = this.load(providerId).map((a) => ({
      ...a,
      active: a.credentialId === credentialId,
      timeUpdated: a.credentialId === credentialId ? this.now() : a.timeUpdated,
    }));
    this.save(providerId, rows);
    const updated = rows.find((a) => a.credentialId === credentialId)!;
    return toMeta(providerId, updated);
  }

  async rename(credentialId: string, label: string): Promise<CredentialMeta> {
    const found = this.findCredential(credentialId);
    if (!found) throw new CredentialNotFoundError(credentialId);
    const { providerId } = found;
    // Empty clears the field entirely (the route's contract): storing "" would
    // leave a ghost label that every reader must remember to treat as absent.
    const rows = this.load(providerId).map((a) => {
      if (a.credentialId !== credentialId) return a;
      const { label: _dropped, ...rest } = a;
      return { ...rest, ...(label ? { label } : {}), timeUpdated: this.now() };
    });
    this.save(providerId, rows);
    return toMeta(providerId, rows.find((a) => a.credentialId === credentialId)!);
  }

  async disconnect(credentialId: string): Promise<void> {
    const found = this.findCredential(credentialId);
    if (!found) throw new CredentialNotFoundError(credentialId);
    const { providerId } = found;
    this.save(
      providerId,
      this.load(providerId).filter((a) => a.credentialId !== credentialId)
    );
  }

  async beginOAuth(): Promise<unknown> {
    throw new CapabilityUnsupportedError('beginOAuth', 'OAuth is excluded from every credential store');
  }

  async completeOAuth(): Promise<CredentialMeta> {
    throw new CapabilityUnsupportedError('completeOAuth', 'OAuth is excluded from every credential store');
  }

  /**
   * Operator reorder: `orderedIds` MUST be a permutation of the provider's
   * credential ids (missing id → CredentialNotFoundError; duplicates/length
   * mismatch → Error). The chain head becomes orderedIds[0]; `active` follows
   * position 0 (rows[0].active === true), the head's timeUpdated is bumped,
   * and the reordered array is saved as version 2.
   */
  async reorder(providerId: string, orderedIds: string[]): Promise<CredentialMeta[]> {
    const rows = this.load(providerId);
    const byId = new Map(rows.map((r) => [r.credentialId, r]));
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!byId.has(id)) throw new CredentialNotFoundError(id);
      if (seen.has(id)) throw new Error(`reorder: duplicate credential id '${id}'`);
      seen.add(id);
    }
    if (seen.size !== rows.length) {
      throw new Error(`reorder: expected ${rows.length} credential ids for provider '${providerId}', received ${seen.size}`);
    }
    this.save(
      providerId,
      orderedIds.map((id, index) => ({
        ...byId.get(id)!,
        active: index === 0,
        ...(index === 0 ? { timeUpdated: this.now() } : {}),
      }))
    );
    return this.load(providerId).map((a) => toMeta(providerId, a));
  }

  invalidate(): void {
    // file read per call — nothing cached
  }

  credentialsOverview(): CredentialOverview[] {
    const file = this.readFile();
    return Object.entries(file.providers).map(([providerId, rows]) => ({
      providerId,
      total: rows.length,
      routable: rows.filter((r) => r.key).length,
      activeCredentialId: rows.find((r) => r.active)?.credentialId ?? null,
    }));
  }

  // --- internals -----------------------------------------------------------

  private readFile(): OcrFile {
    if (!fs.existsSync(this.file)) return { version: 2, providers: {} };
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
    const file = parsed as { version?: unknown; providers?: Record<string, OcrCredential[]> };
    if (!file.providers || typeof file.providers !== 'object') {
      throw new StoreUnreadableError('cannot_open', 'credentials.json has no providers map', this.file);
    }
    if (file.version !== 1 && file.version !== 2) {
      throw new StoreUnreadableError('cannot_open', `unsupported credentials.json version: ${String(file.version)}`, this.file);
    }
    if (file.version === 1) {
      // v1: array order was DERIVED, not stored — normalize in memory to the
      // legacy derived order so array order is authoritative from here on,
      // WITHOUT writing (the file is stamped v2 only by the next mutation).
      const providers: Record<string, OcrCredential[]> = {};
      for (const [pid, rows] of Object.entries(file.providers)) {
        providers[pid] = Array.isArray(rows) ? normalizeLegacyOrder(rows) : rows;
      }
      return { version: 2, providers };
    }
    return { version: 2, providers: file.providers };
  }

  /** @throws StoreUnreadableError when the file exists but cannot be parsed. */
  private load(providerId: string): OcrCredential[] {
    const { providers } = this.readFile();
    // P3-1: own-property-only lookup — a bare `providers['__proto__']` read
    // would surface Object.prototype for a key absent from the file.
    const rows = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is OcrCredential => Boolean(r) && typeof r === 'object' && typeof r.credentialId === 'string');
  }

  private loadRows(): OcrCredential[] {
    const file = this.readFile();
    return Object.values(file.providers).flatMap((rows) =>
      Array.isArray(rows) ? rows.filter((r) => Boolean(r) && typeof r === 'object') : []
    );
  }

  private findCredential(credentialId: string): { providerId: string; credential: OcrCredential } | null {
    for (const providerId of Object.keys(this.readFile().providers)) {
      const credential = this.load(providerId).find((a) => a.credentialId === credentialId);
      if (credential) return { providerId, credential };
    }
    return null;
  }

  /** Atomic write: temp + rename (user-config.ts:71 precedent), best-effort 0600. */
  private save(providerId: string, rows: OcrCredential[]): void {
    const file = this.readFile();
    const providers = { ...file.providers };
    // An emptied provider loses its key entirely — no `[]` debris in the
    // file after the last disconnect (push/local-removal semantics).
    if (rows.length === 0) delete providers[providerId];
    else providers[providerId] = rows;
    const next: OcrFile = { version: 2, providers };
    const content = `${JSON.stringify(next, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmpPath = `${this.file}.tmp.${process.pid}.${Date.now()}`;
    // P3-2: mode 0o600 AT CREATION — a world-readable window between the
    // write and the chmod is still a window; the open flag closes it (the
    // post-write chmod stays as best-effort belt for pre-existing files).
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      // Best-effort restrictive mode; Windows chmod semantics differ and can
      // fail — acceptable, this is the documented "best-effort 0600".
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best effort
    }
    renameWithRetry(tmpPath, this.file);
    // Fire-and-forget notification AFTER the durable write — the sync engine
    // debounces a push from here. The hook must never break the mutation.
    try {
      this.mutateHook?.();
    } catch {
      // best effort — a broken hook must not fail the credential write
    }
  }
}
