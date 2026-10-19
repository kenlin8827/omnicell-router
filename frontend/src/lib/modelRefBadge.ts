/**
 * Micro-badge mapping for gateway-addressable model refs.
 *
 * `/api/admin/gateway-models` tags every id with a `kind` (auto / combo /
 * model / variant) because `owned_by` cannot distinguish them: auto* and
 * combos share the 'onecast-router' owner, variants share their base
 * model's provider. Model pickers render the kind as a tiny outline chip;
 * plain registered models get NO chip — absence is the default state.
 */
export const modelRefBadge = (
  kind: string | undefined,
  t: (path: string) => string,
): { badge?: string; badgeColor?: string } => {
  switch (kind) {
    case 'auto':
      return { badge: t('modelRef.kindAuto'), badgeColor: 'var(--accent)' };
    case 'combo':
      return { badge: t('modelRef.kindCombo'), badgeColor: 'var(--accent-violet)' };
    case 'variant':
      return { badge: t('modelRef.kindVariant'), badgeColor: 'var(--accent-amber)' };
    default:
      return {};
  }
};
