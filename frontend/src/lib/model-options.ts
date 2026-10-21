/**
 * Shared ordering for model/picker Combobox option lists.
 *
 * Centralised here so every model dropdown orders the same way:
 *   1. pinned values first, in the caller-given order — virtual entries
 *      (`auto`, `combo:*`, …) are pinned explicitly, never left to luck of
 *      the alphabet,
 *   2. the currently selected value,
 *   3. everything else: usage-frequency descending (when the caller supplies
 *      a `usage` map), then label ascending (`localeCompare` — model ids are
 *      ASCII so this is effectively a byte sort).
 *
 * No per-model usage aggregate exists in the backend today, so `usage` is
 * optional and every call site currently degrades to name order. When an
 * aggregate lands, pass it here — do NOT add per-page sorts.
 *
 * The Combobox component itself stays order-agnostic — callers own ordering,
 * the component only filters.
 */
export interface SortableOption {
  value: string;
  label?: string;
  /** Backend catalog namespace tag: 'auto' | 'combo' | 'model' | variant. */
  kind?: string;
}

export interface ModelSortOptions {
  /** Values pinned to the top, in the given order (virtual entries). */
  pinned?: string[];
  /** Currently selected value — placed right after the pinned group. */
  selected?: string;
  /** Optional usage counts (higher = more used = earlier). */
  usage?: Map<string, number>;
}

export function sortModelOptions<T extends SortableOption>(options: readonly T[], opts: ModelSortOptions = {}): T[] {
  const { pinned = [], selected, usage } = opts;
  // Namespace groups stay ahead of everything, mirroring the backend catalog
  // order (console.ts): auto* aliases, then combos, then the rest. A `combo:`
  // value prefix counts too (tier member pickers encode combos that way).
  const groupRank = (o: SortableOption): number => {
    if (o.kind === 'auto' || o.value === 'auto') return 0;
    if (o.kind === 'combo' || o.value.startsWith('combo:')) return 1;
    return 2;
  };
  const rank = (v: string): number => {
    const p = pinned.indexOf(v);
    if (p !== -1) return p;
    if (selected !== undefined && v === selected) return pinned.length;
    return pinned.length + 1;
  };
  const key = (o: T) => o.label ?? o.value;
  return [...options].sort((a, b) => {
    const ga = groupRank(a);
    const gb = groupRank(b);
    if (ga !== gb) return ga - gb;
    const ra = rank(a.value);
    const rb = rank(b.value);
    if (ra !== rb) return ra - rb;
    if (usage) {
      const ua = usage.get(a.value) ?? 0;
      const ub = usage.get(b.value) ?? 0;
      if (ua !== ub) return ub - ua;
    }
    return key(a).localeCompare(key(b));
  });
}
