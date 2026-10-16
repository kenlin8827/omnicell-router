import type { RouterConfig } from '../config/types.js';
import { keyHashPrefix } from '../opencode/credentials/types.js';
import { buildEffectivePlan, probePair, clampTtl, type EffectiveQuotaPlan, type QuotaTarget } from './engine.js';
import { getQuotaStore } from './store.js';

/**
 * Due-based quota scheduler, shaped after
 * resilience/health-prober.ts (the due-decision/execution split is borrowed
 * as an IDEA, the code is original): a fixed tick plans which pairs are due
 * and runs them inside one in-flight guard, with jitter so a fleet of
 * credentials never stamps the same upstream endpoint at the same second.
 *
 * Activation follows credentials (the coverage principle): a pair is a
 * candidate whenever its provider has an effective entry (built-in L-b/L-c or
 * config L-d) AND the credential exists — the registry chain entry when the
 * provider carries a chain, the inference-baked key otherwise (the same
 * single-credential degeneracy the ratelimit subject uses). No account-pool
 * snapshot ever gates coverage.
 *
 * 429 handling is ENGINE-LEVEL GLOBAL logic (never per entry): any 429 pauses
 * the whole scheduler with exponential backoff — quota endpoints are shared
 * infrastructure and one capped response means "everyone slow down".
 *
 * Probe failure is never a quota failure: the previous snapshot is kept and
 * marked stale (via the store), no breaker record, no SUSPECT, no takedown.
 * The declared cap only displays; routing gating is explicitly out of scope
 * (a stale config must not evict a healthy pair).
 */

export interface QuotaPairCandidate {
  providerId: string;
  keyHashPrefix: string;
  /** Raw key — in-process only (the credential store's consumer contract). */
  key: string;
}

export interface QuotaRegistryView {
  /** Credential chains (chain entries carry prefix + raw key + label). */
  getCredentialChain(name: string): { keyHashPrefix: string; key: string }[] | undefined;
  /** Provider config-baked inference key (chain-less degeneracy). */
  getProviderApiKey(name: string): string | undefined;
  /** Provider inference baseURL — the L-d origin containment anchor. */
  getProviderBaseUrl(name: string): string | undefined;
}

/** Per-pair scheduling state — deliberately tiny (no result caching here). */
interface PairState {
  nextDueAtMs: number;
  consecutiveFailures: number;
}

const DEFAULT_TICK_MS = 60_000;
/** Fraction of the TTL randomized per due date (spread, never a stampede). */
const JITTER_FRACTION = 0.15;
/** Engine-level 429 backoff: base, factor, ceiling. */
const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_CEILING_MS = 3 * 3_600_000;
/** Per-pair failure backoff before a retry is scheduled (capped, < TTL). */
const FAILURE_RETRY_BASE_MS = 10 * 60_000;

export interface QuotaProberDeps {
  registry: QuotaRegistryView;
  config: () => RouterConfig;
  intervalMs?: number;
  /** Test seam — plan() resolves pairs through this, run() fetches through it. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class QuotaProber {
  private readonly registry: QuotaRegistryView;
  private readonly configFn: () => RouterConfig;
  private readonly intervalMs: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly nowFn: () => number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private plan: EffectiveQuotaPlan;
  /** Pair key (`provider#prefix`) -> scheduling state. */
  private state = new Map<string, PairState>();
  /** ENGINE-LEVEL 429 gate (global — scheduling is engine-level logic). */
  private rateLimitedUntilMs = 0;
  private rateLimitStreak = 0;

  constructor(deps: QuotaProberDeps) {
    this.registry = deps.registry;
    this.configFn = deps.config;
    this.intervalMs = deps.intervalMs ?? QuotaProber.clampInterval(deps.config().quota?.intervalMs ?? DEFAULT_TICK_MS);
    this.fetchImpl = deps.fetchImpl;
    this.nowFn = deps.now ?? Date.now;
    this.plan = this.buildPlan();
  }

  /** Rebuild the effective entry set (boot + every config save hot path). */
  public reloadConfig(): void {
    this.plan = this.buildPlan();
  }

  private buildPlan(): EffectiveQuotaPlan {
    const cfg = this.configFn();
    return buildEffectivePlan(cfg.quotaProbes, (pid) => this.registry.getProviderBaseUrl(pid));
  }

  /** intervalMs clamp (constructor + docs): [10 s, 1 h]. */
  static clampInterval(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TICK_MS;
    return Math.max(10_000, Math.min(3_600_000, ms));
  }

  /** Entries rejected at load (validation failures) — console surfaces them. */
  public getRejectedEntries(): { id: string; error: string }[] {
    return this.plan.rejected;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // Background probe cycles swallow scheduling errors — next tick retries.
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Decide this tick's probes WITHOUT executing or arming anything (the
   * health-prober split: plan is pure and assertable; arming happens in
   * runOne, so inspecting a plan never consumes a schedule slot). Honors:
   * the global 429 gate, per-pair due dates, and a small per-tick cap
   * (pairs never probe the world all at once).
   */
  public planProbes(now: number = this.nowFn()): QuotaPairCandidate[] {
    // Kill switch is honored live, not only at boot: saving quota.enabled:false
    // must stop outbound probing without a restart (and true must resume it).
    if (this.configFn().quota?.enabled === false) return [];
    if (now < this.rateLimitedUntilMs) return [];
    const out: QuotaPairCandidate[] = [];
    for (const [providerId, target] of this.plan.byProvider) {
      for (const pair of this.pairsOf(providerId)) {
        const key = `${providerId}#${pair.keyHashPrefix}`;
        const st = this.state.get(key);
        if (st && now < st.nextDueAtMs) continue;
        // First sighting (no state) schedules immediately — activation
        // follows credentials (the coverage principle).
        if (out.length >= QuotaProber.MAX_PER_TICK) break;
        void target; // (targets are resolved again in runOne — one source of truth)
        out.push(pair);
      }
      if (out.length >= QuotaProber.MAX_PER_TICK) break;
    }
    return out;
  }

  private static readonly MAX_PER_TICK = 6;

  /** Resolve one provider's credential pairs: chain entries, or the
   *  config-baked inference key (chain-less degeneracy). */
  private pairsOf(providerId: string): QuotaPairCandidate[] {
    const chain = this.registry.getCredentialChain(providerId);
    if (chain && chain.length > 0) {
      return chain.map((c) => ({ providerId, keyHashPrefix: c.keyHashPrefix, key: c.key }));
    }
    const baked = this.registry.getProviderApiKey(providerId);
    if (baked) {
      return [{ providerId, keyHashPrefix: keyHashPrefix(baked), key: baked }];
    }
    return [];
  }

  /** Plan + run one cycle (the entry point the timer calls; also testable). */
  public async tick(now: number = this.nowFn()): Promise<{ probed: number }> {
    if (this.running) return { probed: 0 };
    this.running = true;
    try {
      const candidates = this.planProbes(now);
      let probed = 0;
      for (const pair of candidates) {
        await this.runOne(pair, now);
        probed++;
      }
      return { probed };
    } finally {
      this.running = false;
    }
  }

  private async runOne(pair: QuotaPairCandidate, now: number): Promise<void> {
    const target = this.plan.byProvider.get(pair.providerId);
    if (!target) return;
    const key = `${pair.providerId}#${pair.keyHashPrefix}`;
    const result = await probePair(target, {
      providerId: pair.providerId,
      key: pair.key,
      prefix: pair.keyHashPrefix,
      fetchImpl: this.fetchImpl,
      now: this.nowFn,
    });

    if (result.rateLimited) {
      // ENGINE-LEVEL GLOBAL backoff (not per-entry): one capped endpoint means
      // the whole scheduler pauses, exponential, capped.
      this.rateLimitStreak++;
      const backoff = Math.min(
        RATE_LIMIT_BACKOFF_BASE_MS * 2 ** (this.rateLimitStreak - 1),
        RATE_LIMIT_BACKOFF_CEILING_MS
      );
      this.rateLimitedUntilMs = now + backoff;
    } else if (result.outcome.ok) {
      this.rateLimitStreak = 0;
      const ttl = target.kind === 'dsl' ? clampTtl(target.entry.cacheTtlMs) : 15 * 60_000;
      // Arm the next due date with jitter (spread, never a stampede).
      const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
      this.state.set(key, { nextDueAtMs: now + Math.round(ttl * jitter), consecutiveFailures: 0 });
    } else {
      const st = this.state.get(key) ?? { nextDueAtMs: 0, consecutiveFailures: 0 };
      const failures = st.consecutiveFailures + 1;
      const ttl = target.kind === 'dsl' ? clampTtl(target.entry.cacheTtlMs) : 15 * 60_000;
      const retry = Math.min(FAILURE_RETRY_BASE_MS * 2 ** Math.min(6, failures - 1), ttl);
      this.state.set(key, { nextDueAtMs: now + retry, consecutiveFailures: failures });
      // Probe failure ≠ quota failure: NO breaker record, NO suspect, NO
      // takedown. staleness lives entirely in the snapshot store.
    }
  }

  /** Test seam: current engine-level 429 gate. */
  public getRateLimitedUntil(): number {
    return this.rateLimitedUntilMs;
  }

  /** Force one pair due now (console "refresh quota" button). */
  public invalidatePair(providerId: string, keyHashPrefix: string): void {
    this.state.delete(`${providerId}#${keyHashPrefix}`);
  }

  /** Full reset of scheduling state (tests + config reload storms). */
  public resetScheduling(): void {
    this.state.clear();
    this.rateLimitedUntilMs = 0;
    this.rateLimitStreak = 0;
  }

  /** Read-only view of the live plan (console coverage panel). */
  public getPlan(): EffectiveQuotaPlan {
    return this.plan;
  }

  /** Latest stored snapshot for a pair (console badge join). */
  public getSnapshot(providerId: string, keyHashPrefix: string) {
    return getQuotaStore().get(providerId, keyHashPrefix);
  }

  public getTtlFor(providerId: string): number | undefined {
    const target: QuotaTarget | undefined = this.plan.byProvider.get(providerId);
    if (!target) return undefined;
    return target.kind === 'dsl' ? clampTtl(target.entry.cacheTtlMs) : 15 * 60_000;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────
// Boot creates exactly one prober (server wiring); tests instantiate their
// own. The accessor exists because the console routes join badge state
// without threading the instance through the route factory.

let instance: QuotaProber | undefined;

export function getQuotaProber(): QuotaProber | undefined {
  return instance;
}

export function setQuotaProber(next?: QuotaProber): QuotaProber | undefined {
  const previous = instance;
  instance = next;
  return previous;
}
