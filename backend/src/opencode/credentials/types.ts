import { createHash } from 'node:crypto';

/**
 * The single CredentialStore interface
 * with two adapters (OpencodeV2Store / OcrStore). opencode v1 is not supported:
 * auth.json is a migration source that OCR reads once and never writes, so the
 * third auth.json-backed store, its capability set and its degraded code are gone.
 *
 * Hard rules encoded here:
 *  - Callers branch on `capabilities`, NEVER on `kind` (kind is a diagnostic
 *    label for logs/badges only).
 *  - Masked metadata leaves the interface via listCredentials/credentialsOverview;
 *    raw keys exit ONLY through resolveKey/resolveKeyChain —
 *    callable only by boot/pool-rebuild code — and through revealKey, the
 *    single controlled exception bound to the password-gated console reveal
 *    route.
 *  - beginOAuth/completeOAuth exist on the surface but throw
 *    CapabilityUnsupportedError on ALL stores
 *    (OAuth is excluded from every store; the OAuth boundary stays intact).
 */

/** Diagnostic label. Branch on capabilities instead. */
export type StoreKind = 'opencode-v2' | 'opencode-v2-readonly' | 'ocr';

/** Runtime validator for kind strings crossing a boundary (persisted state, REST). */
export function isStoreKind(value: unknown): value is StoreKind {
  return value === 'opencode-v2' || value === 'opencode-v2-readonly' || value === 'ocr';
}

export interface StoreCapabilities {
  /** More than one credential per provider is expressible. */
  multiCredential: boolean;
  /** A specific credential can be marked active. */
  activate: boolean;
  /** Credentials carry a user-editable label. */
  rename: boolean;
  /** OAuth connect is supported. Capability-gated; false for ALL stores in P1+P2. */
  oauth: boolean;
  /**
   * The store coexists with opencode's provider config, where inline
   * `{env:VAR}` / `options.apiKey` keep priority ABOVE the store.
   * False for the OCR-only store, which has no
   * env-templated sibling surface.
   */
  envVisible: boolean;
  /**
   * The sink addresses credentials by a named upstream INTEGRATION, so a provider
   * id with no registered integration can take NO credential write at all — add
   * and rotate both 409 (`opencode v2` only; its integration registry is its own,
   * and a stale credential row keeps ROUTING while being un-writable).
   * When true, `listIntegrationIds()` answers which ids the sink accepts, so a
   * management surface can refuse the gesture BEFORE the operator types a key.
   */
  integrationScoped: boolean;
}

export type CredentialType = 'api' | 'oauth' | 'wellknown' | 'unknown';

/**
 * Machine-readable badge codes (touchpoint gap #8: backend returns codes,
 * frontend renders i18n text). 'bind_failed' = an unexpected crash landed the
 * bind on OcrStore (P1-2: the bind is a total function — it never rejects).
 * 'unsupported_version' = opencode v1 detected: not supported, so credentials are
 * managed in the OCR store instead of silently reading a stale auth.json.
 */
export type StoreDegradedCode =
  | 'db_unreadable'
  | 'unsupported_version'
  | 'cli_absent_db_present'
  | 'bind_failed';

/** Masked, management-safe credential metadata. Never carries raw key material. */
export interface CredentialMeta {
  /** Store-native credential id (opencode v2 credential row id, ocr credentialId). */
  id: string;
  providerId: string;
  label?: string;
  type: CredentialType;
  active: boolean;
  /** False for oauth/wellknown/unknown — listed and badged, never routed. */
  routable: boolean;
  /** Display-safe sha256 prefix. */
  keyHashPrefix?: string;
  /** maskSecret() output — existing masking rule. */
  maskedKey?: string;
}

export interface ResolvedCredential {
  key: string;
  credential: CredentialMeta;
}

/**
 * One credential attached to a boot-built provider
 * instance, selectable per call by its `keyHashPrefix` (Decision 5 identity).
 *
 * SECURITY: `key` is RAW material. Values of this type exist ONLY in process
 * memory (boot payload → registry chain map → executor call argument). They
 * must NEVER be serialized into console/API surfaces — masked metadata keeps
 * travelling through `CredentialMeta` instead.
 */
export interface CallCredential {
  /** Display-safe sha256 prefix — the per-call selector key (Decision 5). */
  keyHashPrefix: string;
  /** Human-readable credential name (falls back to the store credential id). */
  label: string;
  /** Raw key material — in-memory only. */
  key: string;
}

/**
 * Raw credential for the failover pool. Single-key consumers keep using
 * resolveKey (single-key degeneracy = legacy behavior); the chain interface
 * is complete now — later consumers arriving is expected.
 */
export interface RawCred {
  credentialId: string;
  providerId: string;
  label?: string;
  key: string;
  /** sha256 hex of the raw key — the durable identity anchor (Decision 5). */
  keyHash: string;
  active: boolean;
  timeUpdated?: number;
}

export interface StoreProbeResult {
  ok: boolean;
  kind: StoreKind;
  state: 'ready' | 'empty' | 'unreadable';
  degradedCode?: StoreDegradedCode;
  detail?: string;
  credentialCount: number;
}

/** Masked per-provider summary, served inside StoreStatus (B2 console endpoint). */
export interface CredentialOverview {
  providerId: string;
  total: number;
  routable: number;
  activeCredentialId: string | null;
}

/**
 * Which evidence the bind SAW — diagnostics only, it selects nothing (the
 * bind is always the OcrStore). The CLI probe is retired: opencode presence
 * is the sync client's concern (credentials/sync.ts), not a store input.
 */
export interface VersionEvidence {
  /** Always null — the boot CLI probe no longer runs. */
  cli: null;
  file: string | null;
  used: 'installed.version' | 'none';
  /** Always null — hysteresis died with store selection. */
  lastKnownGood: null;
}

/**
 * Security P3-1 — provider ids that must NEVER enter a plain-object providers
 * map: they would re-key into Object.prototype members (prototype pollution
 * on every `{...providers}` / `obj[id]` reader, incl. JSON-parsed auth.json /
 * credentials.json shapes).
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

export interface CredentialStore {
  /** Diagnostic label only — callers MUST branch on capabilities. */
  readonly kind: StoreKind;
  readonly capabilities: StoreCapabilities;

  /**
   * Health snapshot. OpencodeV2Store throws EmptyCredentialTableError (a distinct
   * operational precondition consumers must handle) when the
   * credential table exists but has zero rows; unreadability is reported as a
   * state here instead of throwing (a health check must not throw).
   */
  probe(): StoreProbeResult;

  /** MASKED metadata only — safe for management surfaces. */
  listCredentials(providerId: string): CredentialMeta[];

  /** Active-first, sole-row next, newest time_updated last. Raw — boot/pool-rebuild callers, plus the console test route (sanctioned probe read: the key exits only as the upstream probe header). */
  resolveKey(providerId: string): ResolvedCredential | null;

  /** Ordered pool for failover (active first, then newest time_updated). Raw — boot/pool-rebuild callers, plus the console test route's credential-addressed probe (same exit rule: header only, response masked). */
  resolveKeyChain(providerId: string): RawCred[];

  /**
   * Raw key of ONE addressed credential, for the
   * password-gated console reveal route. Unlike `resolveKey` there is no
   * selection: it takes the credentialId the operator pointed at and returns
   * exactly that row's key. Throws CredentialNotFoundError for an absent row and
   * CapabilityUnsupportedError for a row without raw api-key material
   * (oauth/wellknown/empty key). Callers: the reveal route ONLY — never a
   * list/status/probe surface.
   */
  revealKey(credentialId: string): string;

  connectKey(providerId: string, key: string, label?: string): Promise<CredentialMeta>;
  activate(credentialId: string): Promise<CredentialMeta>;
  rename(credentialId: string, label: string): Promise<CredentialMeta>;
  disconnect(credentialId: string): Promise<void>;

  /** Present on the surface; throws CapabilityUnsupportedError on ALL stores in P1+P2. */
  beginOAuth(providerId: string): Promise<unknown>;
  completeOAuth(providerId: string, interaction?: unknown): Promise<CredentialMeta>;

  /**
   * Only implemented when `capabilities.integrationScoped` is true: the provider
   * ids this sink will accept a credential write for. Resolves to an EMPTY array
   * when the registry itself is unreachable — callers MUST treat empty as
   * "unknown" (do not gate on it), never as "nothing is writable".
   */
  listIntegrationIds?(): Promise<string[]>;

  /** Drop cached views — call after any console credential action (Decision 3 freshness). */
  invalidate(): void;

  /** Masked summary for StoreStatus; implemented by all three stores. */
  credentialsOverview(): CredentialOverview[];
}

// ---------------------------------------------------------------------------
// Error vocabulary: distinct states, distinct handling
// ---------------------------------------------------------------------------

/** The backing store cannot be opened/parsed at all. Distinct from EmptyCredentialTableError. */
export class StoreUnreadableError extends Error {
  constructor(
    readonly reason: 'cannot_open' | 'schema_mismatch',
    detail: string,
    readonly storeFile: string
  ) {
    super(`credential store unreadable (${reason}) [${storeFile}]: ${detail}`);
    this.name = 'StoreUnreadableError';
  }
}

/** Table exists but has zero rows — a valid opencode v2 install that simply holds no credentials yet. */
export class EmptyCredentialTableError extends Error {
  constructor(storeFile: string) {
    super(`credential table is empty [${storeFile}]`);
    this.name = 'EmptyCredentialTableError';
  }
}

/** Capability flag is false for this store (e.g. OAuth everywhere, activate on OpencodeV2Store-readonly). */
export class CapabilityUnsupportedError extends Error {
  constructor(readonly method: string, readonly reason: string) {
    super(`${method} unsupported: ${reason}`);
    this.name = 'CapabilityUnsupportedError';
  }
}

/**
 * An opencode v2 HTTP write failed after the re-read-service.json retry.
 * NEVER falls back to OcrStore — read-side degradation is allowed with a
 * badge; write-side proliferation is not.
 */
export class WriteFailedError extends Error {
  constructor(readonly method: string, detail: string, readonly cause?: unknown) {
    super(`${method} failed against the opencode v2 service: ${detail}`);
    this.name = 'WriteFailedError';
  }
}

/** providerId has no matching opencode v2 integration id — typed so the reconcile step (B3) can consume it. */
export class IntegrationUnmatchedError extends Error {
  constructor(readonly providerId: string, readonly knownIntegrationIds: string[]) {
    super(
      `no opencode v2 integration matches provider '${providerId}' (known: ${knownIntegrationIds.join(', ') || 'none'})`
    );
    this.name = 'IntegrationUnmatchedError';
  }
}

/** credentialId not present in the store (Ocr/V1 local addressing). */
export class CredentialNotFoundError extends Error {
  constructor(credentialId: string) {
    super(`credential credential not found: ${credentialId}`);
    this.name = 'CredentialNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Key identity 
// ---------------------------------------------------------------------------

/** sha256 hex of the raw key — durable identity for breakers/affinity across id/label churn. */
export function sha256KeyHash(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Display-safe prefix of the key hash (logs/traces/console can name an credential without secrets). */
export function keyHashPrefix(rawKey: string, length = 12): string {
  return sha256KeyHash(rawKey).slice(0, length);
}
