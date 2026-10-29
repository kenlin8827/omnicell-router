import type { BreakerInfo, CredentialHealth } from './api';

/**
 * Pure (model × credential) matrix builder for the guardrails grid
 * Lives apart from the page so the join/fold
 * semantics — the load-bearing rules of the view — carry a runnable check
 * (scripts/check-guardrails-matrix.ts) without a browser.
 */

const STATE_ORDER: Record<BreakerInfo['state'], number> = { OPEN: 0, HALF_OPEN: 1, CLOSED: 2 };

/**
 * The grid unit: one (model × credential) tuple — the atomic breaker key.
 *
 * `snap` resolves the tuple's own breaker state:
 *   pair breaker    — the tuple's state machine (scope label explains the
 *                     blast radius: 'pair' | 'credential' | 'model')
 *   sentinel        — a single-credential chain routes through the '' tuple,
 *                     which IS this credential's breaker
 *   model fold      — single-credential chains fall back to the derived model
 *                     fold when the sentinel has no state yet
 *   undefined       — never failed on this pairing, no breaker yet
 */
export interface PairCard {
  key: string;
  modelId: string;
  provider: string;
  /** Store credential identity; '' for the synthetic config-key column. */
  prefix: string;
  credentialId?: string;
  label: string;
  /** True for the config-baked single key of a chainless provider. */
  synthetic: boolean;
  /** Breaker prefix matched neither the store roster nor the runtime key
   *  directory (rotated key / store unreadable) — the label is a bare #hash. */
  unmatched?: boolean;
  maskedKey?: string;
  suspect: boolean;
  disabled: boolean;
  disabledReason?: string;
  snap?: BreakerInfo;
  /** The snapshot's OWN tuple key — where recovery must aim. Differs from
   *  `prefix` only for the sentinel ('') single-credential fallback: the card
   *  represents the store credential, but the trip lives on the sentinel tuple. */
  snapPrefix?: string;
  snapSource: 'pair' | 'model-mirror';
  /** The DERIVED model fold (worst tuple state) — display/button context only,
   *  never painted onto this card's own state. */
  modelSnap?: BreakerInfo;
  chainLen: number;
}

/** Runtime credential hashes exposed by /api/admin/status (`credentialHashes`). */
export interface CredentialHash {
  provider: string;
  keyHashPrefix: string;
}

/** Injected display strings — the module stays i18n-free to stay testable. */
export interface MatrixLabels {
  /** Stand-in for an unlabeled store row (i18n key: credentialUnnamed). */
  unnamed: string;
  /** Display name for the provider's config-baked key. */
  configKey: string;
}

/**
 * The card's own truth is ITS tuple breaker — pure breaker state. Operator
 * takedowns (DISABLED/SUSPECT) are a SEPARATE dimension (a management action,
 * not a breaker transition): they surface as the 已停用 badge + the dedicated
 * filter tab, never folded into the trip state. The derived model fold never
 * paints onto the card: a model-scope trip already lands on every tuple, so
 * a tripped card IS tripped, and a healthy card stays healthy even when a
 * sibling credential is cooling down (no more cross-credential pollution).
 */
export function effectiveState(c: PairCard): BreakerInfo['state'] {
  return c.snap?.state ?? 'CLOSED';
}

/** Routing truth (`isPairOut`): selection will NEVER pick this pairing. */
export function isTakenDown(c: PairCard): boolean {
  return c.disabled || c.suspect;
}

export function effectiveCooldown(c: PairCard): number {
  return c.snap?.remainingCooldownMs ?? 0;
}

export function buildPairCards(
  modelBreakers: BreakerInfo[],
  pairBreakers: BreakerInfo[],
  storeCredentials: CredentialHealth[],
  credentialHashes: CredentialHash[],
  labels: MatrixLabels
): PairCard[] {
  const pairBy = new Map<string, BreakerInfo>();
  for (const p of pairBreakers) {
    // `''` (sentinel chain-less tuple) is a valid key — only undefined is absent.
    if (p.keyHashPrefix !== undefined) pairBy.set(`${p.modelId}#${p.keyHashPrefix}`, p);
  }
  const credentialsByProvider = new Map<string, CredentialHealth[]>();
  for (const a of storeCredentials) {
    if (!a.keyHashPrefix) continue;
    const arr = credentialsByProvider.get(a.providerId);
    if (arr) arr.push(a);
    else credentialsByProvider.set(a.providerId, [a]);
  }
  const items: PairCard[] = [];
  const covered = new Set<string>();
  for (const b of modelBreakers) {
    const accts = credentialsByProvider.get(b.provider) ?? [];
    if (accts.length === 0) {
      // Chainless provider (mock/stub call sites): one synthetic column.
      items.push({
        key: `${b.modelId}#@config`,
        modelId: b.modelId,
        provider: b.provider,
        prefix: '',
        label: labels.configKey,
        synthetic: true,
        suspect: false,
        disabled: false,
        snap: b,
        snapSource: 'model-mirror',
        modelSnap: b,
        chainLen: 1,
      });
      continue;
    }
    for (const a of accts) {
      const prefix = a.keyHashPrefix!;
      const pairSnap = pairBy.get(`${b.modelId}#${prefix}`);
      // A single-credential chain routes through the SENTINEL '' tuple (the
      // config-baked key); fall back to it before degenerating to the fold.
      const sentinelSnap = accts.length === 1 ? pairBy.get(`${b.modelId}#`) : undefined;
      covered.add(`${b.modelId}#${prefix}`);
      items.push({
        key: `${b.modelId}#${prefix}`,
        modelId: b.modelId,
        provider: b.provider,
        prefix,
        credentialId: a.id,
        // KeysPage convention (credentialName): unlabeled rows read the
        // credentialUnnamed stand-in — never the raw internal credentialId,
        // never an invented name.
        label: a.label?.trim() || labels.unnamed,
        synthetic: false,
        maskedKey: a.maskedKey,
        suspect: a.suspect,
        disabled: a.disabled,
        disabledReason: a.disabledReason,
        snap: pairSnap ?? sentinelSnap ?? (accts.length === 1 ? b : undefined),
        snapPrefix: pairSnap ? prefix : sentinelSnap ? '' : undefined,
        snapSource: pairSnap || sentinelSnap ? 'pair' : 'model-mirror',
        modelSnap: b,
        chainLen: accts.length,
      });
    }
  }
  // Orphan pair breakers: the model left the registry, or the prefix belongs
  // to a serving key the store roster does not list (the inline config-baked
  // chain head — boot-direct unshifts it outside the store). Identify the
  // latter through the runtime credential directory before falling back to a
  // bare #hash + unmatched explanation.
  for (const p of pairBreakers) {
    // The matrix module OWNS this orphan contract (pinned by
    // scripts/check-guardrails-matrix): a tuple whose model left the registry
    // still renders — dropping it would hide a live breaker.
    if (p.keyHashPrefix === undefined || covered.has(`${p.modelId}#${p.keyHashPrefix}`)) continue;
    const a = storeCredentials.find((x) => x.keyHashPrefix === p.keyHashPrefix);
    const isServingKey = credentialHashes.some(
      (h) => h.keyHashPrefix === p.keyHashPrefix && h.provider === p.provider
    );
    items.push({
      key: `${p.modelId}#${p.keyHashPrefix}`,
      modelId: p.modelId,
      provider: p.provider,
      prefix: p.keyHashPrefix,
      credentialId: a?.id,
      label: a ? a.label?.trim() || labels.unnamed : isServingKey ? labels.configKey : `#${p.keyHashPrefix}`,
      synthetic: false,
      unmatched: !a && !isServingKey,
      maskedKey: a?.maskedKey,
      suspect: a?.suspect ?? false,
      disabled: a?.disabled ?? false,
      disabledReason: a?.disabledReason,
      snap: p,
      snapSource: 'pair',
      modelSnap: modelBreakers.find((b) => b.modelId === p.modelId),
      chainLen: a ? 1 : 0,
    });
  }
  return items;
}
