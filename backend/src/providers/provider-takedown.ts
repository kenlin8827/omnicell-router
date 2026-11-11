import fs from 'node:fs';
import path from 'node:path';
import type { CredentialPaths } from '../opencode/credentials/paths.js';
import { disabledProvidersFile, resolveDefaultPaths } from '../opencode/credentials/paths.js';
import { renameWithRetry } from '../utils/atomic-write.js';

/**
 * Provider-level operator takedown (disable / enable).
 *
 * This is ROUTER state, not connection truth: a disabled provider keeps its
 * defs node, models, credentials and console card — only the routing pool drops
 * it. Persistence is the OCR GLOBAL state root
 * (`<OCR_HOME>/disabled-providers.json`, same root and lifecycle precedent as
 * `suspect-credentials.json`), never `providers.json` — that file is the
 * connection truth AND the sync materializer's source (ADR-0010), so a router
 * control flag written there would travel to client configs.
 *
 * Lifecycle: set only by an operator, lifted only by an operator. Nothing in
 * the resilience plane (cooldown, breaker reset, reconnect, Push) may clear it.
 */

export interface ProviderTakedown {
  providerId: string;
  /** Operator note (display only). */
  reason: string;
  /** Epoch ms of the FIRST takedown (re-disabling keeps it — the age is the audit signal). */
  disabledAt: number;
}

interface TakedownFile {
  version: 1;
  updated: number;
  providers: Record<string, Omit<ProviderTakedown, 'providerId'>>;
}

export interface ProviderTakedownStoreDeps {
  /** Injection seam for tests — same CredentialPaths the stores use. */
  paths?: CredentialPaths;
  now?: () => number;
}

export class ProviderTakedownStore {
  /** Undefined = resolve from the real environment at first touch. */
  private readonly paths: CredentialPaths | undefined;
  private readonly nowFn: () => number;
  private loaded = false;
  private resolvedFile: string | undefined;
  private entries = new Map<string, ProviderTakedown>();
  /** An unparsable file is preserved on the first write, never overwritten blind. */
  private preserveCorrupt = false;

  constructor(deps: ProviderTakedownStoreDeps = {}) {
    this.paths = deps.paths;
    this.nowFn = deps.now ?? Date.now;
  }

  /** Where the takedowns live — log/diagnostic surface, never a secret. */
  public get filePath(): string {
    if (!this.resolvedFile) {
      this.resolvedFile = disabledProvidersFile(this.paths ?? resolveDefaultPaths());
    }
    return this.resolvedFile;
  }

  /** Load-once; a missing or malformed file is an empty set (never fatal). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return; // absent/unreadable -> no takedowns
    }
    let parsed: Partial<TakedownFile>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.preserveCorrupt = true;
      return;
    }
    if (parsed?.version !== 1 || typeof parsed.providers !== 'object' || parsed.providers === null) {
      this.preserveCorrupt = true;
      return;
    }
    for (const [providerId, entry] of Object.entries(parsed.providers)) {
      const e = entry as Partial<ProviderTakedown> | undefined;
      if (!e || typeof e !== 'object') continue;
      this.entries.set(providerId, {
        providerId,
        reason: typeof e.reason === 'string' ? e.reason : '',
        disabledAt: Number.isFinite(e.disabledAt) ? Number(e.disabledAt) : this.nowFn(),
      });
    }
  }

  /** Atomic write (temp + rename), best-effort 0600 — suspect-flags precedent. */
  private persist(): void {
    if (this.preserveCorrupt) {
      this.preserveCorrupt = false;
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt.${this.nowFn()}`);
      } catch {
        // best effort — a rename race must not block the live takedowns
      }
    }
    const providers: TakedownFile['providers'] = {};
    for (const [id, entry] of this.entries) {
      providers[id] = { reason: entry.reason, disabledAt: entry.disabledAt };
    }
    const content = `${JSON.stringify({ version: 1, updated: this.nowFn(), providers } satisfies TakedownFile, null, 2)}\n`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // best effort — Windows chmod semantics differ
    }
    renameWithRetry(tmpPath, this.filePath);
  }

  public isDisabled(providerId: string): boolean {
    this.ensureLoaded();
    return this.entries.has(providerId);
  }

  public get(providerId: string): ProviderTakedown | undefined {
    this.ensureLoaded();
    return this.entries.get(providerId);
  }

  public list(): ProviderTakedown[] {
    this.ensureLoaded();
    return [...this.entries.values()];
  }

  /**
   * Take one provider out of routing. Idempotent: re-disabling keeps the FIRST
   * `disabledAt` and refreshes the note.
   * @returns true when this call created the takedown.
   */
  public disable(providerId: string, reason = ''): boolean {
    this.ensureLoaded();
    const existing = this.entries.get(providerId);
    if (existing) {
      if (existing.reason === reason) return false; // exact re-disable: no write churn
      existing.reason = reason;
      this.persist();
      return false;
    }
    this.entries.set(providerId, { providerId, reason, disabledAt: this.nowFn() });
    this.persist();
    return true;
  }

  /** Put it back in routing (the only path that does). @returns true when lifted. */
  public enable(providerId: string): boolean {
    this.ensureLoaded();
    if (!this.entries.delete(providerId)) return false;
    this.persist();
    return true;
  }
}

let singleton: ProviderTakedownStore | undefined;

/** The process-wide store (boot pool + console routes read the same instance). */
export function getProviderTakedownStore(): ProviderTakedownStore {
  return (singleton ??= new ProviderTakedownStore());
}

/** Test seam: swap the process-wide store (undefined restores the lazy default). */
export function setProviderTakedownStoreForTests(store: ProviderTakedownStore | undefined): void {
  singleton = store;
}
