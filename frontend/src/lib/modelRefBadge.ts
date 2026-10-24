/**
 * Micro-badge mapping for gateway-addressable model refs.
 *
 * `/api/admin/gateway-models` tags every id with a `kind` (auto / tier /
 * combo / model / variant) because `owned_by` cannot distinguish them:
 * virtual ids and combos share the 'omnicell-router' owner, variants share
 * their base model's provider. `auto` is the true cross-tier auto-routing
 * alias; the bare tier aliases (lite/plus/pro/ultra) are pinned-tier entries.
 * Model pickers render the kind as a tiny outline chip;
 * plain registered models get NO chip — absence is the default state.
 */
export const modelRefBadge = (
  kind: string | undefined,
  t: (path: string) => string,
): { badge?: string; badgeColor?: string } => {
  switch (kind) {
    case 'auto':
      return { badge: t('modelRef.kindAuto'), badgeColor: 'var(--accent)' };
    case 'tier':
      return { badge: t('modelRef.kindTier'), badgeColor: 'var(--accent-emerald)' };
    case 'combo':
      return { badge: t('modelRef.kindCombo'), badgeColor: 'var(--accent-violet)' };
    case 'variant':
      return { badge: t('modelRef.kindVariant'), badgeColor: 'var(--accent-amber)' };
    default:
      return {};
  }
};
