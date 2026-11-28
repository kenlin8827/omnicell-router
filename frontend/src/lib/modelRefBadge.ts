import { createElement, type ReactNode } from 'react';
import { Layers } from 'lucide-react';

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

/**
 * Leading glyph for combo refs in model pickers — the Layers mark, the same
 * icon the nav and the combos page use, tinted the combo kind's violet.
 * Sits BEFORE the label so a composite reads as one at first glance; the
 * right-hand chip then names the kind. Single-sourced here: every picker
 * that lists combos renders this exact element (via `modelRefBadge` or
 * direct import), so the mark never drifts between pages.
 */
export const comboOptionIcon = (): ReactNode =>
  createElement(Layers, { size: 12, color: 'var(--accent-violet)', 'aria-hidden': true, style: { flexShrink: 0 } });
export const modelRefBadge = (
  kind: string | undefined,
  t: (path: string) => string,
): { badge?: string; badgeColor?: string; icon?: ReactNode } => {
  switch (kind) {
    case 'auto':
      return { badge: t('modelRef.kindAuto'), badgeColor: 'var(--accent)' };
    case 'tier':
      return { badge: t('modelRef.kindTier'), badgeColor: 'var(--accent-emerald)' };
    case 'combo':
      return { badge: t('modelRef.kindCombo'), badgeColor: 'var(--accent-violet)', icon: comboOptionIcon() };
    case 'variant':
      return { badge: t('modelRef.kindVariant'), badgeColor: 'var(--accent-amber)' };
    default:
      return {};
  }
};
