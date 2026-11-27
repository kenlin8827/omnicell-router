/**
 * Effective model view for ONE API key — what the key can see & use right now.
 * Shared by the admin preview (`GET /api/admin/api-keys/:id/models`) and the
 * follow-catalog auto-resync path so both snapshots stay identical.
 */
import type { ProviderRegistry } from '../providers/registry.js';
import { listApiKeys } from './api-keys.js';
import {
  getModelAccessPolicy,
  isAutoEntryUsable,
  isModelAllowed,
  isModelAllowedInTiers,
  tierFromVirtualEntry,
} from './model-access.js';

export type KeyModelRow = {
  id: string;
  kind: 'auto' | 'tier' | 'combo' | 'model' | 'variant';
  provider: string;
  tiers?: string[];
  tier?: string;
  virtual: boolean;
  allowed: boolean;
};

export type KeyModelsView = {
  status: 'ok';
  mode: string;
  policyModels: string[];
  models: KeyModelRow[];
};

export type KeyModelsLookupError = {
  status: 'error';
  message: string;
};

/**
 * Build the effective catalog for `keyId`. Returns an error shape when the key
 * is unknown so callers can map to 404 without re-implementing the lookup.
 */
export function buildKeyModelsView(
  keyId: string,
  registry: ProviderRegistry,
): KeyModelsView | KeyModelsLookupError {
  const key = listApiKeys(false).find((k) => k.id === keyId);
  if (!key) {
    return { status: 'error', message: `API Key '${keyId}' not found` };
  }
  const policy = getModelAccessPolicy(key);
  const registered: KeyModelRow[] = registry.getAllModels().map((m) => ({
    id: m.id,
    kind: 'model' as const,
    provider: m.provider,
    // FULL membership set (pools are a per-tier projection — a model may
    // belong to several tiers): tierAllowed counts every pool the model can
    // route toward, so auto-X viability never misses a multi-pool member.
    tiers: registry.tiersOf(m) as string[],
    virtual: false,
    allowed: isModelAllowedInTiers(m.id, policy, registry.tiersOf(m)),
  }));
  const tierAllowed = (t: string) => registered.some((m) => m.tiers?.includes(t) && m.allowed);
  // Virtual auto* rows honor runtime viability (mirrors /v1/models): bare
  // `auto` needs an allowed model in ANY tier, auto-X in tier X.
  const virtual: KeyModelRow[] = ['auto', 'lite', 'plus', 'pro', 'ultra'].map((id) => ({
    id,
    kind: (id === 'auto' ? 'auto' : 'tier') as 'auto' | 'tier',
    provider: 'omnicell-router',
    tier: tierFromVirtualEntry(id),
    virtual: true,
    allowed: isAutoEntryUsable(id, policy, tierAllowed),
  }));
  // Combo rows (mirrors /v1/models): routable virtual ids, but concrete
  // selectable entries — NOT auto*-virtual, so follow-mode snapshots keep
  // them. A combo passes only when EVERY member is allowed (the inference
  // entry gate; no silent composition change).
  const combos: KeyModelRow[] = registry.getCombos().map((c) => ({
    id: c.id,
    kind: 'combo' as const,
    provider: 'omnicell-router',
    tier: '',
    virtual: false,
    allowed: registry.resolveCombo(c.id).every((mem) => isModelAllowed(mem.id, policy, mem.tier)),
  }));
  // Variant rows (mirrors /v1/models): `base-variant` ids resolve to the
  // base model with a pinned reasoning effort; the policy verdict inherits
  // from the base id.
  const variants: KeyModelRow[] = registry.getVariantExposures().map(({ id, base }) => ({
    id,
    kind: 'variant' as const,
    provider: base.provider,
    tiers: registry.tiersOf(base) as string[],
    virtual: false,
    allowed: isModelAllowedInTiers(base.id, policy, registry.tiersOf(base)),
  }));
  // Order mirrors the /v1/models wire body EXACTLY (the console list is a
  // pure re-rendering of that payload — same rows, same sequence). The wire
  // builds a provider map whose insertion order IS the display order: the
  // omnicell-router virtual provider (auto alias → tier aliases → combos)
  // first, then concrete providers in registry first-appearance order, each
  // carrying its concrete models then its variant siblings.
  const providerRows = new Map<string, KeyModelRow[]>();
  const ensureProviderRows = (pid: string) => {
    let rows = providerRows.get(pid);
    if (!rows) {
      rows = [];
      providerRows.set(pid, rows);
    }
    return rows;
  };
  for (const m of registry.getAllModels()) {
    ensureProviderRows(m.provider).push(registered.find((r) => r.id === m.id)!);
  }
  for (const v of variants) ensureProviderRows(v.provider).push(v);
  const models = [
    ...virtual,
    ...combos,
    ...[...providerRows.entries()].filter(([pid]) => pid !== 'omnicell-router').flatMap(([, rows]) => rows),
  ];
  return {
    status: 'ok',
    mode: policy?.mode ?? 'none',
    policyModels: policy?.models ?? [],
    models,
  };
}

/** Allowed concrete / virtual ids for a follow-mode snapshot. */
export function allowedFollowLists(view: KeyModelsView): {
  extraModels: string[];
  virtualModels: string[];
  allAllowedIds: string[];
} {
  const extraModels = view.models.filter((m) => !m.virtual && m.allowed).map((m) => m.id);
  const virtualModels = view.models.filter((m) => m.virtual && m.allowed).map((m) => m.id);
  return {
    extraModels,
    virtualModels,
    allAllowedIds: [...virtualModels, ...extraModels],
  };
}
