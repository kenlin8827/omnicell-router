/**
 * Primary-pick selection for tier pools and combos — ONE algorithm family, ONE
 * vocabulary shared by both surfaces.
 *
 * Strategies (the industry-standard trio):
 * - `priority`             — the chain head (config/rule order, weight desc)
 *                            serves; failover walks the rest of the chain.
 *                            This is the failover axis, not a load-balancing
 *                            algorithm.
 * - `weighted_round_robin` — smooth WEIGHTED round-robin (SWRR): every member
 *                            is served in proportion to its weight, with the
 *                            turns spread evenly (this replaced the retired
 *                            weighted-RANDOM draw).
 * - `round_robin`          — plain (sequential) round-robin: members take
 *                            turns equally; weights are ignored.
 *
 * `weighted_round_robin` and `round_robin` run through the SAME smooth
 * round-robin core; they differ only in the weight policy (declared share vs
 * uniform 1). There is NO legacy spelling: a value that names none of the
 * three strategies resolves to the default (`priority`).
 */

export type SelectionStrategy = 'priority' | 'weighted_round_robin' | 'round_robin';

/**
 * Hard ceiling for a member weight. The smooth core accumulates credit in a JS
 * number, so an unbounded value (`Infinity` from YAML `.inf` / `1e309`, or a
 * float near the maximum added twice) overflows the accumulator to `Infinity`
 * and then poisons the cursor with `NaN`. Clamping here keeps every weight
 * finite while leaving realistic rotation shares untouched.
 */
export const MAX_MEMBER_WEIGHT = 1_000_000;

/** Resolve a member weight: NaN and sub-1 values mean 1; a non-finite
 *  (Infinity from YAML `.inf` / `1e309`) or overflowing value is clamped to
 *  `MAX_MEMBER_WEIGHT` — the intent `as heavy as possible` stays honoured and
 *  the accumulator stays finite. */
export function normalizeMemberWeight(value: unknown): number {
  const n = Number(value);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, MAX_MEMBER_WEIGHT);
}

/**
 * Normalize a stored strategy value. The three known strategies pass through;
 * everything else — absent, unknown, or the retired `weighted` spelling of the
 * old weighted-RANDOM draw — falls back to the default `priority`.
 */
export function normalizeSelectionStrategy(value: unknown): SelectionStrategy {
  return value === 'weighted_round_robin' || value === 'round_robin' ? value : 'priority';
}

/** Plain-object guard for the config fragments this helper walks. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Canonicalize every PRESENT `selection` value in a config-shaped container:
 * `tiers.<tier>.selection` and `combos[].selection` (the runtime flat shape and
 * the disk `routing.*` shape share this layout, so one walker serves both).
 *
 * Called at every config boundary — the runtime read (loadConfig), the visual
 * save (saveConfig) and the raw-YAML save (saveRawConfig) — so runtime consumers
 * only ever see one of the three strategies and no write path can persist an
 * unknown or retired spelling.
 *
 * An ABSENT `selection` is left absent (it already means the default); only a
 * present value is rewritten. `normalizeSelectionStrategy` owns the mapping —
 * unknown / retired spellings become `priority`.
 *
 * @returns true when at least one value changed.
 */
export function canonicalizeSelectionValues(container: unknown): boolean {
  if (!isPlainObject(container)) return false;
  let changed = false;

  const canonicalizeEntry = (entry: unknown): void => {
    if (!isPlainObject(entry) || !('selection' in entry)) return;
    const canonical = normalizeSelectionStrategy(entry.selection);
    if (entry.selection !== canonical) {
      entry.selection = canonical;
      changed = true;
    }
  };

  const tiers = container.tiers;
  if (isPlainObject(tiers)) {
    for (const entry of Object.values(tiers)) canonicalizeEntry(entry);
  }

  const combos = container.combos;
  if (Array.isArray(combos)) {
    for (const entry of combos) canonicalizeEntry(entry);
  }

  return changed;
}

interface CursorState {
  /** Member ids (in pool order) the credit vector was built for. */
  ids: string[];
  /** Rotation weights (normalized, in pool order) the credit was built for. */
  weights: number[];
  /** Running credit per member (smooth round-robin state). */
  current: number[];
}

/**
 * Smooth round-robin core (the nginx SWRR algorithm), shared by tier pools and
 * combos so both surfaces rotate identically.
 *
 * Each pick adds every member's weight to its running credit, serves the
 * highest credit and debits the pool's total weight from it. With weighted
 * members each is served exactly `weight` times per cycle, interleaved as
 * evenly as the weights allow (weights 5:1:1 → a, a, b, a, c, a, a — a
 * burst-free rotation); with uniform weights it degenerates to plain
 * round-robin (a, b, c, a, …).
 *
 * O(n) time and O(n) state per pool: unlike the retired "expand each member
 * into `weight` consecutive slots" table, a six-digit weight costs nothing and
 * every pool read stays linear in the member count.
 *
 * State is scoped by a caller-chosen key (tier + strategy / combo id +
 * strategy). A pool whose member sequence OR declared weights change starts a
 * fresh vector on the next pick, so a stale credit vector can never steer a
 * new composition — and a pool shrunk to one member resets here too (the
 * recovered pool must not resume credit accumulated before the shrink).
 */
export class WeightedRoundRobin {
  private state = new Map<string, CursorState>();

  /**
   * One draw over `entries`. `idOf` identifies a member (pool identity) and
   * `weightOf` returns its rotation weight (values below 1 / non-numeric
   * degrade to 1, a non-finite value clamps to MAX_MEMBER_WEIGHT — matching
   * the config contract); pass `() => 1` for plain round-robin.
   */
  pick<T>(
    key: string,
    entries: readonly T[],
    idOf: (entry: T) => string,
    weightOf: (entry: T) => number
  ): T {
    if (entries.length === 0) throw new Error('WeightedRoundRobin.pick: empty pool');

    const ids = entries.map(idOf);
    const weights = entries.map((entry) => normalizeMemberWeight(weightOf(entry)));
    let cursor = this.state.get(key);
    if (
      !cursor ||
      cursor.ids.length !== ids.length ||
      cursor.ids.some((id, i) => id !== ids[i]) ||
      cursor.weights.some((w, i) => w !== weights[i])
    ) {
      cursor = { ids, weights, current: ids.map(() => 0) };
      this.state.set(key, cursor);
    }

    // One member: its credit nets to zero every pick (add its weight, then
    // debit the same total), so serve it without advancing the vector. The
    // identity check above still reset a stale vector when the pool shrank.
    if (entries.length === 1) return entries[0];

    let total = 0;
    let best = 0;
    for (let i = 0; i < entries.length; i++) {
      cursor.current[i] += weights[i];
      total += weights[i];
      if (cursor.current[i] > cursor.current[best]) best = i;
    }
    cursor.current[best] -= total;
    return entries[best];
  }

  /** Drop one pool's cursor (membership/order changed) or every cursor. */
  reset(key?: string): void {
    if (key === undefined) this.state.clear();
    else this.state.delete(key);
  }
}
