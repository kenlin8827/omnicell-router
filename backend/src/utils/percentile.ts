/**
 * Percentile over a sample list, using linear interpolation between closest
 * ranks (the Excel PERCENTILE.INC / NumPy default definition) so a caller
 * never has to know which convention a metric follows.
 *
 * Latency figures are percentiles, never arithmetic means: one 30-second cold
 * start drags a 20-turn mean far past anything a user actually experienced,
 * while P50 stays at the typical turn and P95 surfaces the tail. This is the
 * convention every published LLM latency table uses (Artificial Analysis
 * reports P5/P25/P75/P95; OpenRouter reports P50), and it is why the console
 * shows a session's TTFT as P50 + P95 instead of "average".
 *
 * `p` is a fraction in [0, 1]. Returns undefined for an empty sample list so
 * callers render "—" rather than a fabricated 0.
 */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, p));
  const rank = (sorted.length - 1) * clamped;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}
