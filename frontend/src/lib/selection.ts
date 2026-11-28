/**
 * Selection-strategy vocabulary — the client mirror of backend
 * `providers/selection.ts`. ONE declaration shared by the API types and both
 * editors (combos + tier policies); no page re-declares the union or the
 * normalizer, so a vocabulary edit lands in a single place.
 */
export type SelectionStrategy = 'priority' | 'weighted_round_robin' | 'round_robin';

/** Unknown / absent → the default `priority`; only the three strategies pass. */
export function normalizeSelection(value: unknown): SelectionStrategy {
  return value === 'weighted_round_robin' || value === 'round_robin' ? value : 'priority';
}
