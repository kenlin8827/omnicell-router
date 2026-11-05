/**
 * Sweep-interval contract shared by every periodic prober — `QuotaProber`
 * (backend/src/quota/prober.ts) and `ActiveHealthProber`
 * (backend/src/resilience/health-prober.ts). It lives in utils because
 * resilience must not import from quota for a six-line clamp.
 */

/** Sweep tick when neither the caller nor the config supplies one. */
export const DEFAULT_PROBE_INTERVAL_MS = 60_000;

/** [10 s, 1 h] clamp; absent / non-finite / non-positive input falls back to
 *  the default tick — a NaN interval would otherwise reach setInterval as
 *  ~0 ms and hammer the upstream with a busy sweep. */
export function clampProbeIntervalMs(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_PROBE_INTERVAL_MS;
  return Math.max(10_000, Math.min(3_600_000, ms));
}
