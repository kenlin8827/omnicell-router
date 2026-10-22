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
 * single-credential degeneracy the ratelimit subject uses). No credential-pool
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

/** Outcome of one manual refresh (the console button). */
export interface QuotaRefreshReport {
  /** Pairs whose probe ran to completion before the request answered. */
  probed: number;
  /** Pairs the budget (or a mid-cycle 429) left due for the next tick. */
  pending: number;
  /** A 429 arrived mid-cycle — the engine-level gate is now armed. */
  rateLimited: boolean;
  /** The live kill switch (`quota.enabled: false`) refused the cycle. */
  disabled: boolean;
  /** Another cycle (timer tick or a second refresh) held the slot past the
   *  request budget — nothing was probed, the answer is honest, not a hang. */
  busy: boolean;
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
/** Manual refresh: total wall-clock budget for one request (bounded on
 *  purpose — the console awaits the result, so never a second scheduler).
 *  Invariant: the per-probe timeout below stays well under this budget, so a
 *  dead endpoint can never consume the whole request. */
const REFRESH_BUDGET_MS = 12_000;
/** Manual refresh: per-probe HTTP timeout (the tick path keeps the engine's
 *  10 s default; the request budget must never be eaten by one dead endpoint). */
const REFRESH_PROBE_TIMEOUT_MS = 8_000;

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
  /** The one in-flight cycle — the timer tick and a manual refresh share it. */
  private current: Promise<unknown> | null = null;
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
    if (this.probingDisabled()) return [];
    if (now < this.rateLimitedUntilMs) return [];
    return this.duePairs(now).slice(0, QuotaProber.MAX_PER_TICK);
  }

  /**
   * Due pairs in plan order, uncapped (the manual-refresh path uses this —
   * a human asking for fresh numbers gets all of them, not the tick slice).
   * First sighting (no state) is always due: activation follows credentials
   * (the coverage principle). `scope` narrows to ONE pair.
   */
  private duePairs(
    now: number,
    scope?: { providerId?: string; keyHashPrefix?: string }
  ): QuotaPairCandidate[] {
    const out: QuotaPairCandidate[] = [];
    for (const providerId of this.plan.byProvider.keys()) {
      if (scope?.providerId && providerId !== scope.providerId) continue;
      for (const pair of this.pairsOf(providerId)) {
        if (scope?.keyHashPrefix && pair.keyHashPrefix !== scope.keyHashPrefix) continue;
        const st = this.state.get(`${providerId}#${pair.keyHashPrefix}`);
        if (st && now < st.nextDueAtMs) continue;
        out.push(pair);
      }
    }
    return out;
  }

  /** Kill switch honored live, not only at boot: saving quota.enabled:false
   *  must stop outbound probing without a restart (and true must resume it). */
  private probingDisabled(): boolean {
    return this.configFn().quota?.enabled === false;
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
    // A running cycle owns the slot: this tick SKIPS (never queues) — due
    // state survives, so the next tick re-plans it; queueing would only pile
    // up ticks behind a slow cycle.
    if (this.current) return { probed: 0 };
    const release = this.claim();
    try {
      const candidates = this.planProbes(now);
      let probed = 0;
      for (const pair of candidates) {
        await this.runOne(pair, now);
        probed++;
      }
      return { probed };
    } finally {
      release();
    }
  }

  private async runOne(
    pair: QuotaPairCandidate,
    now: number,
    timeoutMs?: number
  ): Promise<{ rateLimited: boolean }> {
    const target = this.plan.byProvider.get(pair.providerId);
    if (!target) return { rateLimited: false };
    const key = `${pair.providerId}#${pair.keyHashPrefix}`;
    const result = await probePair(target, {
      providerId: pair.providerId,
      key: pair.key,
      prefix: pair.keyHashPrefix,
      fetchImpl: this.fetchImpl,
      now: this.nowFn,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
    return { rateLimited: result.rateLimited };
  }

  /** Test seam: current engine-level 429 gate. */
  public getRateLimitedUntil(): number {
    return this.rateLimitedUntilMs;
  }

  /** Force one pair due now (console "refresh quota" button). */
  public invalidatePair(providerId: string, keyHashPrefix: string): void {
    this.state.delete(`${providerId}#${keyHashPrefix}`);
  }

  /** Full reset of scheduling state (tests + config reload storms — note it
   *  also clears the 429 gate; a manual refresh deliberately does NOT). */
  public resetScheduling(): void {
    this.state.clear();
    this.rateLimitedUntilMs = 0;
    this.rateLimitStreak = 0;
  }

  /**
   * Console "refresh now": take the cycle slot, invalidate, then run ONE
   * bounded probe cycle INSIDE the request so the caller can re-read fresh
   * numbers the moment it resolves (the page awaits this, then GETs the
   * snapshot). The interval tick and its due-based cadence are untouched —
   * this only front-loads a cycle a human explicitly asked for, and the timer
   * is never restarted (due dates, not tick phase, express the cadence).
   *
   * Concurrency: the slot is exclusive with the timer's tick and with any
   * other manual refresh. Waiting for a busy slot is BOUNDED by the request
   * budget — a refresh must always answer, so a slot that stays busy past the
   * budget returns `busy` instead of hanging the HTTP request.
   *
   * Bounded on purpose (a manual refresh is not a second scheduler): a total
   * wall-clock budget plus a per-probe timeout; pairs the budget cannot reach
   * stay due for the next tick. The 429 rule still wins — an armed global gate
   * refuses the cycle, and a mid-cycle 429 stops it instead of hammering
   * shared quota endpoints.
   */
  public async refreshNow(
    opts: { providerId?: string; keyHashPrefix?: string; budgetMs?: number } = {}
  ): Promise<QuotaRefreshReport> {
    const deadline = this.nowFn() + (opts.budgetMs ?? REFRESH_BUDGET_MS);
    const release = await this.tryClaim(deadline);
    if (!release) return { probed: 0, pending: 0, rateLimited: false, disabled: false, busy: true };
    try {
      // Refusals come FIRST, before any invalidation: a refresh that answers
      // `disabled` or `rateLimited` probed nothing, so it must not rewrite the
      // schedule either (clearing due dates there would dump the whole plan
      // onto the next tick at once).
      if (this.probingDisabled()) return { probed: 0, pending: 0, rateLimited: false, disabled: true, busy: false };
      const now = this.nowFn();
      if (now < this.rateLimitedUntilMs) {
        return { probed: 0, pending: 0, rateLimited: true, disabled: false, busy: false };
      }

      // Invalidate only once the slot is OURS: doing it under a running cycle
      // would let that cycle re-arm due dates on top of the reset. Due dates
      // only — an armed 429 gate must survive a human pressing refresh
      // (clearing it here would defeat the anti-hammer rule above).
      if (opts.providerId && opts.keyHashPrefix) {
        this.invalidatePair(opts.providerId, opts.keyHashPrefix);
      } else {
        this.state.clear();
      }

      const scope =
        opts.providerId && opts.keyHashPrefix
          ? { providerId: opts.providerId, keyHashPrefix: opts.keyHashPrefix }
          : undefined;
      const candidates = this.duePairs(now, scope);
      return await this.runManualCycle(candidates, deadline);
    } finally {
      release();
    }
  }

  private async runManualCycle(
    candidates: QuotaPairCandidate[],
    deadline: number
  ): Promise<QuotaRefreshReport> {
    // `probed` counts ATTEMPTS (a failed probe keeps its previous snapshot and
    // is still an attempt — the console toast says "probed", never "refreshed").
    let probed = 0;
    let pending = candidates.length;
    for (const pair of candidates) {
      const now = this.nowFn();
      const remaining = deadline - now;
      if (remaining <= 0) break;
      const res = await this.runOne(pair, now, Math.min(REFRESH_PROBE_TIMEOUT_MS, remaining));
      probed++;
      pending--;
      // A 429 mid-cycle armed the global gate — stop, never keep hammering.
      if (res.rateLimited) return { probed, pending, rateLimited: true, disabled: false, busy: false };
    }
    return { probed, pending: Math.max(0, pending), rateLimited: false, disabled: false, busy: false };
  }

  /**
   * Claim the one cycle slot, waiting for a busy one NO LONGER than `deadline`.
   * Returns the release function, or null when the slot stayed busy past the
   * deadline (the caller answers `busy` instead of hanging).
   *
   * The wait-then-claim is atomic: the claim happens synchronously after the
   * last `while` check, so two waiters can never both claim (the loser loops
   * and sees the winner's gate).
   */
  private async tryClaim(deadline: number): Promise<(() => void) | null> {
    while (this.current) {
      const remaining = deadline - this.nowFn();
      if (remaining <= 0) return null;
      const idle = await new Promise<boolean>((resolve) => {
        // `done` clears the bound timer on the early (cycle-finished) path;
        // `unref` keeps the handle from holding the process open either way.
        let timer: NodeJS.Timeout | undefined;
        const done = (v: boolean) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        };
        timer = setTimeout(() => done(false), remaining);
        timer.unref?.();
        // A failed previous cycle still frees the slot.
        this.current!.then(() => done(true), () => done(true));
      });
      if (!idle) return null;
    }
    return this.claim();
  }

  /** Synchronous claim (the caller has already checked the slot is free). */
  private claim(): () => void {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.current = gate;
    return () => {
      if (this.current === gate) this.current = null;
      open();
    };
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
