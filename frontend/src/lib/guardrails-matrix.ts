import type { BreakerInfo, CredentialHealth } from './api';

/**
 * Pure (model × credential) matrix builder for the guardrails grid
 * Lives apart from the page so the join/fold
 * semantics — the load-bearing rules of the view — carry a runnable check
 * (scripts/check-guardrails-matrix.ts) without a browser.
 */

const STATE_ORDER: Record<BreakerInfo['state'], number> = { OPEN: 0, HALF_OPEN: 1, CLOSED: 2 };

/**
 * The grid unit: one (model × credential) pairing.
 *
 * `snap` resolves the credential-scoped truth:
 *   pair breaker    — multi-credential providers attribute failures here
 *   model-mirror    — single-credential chains degenerate to the no-prefix
 *                     runtime path (credential-selection), so the model breaker
 *                     IS this credential's state for this model
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
  snapSource: 'pair' | 'model-mirror';
  /** The model-level breaker snapshot (effective-state input), when any. */
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

/** A pair's effective health folds the model breaker: a model-level trip
 *  (upstream 5xx) takes every credential of that model down together. */
export function effectiveState(c: PairCard): BreakerInfo['state'] {
  const a = c.snap?.state ?? 'CLOSED';
  const b = c.modelSnap?.state ?? 'CLOSED';
  return STATE_ORDER[a] <= STATE_ORDER[b] ? a : b;
}

export function effectiveCooldown(c: PairCard): number {
  return Math.max(c.snap?.remainingCooldownMs ?? 0, c.modelSnap?.remainingCooldownMs ?? 0);
}

export function buildPairCards(
  modelBreakers: BreakerInfo[],
  pairBreakers: BreakerInfo[],
  storeCredentials: CredentialHealth[],
  maskedKeyByProvider: Map<string, string>,
  credentialHashes: CredentialHash[],
  labels: MatrixLabels
): PairCard[] {
  const pairBy = new Map<string, BreakerInfo>();
  for (const p of pairBreakers) {
    if (p.keyHashPrefix) pairBy.set(`${p.modelId}#${p.keyHashPrefix}`, p);
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
      // Chainless provider: one synthetic column for the config-baked key.
      items.push({
        key: `${b.modelId}#@config`,
        modelId: b.modelId,
        provider: b.provider,
        prefix: '',
        label: labels.configKey,
        synthetic: true,
        maskedKey: maskedKeyByProvider.get(b.provider),
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
        snap: pairSnap ?? (accts.length === 1 ? b : undefined),
        snapSource: pairSnap ? 'pair' : 'model-mirror',
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
  const modelBy = new Map<string, BreakerInfo>();
  for (const b of modelBreakers) modelBy.set(b.modelId, b);
  for (const p of pairBreakers) {
    if (!p.keyHashPrefix || covered.has(`${p.modelId}#${p.keyHashPrefix}`)) continue;
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
      maskedKey: a?.maskedKey ?? (isServingKey ? maskedKeyByProvider.get(p.provider) : undefined),
      suspect: a?.suspect ?? false,
      disabled: a?.disabled ?? false,
      disabledReason: a?.disabledReason,
      snap: p,
      snapSource: 'pair',
      modelSnap: modelBy.get(p.modelId),
      chainLen: a ? 1 : 0,
    });
  }
  return items;
}
