import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStateStore } from '../src/resilience/account-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { ErrorClassifier, UpstreamError } from '../src/resilience/error-classifier.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis, RetryConfig } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 3 (rule #3 + countedness of 429):
 * the hard/counted boundary re-derives from trip.rateLimit.hardTripAboveMs;
 * OFF = downgrade to a counted statistical failure, NOT ignore; a downgraded
 * long-Retry-After 429 KEEPS its RA-derived floor via max(min, computed);
 * counting.rateLimitErrors.minCooldownMs governs only the no-Retry-After case;
 * the RA ceiling stays the global maxCooldownMs; the breaker-side copy never
 * rewrites the retry-side in-place-retry decision (invariant 1).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-429-'));
  const ocrHome = path.join(dir, 'ocr-home');
  return {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome,
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
}

function makeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const BASE: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 3,
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 1000,
  maxCooldownMs: 300_000, // ceiling only asserted explicitly; keep it far from test values
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeManager(rules?: BreakerRulesConfig, over: Partial<CircuitBreakerConfig> = {}, retry?: RetryConfig) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const accountState = new AccountStateStore({ paths, now: clock.now });
  const config: CircuitBreakerConfig = { ...BASE, ...over, ...(rules ? { rules } : {}) };
  const manager = new CircuitBreakerManager(config, clock.now, accountState, retry);
  manager.registerModel(model('p/x', 'p'));
  return { manager, clock, accountState };
}

function model(id: string, provider: string): ModelRegistration {
  return {
    id,
    provider,
    upstreamModel: id.split('/')[1] ?? id,
    tier: 'plus',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
}

// rateLimitHard/429 helper: classifier-shaped 429 with the given Retry-After.
function ra429(retryAfterSeconds?: number): ErrorDiagnosis {
  const long = retryAfterSeconds !== undefined && retryAfterSeconds * 1000 > 2000;
  return {
    category: 'RATE_LIMITED', isRetriable: true, isInPlaceRetriable: !long,
    shouldTripBreaker: true, hardTrip: long, retryAfterSeconds,
    minCooldownMs: 123_456, // junk carrier value — the gate must never use it for the hard path
    reason: `429 (Retry-After: ${retryAfterSeconds ?? 'unknown'})`,
    reasonCode: 'breaker.rate_limit', reasonParams: { model: 'p/x', retry_after: retryAfterSeconds ?? 'unknown' },
  };
}
const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, reason: '503 bad gateway', reasonCode: 'breaker.network',
};

// ─── hard/counted boundary re-derivation ────────────────────────────────────

describe('429 hard/counted boundary from trip.rateLimit.hardTripAboveMs', () => {
  it('default boundary 2000ms: RA 30s hard-trips, cooldown = max(1000 floor, RA)', () => {
    const { manager } = makeManager();
    manager.recordFailureScoped('p/x', ra429(30), 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN'); // immediate hard trip
    expect(snap?.currentCooldownMs).toBe(30_000); // RA wins; the junk minCooldownMs carrier (123456) does NOT
    expect(snap?.reasonCode).toBe('breaker.rate_limit');
  });

  it('at-or-below boundary is counted, not hard: RA exactly 2000ms', () => {
    const { manager } = makeManager();
    manager.recordFailureScoped('p/x', ra429(2), 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    expect(manager.getSnapshot('p/x')?.totalFailures).toBe(1);
  });

  it('hardTripAboveMs override raises the boundary: RA 30s becomes counted', () => {
    const { manager } = makeManager({ trip: { rateLimit: { hardTripAboveMs: 60_000 } } });
    manager.recordFailureScoped('p/x', ra429(30), 'p');
    manager.recordFailureScoped('p/x', ra429(30), 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // counted only
    manager.recordFailureScoped('p/x', ra429(30), 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.consecutive'); // downgraded to the B detector
    expect(snap?.currentCooldownMs).toBe(30_000); // RA-derived floor via max(30000, computed 1000)
  });

  it('hardTripAboveMs override lowers the boundary: RA 1s becomes hard', () => {
    const { manager } = makeManager({ trip: { rateLimit: { hardTripAboveMs: 500 } } });
    manager.recordFailureScoped('p/x', ra429(1), 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.currentCooldownMs).toBe(1000); // max(default floor 1000, RA 1000)
  });

  it('trip.rateLimit.minCooldownMs floors the Retry-After-derived cooldown', () => {
    const { manager } = makeManager({ trip: { rateLimit: { minCooldownMs: 20_000 } } });
    manager.recordFailureScoped('p/x', ra429(5), 'p'); // 5000ms RA > default boundary 2000 -> hard

    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(20_000); // floor lifts 5s to 20s
  });

  it('the global maxCooldownMs stays the RA clamp ceiling (not a per-rule knob)', () => {
    const { manager } = makeManager(undefined, { maxCooldownMs: 45_000 });
    manager.recordFailureScoped('p/x', ra429(10_000), 'p'); // RA 10_000_000ms

    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(45_000); // clamped by the global cap
  });
});

// ─── OFF = downgrade, floor preserved ───────────────────────────────────────

describe('trip.rateLimit OFF: downgrade (not ignore), RA floor kept', () => {
  it('long-RA 429 downgraded to counted KEEPS its RA-derived floor via max(min, computed)', () => {
    const { manager } = makeManager({
      trip: { rateLimit: { enabled: false } },
      counting: { serverErrors: { minCooldownMs: 120_000 } }, // must NOT touch the 429 floor
    });
    manager.recordFailureScoped('p/x', ra429(30), 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    manager.recordFailureScoped('p/x', ra429(30), 'p');
    manager.recordFailureScoped('p/x', ra429(30), 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.consecutive');
    expect(snap?.currentCooldownMs).toBe(30_000); // RA floor max(30000, computed 1000) — the 5xx floor is irrelevant
  });

  it('counting.rateLimitErrors.minCooldownMs governs ONLY the no-Retry-After case', () => {
    const rules: BreakerRulesConfig = { counting: { rateLimitErrors: { minCooldownMs: 7000 } } };

    // No RA: the counted-class floor applies (rule #3 + config comment contract).
    const m1 = makeManager(rules);
    m1.manager.recordFailureScoped('p/x', ra429(undefined), 'p');
    m1.manager.recordFailureScoped('p/x', ra429(undefined), 'p');
    m1.manager.recordFailureScoped('p/x', ra429(undefined), 'p');
    expect(m1.manager.getSnapshot('p/x')?.currentCooldownMs).toBe(7000); // max(7000, computed 1000)

    // With RA (counted at-boundary burst): the RA-derived floor wins; the 7000 knob must NOT apply.
    const m2 = makeManager(rules);
    m2.manager.recordFailureScoped('p/x', ra429(2), 'p');
    m2.manager.recordFailureScoped('p/x', ra429(2), 'p');
    m2.manager.recordFailureScoped('p/x', ra429(2), 'p');
    expect(m2.manager.getSnapshot('p/x')?.currentCooldownMs).toBe(2000); // max(max(1000,2000), 1000) = 2000 ≠ 7000
  });

  it('429 is still counted unconditionally when its trip rule is off and a B detector is on', () => {
    const { manager } = makeManager({
      trip: { rateLimit: { enabled: false } },
      counting: { serverErrors: { enabled: false }, unknownErrors: { enabled: false } },
    }, { failureThreshold: 3 });

    // Other classes are dropped at the gate; 429 has no countedness toggle.
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', ra429(30), 'p');
    manager.recordFailureScoped('p/x', ra429(30), 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalFailures).toBe(2); // exactly the two 429s — 5xx contributed nothing

    manager.recordFailureScoped('p/x', ra429(30), 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // threshold reached on 429 alone
    expect(manager.getSnapshot('p/x')?.category).toBe('RATE_LIMITED'); // invariant 3: category preserved
  });
});

// ─── retry-side non-interference (invariant 1) ──────────────────────────────

describe('breaker-side copy never rewrites the retry-side in-place decision', () => {
  it('hardTripAboveMs defaults to retry.inplace.maxRateLimitWaitMs (inherited knob)', () => {
    // retry says 5000; RA 3000ms stays COUNTED on the breaker side too (no override).
    const { manager } = makeManager(undefined, {}, { enabled: true, inplace: { maxRateLimitWaitMs: 5000 } });
    manager.recordFailureScoped('p/x', ra429(3), 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
  });

  it('overriding hardTripAboveMs hard-trips a 429 the retry side still treats as an in-place burst', () => {
    const { manager } = makeManager(
      { trip: { rateLimit: { hardTripAboveMs: 1000 } } },
      {},
      { enabled: true, inplace: { maxRateLimitWaitMs: 5000 } },
    );
    // Retry-side shape: 3000ms <= maxRateLimitWaitMs 5000 -> in-place burst.
    const diagnosis: ErrorDiagnosis = { ...ra429(3), isInPlaceRetriable: true, hardTrip: false };
    manager.recordFailureScoped('p/x', diagnosis, 'p');

    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // breaker side diverges on purpose
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(3000); // max(1000 floor, 3000)
    // The diagnosis the caller (orchestrator) keeps acting on is untouched —
    // documented divergence, never a rewrite (invariant 1/3).
    expect(diagnosis.isInPlaceRetriable).toBe(true);
  });

  it('end-to-end classifier + gate: breaker re-derivation leaves classifier output intact', () => {
    const { manager } = makeManager({ trip: { rateLimit: { enabled: false } } }, {}, {
      enabled: true,
      inplace: { enabled: true, maxRateLimitWaitMs: 2000, retryOnCauses: ['rate_limit_burst'] },
    });
    const err = new UpstreamError({
      message: '429 too many requests', status: 429, provider: 'p', modelId: 'p/x', retryAfterSeconds: 30,
    });
    const diagnosis = ErrorClassifier.classify(err, 'p/x', 'p', undefined, {
      enabled: true, inplace: { maxRateLimitWaitMs: 2000 },
    });
    expect(diagnosis.hardTrip).toBe(true); // the classifier's rule-agnostic view
    manager.recordFailureScoped('p/x', diagnosis, 'p');

    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // gate downgraded it (rule OFF)
    expect(diagnosis.hardTrip).toBe(true); // the object itself was NOT rewritten (invariant 3)
    expect(diagnosis.category).toBe('RATE_LIMITED');
    expect(diagnosis.isRetriable).toBe(true); // failover input intact
  });
});
