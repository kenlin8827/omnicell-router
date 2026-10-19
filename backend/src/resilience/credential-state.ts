import fs from 'node:fs';
import path from 'node:path';
import {
  CredentialPaths,
  resolveDefaultPaths,
  suspectCredentialsFile,
} from '../opencode/credentials/paths.js';

/**
 * The SUSPECT credential flag store.
 *
 * SUSPECT is ADMINISTRATIVE state, not breaker state: a confirmed-bad
 * credential (401 after refresh attempts) is marked suspect and NEVER
 * auto-returns. Cooldown expiry un-trips the pair breakers; only an explicit clear
 * (console reconnect / Push / admin REST) lifts the flag.
 *
 * Persistence is the OCR GLOBAL state root (`<OCR_HOME|~/.opencode-router>/
 * suspect-credentials.json`), not per-environment — an credential is an credential
 * wherever it is used. Payload is display-safe (provider id + sha256 prefix),
 * so nothing sensitive sits in a file that survives restarts.
 */

/** Stable composite id: the same key material under two providers is two flags. */
export function suspectCredentialId(providerId: string, keyHashPrefix: string): string {
  return `${providerId}::${keyHashPrefix}`;
}

export interface SuspectCredential {
  providerId: string;
  keyHashPrefix: string;
  /** Why it was marked (diagnosis reason) — observability only. */
  reason: string;
  /** Epoch ms of the mark. */
  markedAt: number;
}

interface SuspectFile {
  version: 1;
  credentials: Record<string, SuspectCredential>;
  /**
   * Operator DISABLED credentials — a separate record from `credentials`, not a flag
   * inside it: the two lifecycles disagree. SUSPECT is auto-marked by auth
   * failure and cleared by any reconnect/Push (`clear()` deletes the entry),
   * while DISABLED is set only by an operator and must survive every reconnect
   * until the same operator lifts it. Sharing one entry would let a routine
   * reconnect silently undo a deliberate takedown.
   * Absent in files written before this feature (and ignored by older readers),
   * so the version stays 1 in both directions.
   */
  disabled?: Record<string, DisabledCredential>;
}

/** Operator-taken credential: listed, never served, until the operator re-enables it. */
export interface DisabledCredential {
  providerId: string;
  keyHashPrefix: string;
  /** Operator-supplied note (quota, rotation, abuse suspicion…) — display only. */
  reason: string;
  disabledAt: number;
}

export interface CredentialStateStoreDeps {
  /** Injection seam for tests — same CredentialPaths the stores use. */
  paths?: CredentialPaths;
  now?: () => number;
}

export class CredentialStateStore {
  /** Undefined = resolve from the real environment at first touch (boot path). */
  private readonly paths: CredentialPaths | undefined;
  private readonly nowFn: () => number;
  private loaded = false;
  private resolvedFile: string | undefined;
  private credentials = new Map<string, SuspectCredential>();
  // Operator takedowns — see SuspectFile.disabled: independent lifecycle, so an
  // independent map rather than a flag that `clear()` would sweep away.
  private disabled = new Map<string, DisabledCredential>();
  // A file that existed but could not be parsed is preserved on the first
  // write instead of being overwritten (cp-dataloss: the flags are the only
  // record of an credential an operator may have been working on).
  private preserveCorrupt = false;

  constructor(deps: CredentialStateStoreDeps = {}) {
    this.paths = deps.paths;
    this.nowFn = deps.now ?? Date.now;
  }

  /** Where the flags live — log/diagnostic surface, never a secret. */
  public get filePath(): string {
    if (!this.resolvedFile) this.resolvedFile = suspectCredentialsFile(this.paths ?? resolveDefaultPaths());
    return this.resolvedFile;
  }

  /**
   * Load-once; a missing or malformed file is an empty set (never fatal).
   * One-time migration: flags saved under the pre-rename name
   * (suspect-accounts.json, inner key `accounts`) are read, seeded and the
   * legacy file removed once the next persist writes the new one — a
   * takedown must never silently un-disable because of a file rename.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const legacyFile = this.filePath.replace(/suspect-credentials\.json$/, 'suspect-accounts.json');
    let raw: string;
    let legacy = false;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      if (legacyFile !== this.filePath) {
        try {
          raw = fs.readFileSync(legacyFile, 'utf8');
          legacy = true;
        } catch {
          return; // neither file present -> no flags
        }
      } else {
        return; // absent/unreadable -> no flags
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Loud, not silent: a half-written file must not read as "no suspects".
      this.preserveCorrupt = true;
      console.warn(
        `[resilience] ${legacy ? legacyFile : this.filePath} is unparseable, starting empty: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return;
    }
    const file = parsed as Partial<SuspectFile> & { accounts?: Record<string, unknown> };
    // The legacy layout keyed its suspect map `accounts`; the rename carries it.
    const suspectMap =
      file.credentials && typeof file.credentials === 'object'
        ? file.credentials
        : legacy && file.accounts && typeof file.accounts === 'object'
          ? file.accounts
          : undefined;
    if (file.version !== 1 || !suspectMap) {
      this.preserveCorrupt = true;
      console.warn(`[resilience] ${legacy ? legacyFile : this.filePath} has an unexpected shape, starting empty`);
      return;
    }
    for (const [id, entry] of Object.entries(suspectMap)) {
      const a = entry as Partial<SuspectCredential> | null;
      if (!a || typeof a.providerId !== 'string' || typeof a.keyHashPrefix !== 'string') continue;
      this.credentials.set(id, {
        providerId: a.providerId,
        keyHashPrefix: a.keyHashPrefix,
        reason: typeof a.reason === 'string' ? a.reason : '',
        markedAt: typeof a.markedAt === 'number' ? a.markedAt : 0,
      });
    }
    // Optional in v1 files (both directions): absent = nothing takedown.
    if (file.disabled && typeof file.disabled === 'object') {
      for (const [id, entry] of Object.entries(file.disabled)) {
        const d = entry as Partial<DisabledCredential> | null;
        if (!d || typeof d.providerId !== 'string' || typeof d.keyHashPrefix !== 'string') continue;
        this.disabled.set(id, {
          providerId: d.providerId,
          keyHashPrefix: d.keyHashPrefix,
          reason: typeof d.reason === 'string' ? d.reason : '',
          disabledAt: typeof d.disabledAt === 'number' ? d.disabledAt : 0,
        });
      }
    }
    if (legacy) {
      try {
        fs.unlinkSync(legacyFile); // migrated — the legacy name never comes back
      } catch {
        // best effort; the next persist re-writes the new file regardless
      }
    }
  }

  /** Atomic write (temp + rename), best-effort 0600 — OcrStore.save precedent. */
  private persist(): void {
    if (this.preserveCorrupt) {
      this.preserveCorrupt = false;
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt.${this.nowFn()}`);
      } catch {
        // best effort — a rename race must not block the write of live flags
      }
    }
    const credentials: Record<string, SuspectCredential> = {};
    for (const [id, entry] of this.credentials) credentials[id] = entry;
    const disabled: Record<string, DisabledCredential> = {};
    for ( const [id, entry] of this.disabled) disabled[id] = entry;
    // Written only when non-empty so a reader from before this feature keeps
    // parsing the file exactly as it did.
    const content = `${JSON.stringify(
      { version: 1, credentials, ...(this.disabled.size > 0 ? { disabled } : {}) } satisfies SuspectFile,
      null,
      2
    )}\n`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best effort — Windows chmod semantics differ
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * Mark an credential suspect. Idempotent: re-marking keeps the FIRST markedAt
   * (the flag's age is the audit signal) and refreshes the reason.
   * @returns true when this call created the flag.
   */
  public mark(providerId: string, keyHashPrefix: string, reason = ''): boolean {
    this.ensureLoaded();
    const id = suspectCredentialId(providerId, keyHashPrefix);
    const existing = this.credentials.get(id);
    if (existing) {
      if (existing.reason === reason) return false; // exact re-mark: no write churn
      existing.reason = reason;
      this.persist();
      return false;
    }
    this.credentials.set(id, { providerId, keyHashPrefix, reason, markedAt: this.nowFn() });
    this.persist();
    return true;
  }

  /** Lift the flag (reconnect / Push / admin). @returns true when a flag was cleared. */
  public clear(providerId: string, keyHashPrefix: string): boolean {
    this.ensureLoaded();
    if (!this.credentials.delete(suspectCredentialId(providerId, keyHashPrefix))) return false;
    this.persist();
    return true;
  }

  // -- Operator DISABLED credentials (separate lifecycle: reconnect never lifts it) --

  /**
   * Take a credential out of routing. Idempotent: re-disabling keeps the FIRST
   * `disabledAt` (the takedown's age is the audit signal) and refreshes the note.
   * @returns true when this call created the flag.
   */
  public disable(providerId: string, keyHashPrefix: string, reason = ''): boolean {
    this.ensureLoaded();
    const id = suspectCredentialId(providerId, keyHashPrefix);
    const existing = this.disabled.get(id);
    if (existing) {
      if (existing.reason === reason) return false; // exact re-disable: no write churn
      existing.reason = reason;
      this.persist();
      return false;
    }
    this.disabled.set(id, { providerId, keyHashPrefix, reason, disabledAt: this.nowFn() });
    this.persist();
    return true;
  }

  /** Put it back in routing. Only the operator does this — no automatic path exists. */
  public enable(providerId: string, keyHashPrefix: string): boolean {
    this.ensureLoaded();
    if (!this.disabled.delete(suspectCredentialId(providerId, keyHashPrefix))) return false;
    this.persist();
    return true;
  }

  public isDisabled(providerId: string, keyHashPrefix: string): boolean {
    this.ensureLoaded();
    return this.disabled.has(suspectCredentialId(providerId, keyHashPrefix));
  }

  public getDisabled(providerId: string, keyHashPrefix: string): DisabledCredential | undefined {
    this.ensureLoaded();
    return this.disabled.get(suspectCredentialId(providerId, keyHashPrefix));
  }

  public listDisabled(): DisabledCredential[] {
    this.ensureLoaded();
    return Array.from(this.disabled.values()).sort((a, b) => a.disabledAt - b.disabledAt);
  }

  public get(providerId: string, keyHashPrefix: string): SuspectCredential | undefined {
    this.ensureLoaded();
    return this.credentials.get(suspectCredentialId(providerId, keyHashPrefix));
  }

  public isSuspect(providerId: string, keyHashPrefix: string): boolean {
    return this.get(providerId, keyHashPrefix) !== undefined;
  }

  public list(): SuspectCredential[] {
    this.ensureLoaded();
    return Array.from(this.credentials.values()).sort((a, b) => a.markedAt - b.markedAt);
  }
}

// ---------------------------------------------------------------------------
// Process-wide default (the boot path uses it; tests inject their own store).
// ---------------------------------------------------------------------------

let defaultStore: CredentialStateStore | null = null;

/**
 * The process-wide store the boot path uses (paths resolved from the real
 * environment at first touch). Anything with an injected `CredentialPaths` —
 * every test — constructs its own `CredentialStateStore` instead.
 */
export function defaultCredentialStateStore(): CredentialStateStore {
  if (!defaultStore) defaultStore = new CredentialStateStore();
  return defaultStore;
}

/** Test seam: drop the memoized default so the next access re-reads env. */
export function resetCredentialStateStoreForTests(): void {
  defaultStore = null;
}
