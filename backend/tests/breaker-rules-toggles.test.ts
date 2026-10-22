import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { ErrorClassifier, UpstreamError } from '../src/resilience/error-classifier.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec docs/design/circuit-breaker-rules-config.md.
 * Area 1: the rule-toggle matrix on the MANAGER GATE (invariant 1: the gate is
 * the single join point for the orchestrator AND the prober, so toggles are
 * tested there, never on a directly-constructed breaker), plus the five-switch
 * zero-rule predicate and the invariant-3 guard (rule toggles never rewrite
 * `category`/`isRetriable` on the diagnosis handed onward — failover reads it).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-toggles-'));
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
  maxCooldownMs: 50_000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeManager(rules?: BreakerRulesConfig, over: Partial<CircuitBreakerConfig> = {}, shadow = false) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const credentialState = new CredentialStateStore({ paths, now: clock.now });
  const config: CircuitBreakerConfig = { ...BASE, ...over, shadow, ...(rules ? { rules } : {}) };
  const manager = new CircuitBreakerManager(config, clock.now, credentialState);
  manager.registerModel(model('p/x', 'p'));
  return { manager, clock, credentialState, paths };
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

// Realistic classifier-shaped diagnoses (fields the gate actually reads).
const QUOTA_402: ErrorDiagnosis = {
  category: 'QUOTA_EXHAUSTED', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, minCooldownMs: 60_000,
  reason: '402 insufficient_quota', reasonCode: 'breaker.quota', reasonParams: { model: 'p/x', provider: 'p' },
};
const AUTH_401: ErrorDiagnosis = {
  category: 'AUTHENTICATION_ERROR', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, minCooldownMs: 60_000,
  reason: '401 invalid_api_key', reasonCode: 'breaker.auth', reasonParams: { model: 'p/x', provider: 'p' },
  tripScope: 'credential', credentialSuspect: true,
};
// Retry-After 30s > the default 2000ms boundary -> hard trip by today's shape.
const RA_LONG_429: ErrorDiagnosis = {
  category: 'RATE_LIMITED', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, minCooldownMs: 30_000, retryAfterSeconds: 30,
  reason: '429 Retry-After: 30s', reasonCode: 'breaker.rate_limit', reasonParams: { model: 'p/x', retry_after: 30 },
};
// No Retry-After at all: counted statistical failure (countedness has no toggle).
const NO_RA_429: ErrorDiagnosis = {
  category: 'RATE_LIMITED', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, minCooldownMs: 1000,
  reason: '429 too many requests', reasonCode: 'breaker.rate_limit', reasonParams: { model: 'p/x', retry_after: 'unknown' },
};
const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, minCooldownMs: 1000,
  reason: '503 bad gateway', reasonCode: 'breaker.network', reasonParams: { cause: 'GATEWAY_ERROR', status: 503 },
};
const UNKNOWN_ERR: ErrorDiagnosis = {
  category: 'UNKNOWN', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, minCooldownMs: 1000,
  reason: 'unclassified upstream error', reasonCode: 'breaker.unknown', reasonParams: { message: 'HTTP 418' },
};
// Today's non-penalizing CLIENT_ERROR shape (the gate flips shouldTripBreaker when counted).
const CLIENT_400: ErrorDiagnosis = {
  category: 'CLIENT_ERROR', isRetriable: false, isInPlaceRetriable: false,
  shouldTripBreaker: false, hardTrip: false,
  reason: '400 context_length_exceeded', reasonCode: undefined,
};

// ─── (a) per-switch OFF semantics on the manager gate ───────────────────────

describe('(a) rule-toggle matrix: OFF semantics per switch (manager gate)', () => {
  it('trip.quota off: 402 neither trips nor counts', () => {
    const { manager } = makeManager({ trip: { quota: { enabled: false } } });
    manager.recordFailureScoped('p/x', QUOTA_402, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalRequests).toBe(0); // never recorded at all
    expect(snap?.consecutiveFailures).toBe(0);
    expect(manager.canExecute('p/x').allowed).toBe(true);
  });

  it('trip.auth off: 401 neither trips nor counts (breaker-wise)', () => {
    const { manager } = makeManager({ trip: { auth: { enabled: false } } });
    manager.recordFailureScoped('p/x', AUTH_401, 'p', 'K1'); // credential scope, real 401 shape

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('CLOSED');
    expect(manager.getPairBreaker('p/x', 'K1')?.getSnapshot().totalRequests).toBe(0);
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    expect(manager.canExecute('p/x').allowed).toBe(true);
  });

  // F1 adjudication: spec line 52 defines markSuspect as "flag the credential
  // SUSPECT on trip" — an auth rule OFF ("ignore", rule semantics #2) trips
  // nothing, so it must mark nothing. A SUSPECT credential never auto-returns
  // (manual clear only), so an ignored 401 administratively ejecting the
  // credential was the bug; this is the formal pin.
  it('trip.auth off ("ignore"): 401 neither trips, counts, nor marks SUSPECT', () => {
    const { manager, credentialState } = makeManager({ trip: { auth: { enabled: false } } });
    manager.recordFailureScoped('p/x', AUTH_401, 'p', 'K1');

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('CLOSED'); // no trip
    expect(manager.getPairBreaker('p/x', 'K1')?.getSnapshot().totalRequests).toBe(0); // no count
    expect(credentialState.isSuspect('p', 'K1')).toBe(false); // no flag: markSuspect fires on trip only

    // Invariant 2 boundary: disabling the rule neither sets nor clears
    // EXISTING flags — an operator-cleared entry keeps gating until clear.
    credentialState.mark('p', 'K1', 'pre-existing flag');
    manager.recordFailureScoped('p/x', AUTH_401, 'p', 'K1');
    expect(credentialState.isSuspect('p', 'K1')).toBe(true); // untouched by the OFF rule
  });

  it('trip.auth on + markSuspect on (default): 401 hard-trips AND flags the credential SUSPECT', () => {
    const { manager, credentialState } = makeManager({ trip: { auth: { enabled: true } } });
    manager.recordFailureScoped('p/x', AUTH_401, 'p', 'K1');

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(credentialState.isSuspect('p', 'K1')).toBe(true);
  });

  it('trip.auth on + markSuspect off: trips without flagging (stops NEW flags only)', () => {
    const { manager, credentialState } = makeManager({ trip: { auth: { enabled: true, markSuspect: false } } });
    manager.recordFailureScoped('p/x', AUTH_401, 'p', 'K1');

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN'); // trip unchanged
    expect(credentialState.isSuspect('p', 'K1')).toBe(false); // new flag suppressed
  });

  it('trip.consecutiveFailures off: failures still count, threshold never checked', () => {
    const { manager, clock } = makeManager({ trip: { consecutiveFailures: { enabled: false } } });
    for (let i = 0; i < 10; i++) manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.consecutiveFailures).toBe(10); // counting still happens
    expect(snap?.totalFailures).toBe(10);
    clock.advance(0);
    expect(manager.canExecute('p/x').allowed).toBe(true);
  });

  it('trip.failureRate off: window keeps filling, rate never decided', () => {
    const { manager } = makeManager({
      trip: { consecutiveFailures: { enabled: false }, failureRate: { enabled: false } },
    });
    for (let i = 0; i < 20; i++) manager.recordFailureScoped('p/x', NET_503, 'p'); // full window, 100% rate

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalFailures).toBe(20); // the window filled — accounting is real
  });

  it('trip.rateLimit off: long-Retry-After 429 downgrades to a counted statistical failure', () => {
    const { manager } = makeManager({ trip: { rateLimit: { enabled: false } } });
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // NOT a hard trip anymore
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');
    expect(manager.getSnapshot('p/x')?.totalFailures).toBe(2); // NOT ignored either — counted
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.consecutive'); // the B detector tripped it
    // Deeper RA-floor derivation lives in breaker-rules-ratelimit.test.ts.
  });

  it('counting.serverErrors off: 5xx is never recorded anywhere', () => {
    const { manager } = makeManager({ counting: { serverErrors: { enabled: false } } });
    for (let i = 0; i < 5; i++) manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalRequests).toBe(0);
    expect(snap?.totalFailures).toBe(0);
  });

  it('counting.unknownErrors off: UNKNOWN is never recorded anywhere', () => {
    const { manager } = makeManager({ counting: { unknownErrors: { enabled: false } } });
    for (let i = 0; i < 5; i++) manager.recordFailureScoped('p/x', UNKNOWN_ERR, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalRequests).toBe(0);
  });

  it('counting.clientErrors on: 400/422 count and trip the statistical detectors', () => {
    const { manager } = makeManager({ counting: { clientErrors: { enabled: true } } }, { failureThreshold: 2 });
    manager.recordFailureScoped('p/x', CLIENT_400, 'p');
    expect(manager.getSnapshot('p/x')?.totalFailures).toBe(1);
    const err422: ErrorDiagnosis = { ...CLIENT_400, reason: '422 invalid request body' };
    manager.recordFailureScoped('p/x', err422, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.consecutive'); // the rule's own ladder applies (rule #8)
  });

  it('counting.clientErrors on end-to-end through the real classifier (400 body)', () => {
    const { manager } = makeManager({ counting: { clientErrors: { enabled: true } } }, { failureThreshold: 1 });
    const err = new UpstreamError({
      message: 'Upstream openai returned status 400: context_length_exceeded',
      status: 400, provider: 'p', modelId: 'p/x',
    });
    const diagnosis = ErrorClassifier.classify(err, 'p/x', 'p');
    expect(diagnosis.shouldTripBreaker).toBe(false); // classifier stays rule-agnostic
    manager.recordFailureScoped('p/x', diagnosis, 'p');

    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
    expect(manager.getSnapshot('p/x')?.category).toBe('CLIENT_ERROR');
  });

  it('counting.clientErrors off: CLIENT_ERROR is non-penalty AND releases a probe slot', () => {
    const { manager, clock } = makeManager({ counting: { unknownErrors: { enabled: false } } });
    // Trip with 429s, reach HALF_OPEN, consume the only probe slot.
    manager.recordFailureScoped('p/x', NO_RA_429, 'p');
    manager.recordFailureScoped('p/x', NO_RA_429, 'p');
    manager.recordFailureScoped('p/x', NO_RA_429, 'p'); // threshold 3 -> OPEN
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // slot consumed
    expect(manager.canExecuteScoped('p/x').allowed).toBe(false); // quota exhausted

    manager.recordFailureScoped('p/x', CLIENT_400, 'p'); // non-penalty outcome
    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('HALF_OPEN');
    expect(snap?.halfOpenProbes).toBe(0); // slot released (circuit-breaker.ts invariant)
    expect(snap?.totalFailures).toBe(3); // the client error counted nothing
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // trial not stranded
  });

  it('counting-off class releases a consumed HALF_OPEN probe slot at the GATE (drop dispatch)', () => {
    const { manager, clock } = makeManager({ counting: { serverErrors: { enabled: false } } });
    // Trip via the counted UNKNOWN class, then poll into HALF_OPEN.
    manager.recordFailureScoped('p/x', UNKNOWN_ERR, 'p');
    manager.recordFailureScoped('p/x', UNKNOWN_ERR, 'p');
    manager.recordFailureScoped('p/x', UNKNOWN_ERR, 'p');
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // slot consumed

    manager.recordFailureScoped('p/x', NET_503, 'p'); // gate dispatches 'drop'
    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('HALF_OPEN');
    expect(snap?.halfOpenProbes).toBe(0); // gate-side release (invariant 1 join point)
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true);
  });
});

// ─── (b) five-switch zero-rule predicate ────────────────────────────────────

const ALL_TRIP_OFF: BreakerRulesConfig = {
  trip: {
    quota: { enabled: false },
    auth: { enabled: false },
    rateLimit: { enabled: false },
    consecutiveFailures: { enabled: false },
    failureRate: { enabled: false },
  },
};

describe('(b) zero-rule state: automatic tripping off iff all five trip switches are off', () => {
  it('all five off: nothing anywhere trips automatically, for any class, with counting fully on', () => {
    const { manager } = makeManager({
      ...ALL_TRIP_OFF,
      counting: { serverErrors: { enabled: true }, unknownErrors: { enabled: true }, clientErrors: { enabled: true } },
    });
    manager.recordFailureScoped('p/x', QUOTA_402, 'p');
    manager.recordFailureScoped('p/x', AUTH_401, 'p');
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');
    manager.recordFailureScoped('p/x', NO_RA_429, 'p');
    for (let i = 0; i < 8; i++) manager.recordFailureScoped('p/x', NET_503, 'p');
    for (let i = 0; i < 8; i++) manager.recordFailureScoped('p/x', UNKNOWN_ERR, 'p');
    for (let i = 0; i < 8; i++) manager.recordFailureScoped('p/x', CLIENT_400, 'p');

    expect(manager.getSummary().tripped).toBe(0);
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    expect(manager.getRulesStatus().automatic).toBe('all_off');
  });

  it('all five off: manual trip remains available and enforces (operator intent, not rules)', () => {
    const { manager } = makeManager(ALL_TRIP_OFF);
    const res = manager.trip('p/x', { cooldownMs: 5000 }, 'p');
    expect(res.tripped).toBe(true);
    expect(manager.canExecute('p/x').allowed).toBe(false);
    expect(manager.getRulesStatus().automatic).toBe('all_off'); // manual is not a rule
  });

  it('four-off-plus-429 is the NON-zero case: counted 429 with rateLimit on can still trip', () => {
    const { manager } = makeManager({
      trip: {
        quota: { enabled: false },
        auth: { enabled: false },
        rateLimit: { enabled: true },
        consecutiveFailures: { enabled: false },
        failureRate: { enabled: false },
      },
    });
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');

    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // hard trip survives
    expect(manager.getRulesStatus().automatic).toBe('partly_off');
  });

  it('both-B-off with rateLimit off silences the 429 statistical path (the full-silencing route for 429)', () => {
    const { manager } = makeManager({
      trip: {
        quota: { enabled: false },
        auth: { enabled: false },
        rateLimit: { enabled: false },
        consecutiveFailures: { enabled: false },
        failureRate: { enabled: false },
      },
      counting: { clientErrors: { enabled: true } },
    });
    // 429 countedness has no toggle, but with both B detectors off the
    // counted 429s have no trip path left — this is the "empty input set"
    // sub-case the banner must not confuse with the five-switch predicate.
    for (let i = 0; i < 10; i++) manager.recordFailureScoped('p/x', NO_RA_429, 'p');
    for (let i = 0; i < 10; i++) manager.recordFailureScoped('p/x', RA_LONG_429, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    expect(manager.getSnapshot('p/x')?.totalFailures).toBeGreaterThan(0); // still recorded
    expect(manager.getRulesStatus().automatic).toBe('all_off');
  });

  it('counting-off is NOT a route to zero: with all trip switches on the predicate stays "on"', () => {
    const { manager } = makeManager({
      counting: { serverErrors: { enabled: false }, unknownErrors: { enabled: false }, clientErrors: { enabled: false } },
    });
    expect(manager.getRulesStatus().automatic).toBe('on');
    // And it demonstrably still trips: counted 429 feeds the B detectors.
    for (let i = 0; i < 3; i++) manager.recordFailureScoped('p/x', NO_RA_429, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
  });

  const singleOnMatrix: Array<[string, BreakerRulesConfig, ErrorDiagnosis, string]> = [
    ['trip.quota only', { trip: { ...ALL_TRIP_OFF.trip, quota: { enabled: true } } }, QUOTA_402, 'breaker.quota'],
    ['trip.auth only', { trip: { ...ALL_TRIP_OFF.trip, auth: { enabled: true } } }, AUTH_401, 'breaker.auth'],
    ['trip.rateLimit only', { trip: { ...ALL_TRIP_OFF.trip, rateLimit: { enabled: true } } }, RA_LONG_429, 'breaker.rate_limit'],
    [
      'trip.consecutiveFailures only',
      { trip: { ...ALL_TRIP_OFF.trip, consecutiveFailures: { enabled: true } } },
      NET_503,
      'breaker.consecutive',
    ],
    [
      'trip.failureRate only',
      { trip: { ...ALL_TRIP_OFF.trip, failureRate: { enabled: true, windowSize: 3 } } },
      NET_503,
      'breaker.rate_window',
    ],
  ];

  it.each(singleOnMatrix)('%s: partly_off and its class still trips it', (_label, rules, diag, expectedCode) => {
    const { manager } = makeManager(rules);
    const feed = () => manager.recordFailureScoped('p/x', diag, 'p');
    feed();
    if (expectedCode !== 'breaker.quota' && expectedCode !== 'breaker.auth' && expectedCode !== 'breaker.rate_limit') {
      feed();
      if (expectedCode === 'breaker.consecutive' || expectedCode === 'breaker.rate_window') feed();
    }
    expect(manager.getRulesStatus().automatic).toBe('partly_off');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
    expect(manager.getSnapshot('p/x')?.reasonCode).toBe(expectedCode);
  });

  it('default config (no rules key at all) reports "on"', () => {
    const { manager } = makeManager();
    expect(manager.getRulesStatus().automatic).toBe('on');
    expect(manager.getRulesStatus().shadow).toBe(false);
  });
});

// ─── (c) invariant 3 — rule toggles never rewrite category/isRetriable ──────

describe('(c) invariant 3: the gate never mutates the diagnosis handed onward', () => {
  const originals: Array<[string, ErrorDiagnosis]> = [
    ['quota', QUOTA_402],
    ['auth', AUTH_401],
    ['429-long-RA', RA_LONG_429],
    ['429-no-RA', NO_RA_429],
    ['5xx', NET_503],
    ['unknown', UNKNOWN_ERR],
    ['client', CLIENT_400],
  ];

  it.each(originals)('%s diagnosis is field-for-field untouched after the gate saw it', (_label, diag) => {
    const before = structuredClone(diag);
    const { manager } = makeManager({ counting: { clientErrors: { enabled: true } }, trip: { rateLimit: { enabled: false } } });
    manager.recordFailureScoped('p/x', diag, 'p', 'K1');
    expect(diag).toEqual(before); // failover (orchestrator.ts) keeps reading this exact object
  });

  it('counted classes trip with their own category preserved (snapshots key off category)', () => {
    const { manager } = makeManager(
      { counting: { clientErrors: { enabled: true } }, trip: { rateLimit: { enabled: false } } },
      { failureThreshold: 1 },
    );
    manager.recordFailureScoped('p/x', CLIENT_400, 'p');
    expect(manager.getSnapshot('p/x')?.category).toBe('CLIENT_ERROR');

    manager.reset('p/x');
    manager.recordFailureScoped('p/x', RA_LONG_429, 'p');
    expect(manager.getSnapshot('p/x')?.category).toBe('RATE_LIMITED'); // the adjusted copy kept the category
  });

  it('a counted CLIENT_ERROR still leaves isRetriable false on the caller object (no failover change)', () => {
    const { manager } = makeManager({ counting: { clientErrors: { enabled: true } } }, { failureThreshold: 1 });
    const diag: ErrorDiagnosis = { ...CLIENT_400 };
    manager.recordFailureScoped('p/x', diag, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // breaker side: counted and tripped
    expect(diag.isRetriable).toBe(false); // caller side: failover input untouched
    expect(diag.shouldTripBreaker).toBe(false); // the gate adjusted a COPY, never the original
  });
});
