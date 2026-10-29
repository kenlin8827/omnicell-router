import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { CircuitBreaker } from '../src/resilience/circuit-breaker.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRecord, BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 5 (rule #10): the HALF_OPEN trial
 * is a configurable batch, not a hardcoded single canary. Multi-probe
 * concurrent budget = maxProbes; CLOSE only at successThreshold; probe
 * failure AND short-batch exhaustion resolve via onCanaryFailure; non-penalty
 * outcomes release the slot; restore refreshes halfOpenSuccesses +
 * halfOpenEnteredAt; a tuple success counts toward ITS OWN trial batch (never
 * force-closes) when successThreshold > 1; maxWaitMs expiry resolves via
 * onCanaryFailure (default 0 = wait forever).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-halfopen-'));
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

const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, reason: '503 bad gateway', reasonCode: 'breaker.network',
};
const CLIENT_400: ErrorDiagnosis = {
  category: 'CLIENT_ERROR', isRetriable: false, isInPlaceRetriable: false,
  shouldTripBreaker: false, hardTrip: false, reason: '400 context_length_exceeded',
};

const BASE: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 2,
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 1000,
  maxCooldownMs: 300_000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeBreaker(rules: BreakerRulesConfig, clock: () => number, over: Partial<CircuitBreakerConfig> = {}) {
  return new CircuitBreaker('p/x', 'p', 'plus', { ...BASE, ...over, rules }, clock);
}

/** trip() into OPEN (category SERVICE_UNAVAILABLE) and poll into HALF_OPEN. */
function toHalfOpen(b: CircuitBreaker, clock: ReturnType<typeof makeClock>, waitMs = 1001) {
  b.trip('outage', 'SERVICE_UNAVAILABLE', 1000, 'breaker.network');
  clock.advance(waitMs);
  expect(b.getState()).toBe('HALF_OPEN'); // poll arms halfOpenEnteredAt
}

describe('multi-probe trial budget', () => {
  it('maxProbes concurrent probes are admitted, slots counted one by one', () => {
    // successThreshold 1 keeps the batch_short resolution out of this test's
    // way (it needs threshold > 1 — that edge is pinned by its own test below).
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 3, successThreshold: 1 } } }, clock.now);
    toHalfOpen(b, clock);

    expect(b.canExecute().allowed).toBe(true);
    expect(b.getSnapshot().halfOpenProbes).toBe(1);
    expect(b.canExecute().allowed).toBe(true);
    expect(b.getSnapshot().halfOpenProbes).toBe(2);
    const third = b.canExecute();
    expect(third.allowed).toBe(true);
    expect(b.getState()).toBe('HALF_OPEN');

    const fourth = b.canExecute(); // budget exhausted -> plain denial (no re-trip at threshold 1)
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toContain('probe quota');
    expect(b.getState()).toBe('HALF_OPEN');
  });

  it('CLOSE only at successThreshold — one success below the bar stays HALF_OPEN', () => {
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 3, successThreshold: 2 } } }, clock.now);
    toHalfOpen(b, clock);

    expect(b.canExecute().allowed).toBe(true); // probe 1 in flight
    b.recordSuccess();
    const mid = b.getSnapshot();
    expect(mid.state).toBe('HALF_OPEN'); // NOT force-closed
    expect(mid.halfOpenSuccesses).toBe(1);
    expect(mid.halfOpenProbes).toBe(0); // completed probe released its slot so the batch continues

    expect(b.canExecute().allowed).toBe(true); // probe 2
    b.recordSuccess();
    const done = b.getSnapshot();
    expect(done.state).toBe('CLOSED'); // threshold reached — full recovery
    expect(done.consecutiveFailures).toBe(0); // ladder + window re-armed as today
    expect(done.currentCooldownMs).toBe(1000); // back to the initial rung
    expect(done.halfOpenSuccesses).toBe(0);
    expect(done.halfOpenEnteredAt).toBeUndefined();
  });

  it('a probe failure resolves immediately via onCanaryFailure (backoff)', () => {
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 3, successThreshold: 2 } } }, clock.now);
    toHalfOpen(b, clock);

    expect(b.canExecute().allowed).toBe(true);
    b.recordFailure(NET_503); // first probe fails -> immediate re-OPEN, batch not waited out

    const snap = b.getSnapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.reasonCode).toBe('breaker.canary');
    expect(snap.currentCooldownMs).toBe(2000); // 1000 x 2 backoff
  });

  it('short batch: slots all consumed with successes below the threshold resolves via onCanaryFailure', () => {
    // Spec rule #10 "batch exhausted below successThreshold". The implementation
    // treats ALL concurrent slots consumed (probes still in flight) as the
    // exhaustion point — see QA report finding F2 for the alternative reading.
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 3, successThreshold: 2 } } }, clock.now);
    toHalfOpen(b, clock);
    const requestsBefore = b.getSnapshot().totalRequests;

    b.canExecute();
    b.canExecute();
    b.canExecute(); // 3 slots consumed, none answered yet
    const fourth = b.canExecute(); // this poll sees the trial unable to reach the bar

    expect(fourth.allowed).toBe(false);
    const snap = b.getSnapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.reasonCode).toBe('breaker.canary');
    expect(snap.reason).toContain('batch exhausted');
    expect(snap.totalFailures).toBe(0); // short-batch re-OPEN counts no NEW failure
    expect(snap.totalRequests).toBe(requestsBefore);
    expect(snap.currentCooldownMs).toBe(2000); // resolved through backoff
  });

  it('default maxProbes=1/successThreshold=1: a stuck single canary LINGERS, never batch_shorts', () => {
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: {} } }, clock.now); // legacy batch shape
    toHalfOpen(b, clock);

    expect(b.canExecute().allowed).toBe(true); // the one canary
    expect(b.canExecute().allowed).toBe(false); // quota exhausted -> plain denial
    expect(b.getState()).toBe('HALF_OPEN'); // NOT re-tripped: today's behavior pinned
  });

  it('a non-penalty outcome releases its slot so the trial is never stranded', () => {
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 1, successThreshold: 1 } } }, clock.now);
    toHalfOpen(b, clock);

    expect(b.canExecute().allowed).toBe(true); // slot consumed
    expect(b.canExecute().allowed).toBe(false); // quota exhausted
    b.recordFailure(CLIENT_400); // shouldTripBreaker false -> non-penalty

    const snap = b.getSnapshot();
    expect(snap.state).toBe('HALF_OPEN');
    expect(snap.halfOpenProbes).toBe(0); // slot released (circuit-breaker.ts today's invariant)
    expect(snap.totalFailures).toBe(0); // and nothing counted
    expect(b.canExecute().allowed).toBe(true); // next canary can go
  });
});

describe('maxWaitMs (R4J maxWaitDurationInHalfOpenState)', () => {
  it('expiry resolves via onCanaryFailure — backoff re-OPEN without any traffic', () => {
    const clock = makeClock();
    const b = makeBreaker(
      { recovery: { halfOpen: { maxProbes: 2, successThreshold: 2, maxWaitMs: 5000 } } },
      clock.now,
    );
    b.trip('outage', 'SERVICE_UNAVAILABLE', 1000, 'breaker.network');
    clock.advance(1000);
    expect(b.getState()).toBe('HALF_OPEN'); // enteredAt = now

    clock.advance(4999);
    expect(b.peekExecute().allowed).toBe(true); // wait budget not yet spent — and peek takes no slot
    expect(b.getState()).toBe('HALF_OPEN');

    clock.advance(1);
    const verdict = b.peekExecute(); // 5000ms in HALF_OPEN, 0/2 successes
    expect(verdict.allowed).toBe(false);
    const snap = b.getSnapshot();
    expect(snap.state).toBe('OPEN');
    expect(snap.reasonCode).toBe('breaker.canary');
    expect(snap.reason).toContain('Half-open wait limit exceeded');
    expect(snap.currentCooldownMs).toBe(2000); // backoff rung
  });

  it('expiry under close goes CLOSED; under MANUAL close coerces to re-OPEN', () => {
    const clock = makeClock();
    const cfg = { recovery: { halfOpen: { maxProbes: 2, successThreshold: 2, maxWaitMs: 5000 } } } as BreakerRulesConfig;
    const optimistic = makeBreaker({ recovery: { ...cfg.recovery, onCanaryFailure: 'close' } }, clock.now);
    optimistic.trip('outage', 'SERVICE_UNAVAILABLE', 1000, 'breaker.network');
    clock.advance(1000);
    optimistic.getState(); // OPEN -> HALF_OPEN arms the wait clock HERE (enteredAt = now)
    clock.advance(5000);
    optimistic.peekExecute(); // wait budget spent without any probe dispatched
    expect(optimistic.getState()).toBe('CLOSED');

    const manualClock = makeClock();
    const manual = makeBreaker({ recovery: { ...cfg.recovery, onCanaryFailure: 'close' } }, manualClock.now);
    manual.trip('operator takedown', 'MANUAL', 1000, 'breaker.manual');
    manualClock.advance(1000);
    manual.getState(); // arm HALF_OPEN
    manualClock.advance(5000);
    manual.peekExecute();
    expect(manual.getState()).toBe('OPEN'); // never defeat an operator takedown
    expect(manual.getSnapshot().currentCooldownMs).toBe(2000);
  });

  it('default 0 waits forever — a no-traffic HALF_OPEN lingers indefinitely', () => {
    const clock = makeClock();
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 2, successThreshold: 2 } } }, clock.now);
    b.trip('outage', 'SERVICE_UNAVAILABLE', 1000, 'breaker.network');
    clock.advance(1000);
    expect(b.getState()).toBe('HALF_OPEN');

    clock.advance(30 * 24 * 3600 * 1000); // 30 days of silence
    expect(b.getState()).toBe('HALF_OPEN');
    expect(b.peekExecute().allowed).toBe(true);
  });
});

describe('restore refresh of the trial batch (rule #10 persistence)', () => {
  it('applyRecord re-arms probes, successes, and halfOpenEnteredAt for a HALF_OPEN record', () => {
    const clock = makeClock(1_000_000);
    const b = makeBreaker({ recovery: { halfOpen: { maxProbes: 2, successThreshold: 2 } } }, clock.now);
    // A snapshot flushed mid-canary: one slot spent, one success booked, the
    // episode entered long ago (possibly past a maxWait budget).
    const stranded: BreakerRecord = {
      modelId: 'p/x', provider: 'p', state: 'HALF_OPEN',
      consecutiveFailures: 2, totalRequests: 3, totalSuccesses: 1, totalFailures: 2,
      lastFailureTime: 0, lastSuccessTime: 0, trippedAt: 0,
      cooldownUntil: 900, currentCooldownMs: 1000,
      halfOpenProbes: 2, halfOpenSuccesses: 1, halfOpenEnteredAt: 500,
      outcomeWindow: [false, false, true],
    };
    b.applyRecord(stranded);

    const snap = b.getSnapshot();
    expect(snap.state).toBe('HALF_OPEN');
    expect(snap.halfOpenProbes).toBe(0); // probes re-armed (exactly like today's quota refresh)
    expect(snap.halfOpenSuccesses).toBe(0); // successes re-armed
    expect(snap.halfOpenEnteredAt).toBe(1_000_000); // maxWait clock re-arms from now

    // Worst case one extra canary round — the gate is never stranded.
    expect(b.canExecute().allowed).toBe(true);
    expect(b.canExecute().allowed).toBe(true); // budget 2 fully fresh
  });
});

describe('tuple trial batch (successThreshold on the tuple itself)', () => {
  function makeScopingManager(rules?: BreakerRulesConfig) {
    const clock = makeClock();
    const paths = sandboxPaths();
    const credentialState = new CredentialStateStore({ paths, now: clock.now });
    const manager = new CircuitBreakerManager({ ...BASE, ...(rules ? { rules } : {}) }, clock.now, credentialState);
    const m: ModelRegistration = {
      id: 'p/x', provider: 'p', upstreamModel: 'x', tier: 'plus',
      pricing: { input: 1, output: 2, cacheRead: 0.1 },
    };
    manager.registerModel(m);
    return { manager, clock };
  }

  it('with successThreshold 2 the first tuple success COUNTS, the second CLOSES', () => {
    const { manager, clock } = makeScopingManager({ recovery: { halfOpen: { maxProbes: 2, successThreshold: 2 } } });
    const outage: ErrorDiagnosis = { ...NET_503, tripScope: 'pair' };
    manager.recordFailureScoped('p/x', outage, 'p', 'K1'); // 2 counted -> the K1 tuple OPEN
    manager.recordFailureScoped('p/x', outage, 'p', 'K1');
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');

    clock.advance(1000);
    expect(manager.getSnapshot('p/x')?.state).toBe('HALF_OPEN'); // the snapshot poll arms the trial

    manager.recordSuccessScoped('p/x', 'K1', 'p');
    const mid = manager.getSnapshot('p/x');
    expect(mid?.state).toBe('HALF_OPEN'); // counted, NOT force-closed (spec rule #10)
    expect(mid?.halfOpenSuccesses).toBe(1);

    manager.recordSuccessScoped('p/x', 'K1', 'p');
    const done = manager.getSnapshot('p/x');
    expect(done?.state).toBe('CLOSED');
    expect(done?.consecutiveFailures).toBe(0);
  });

  it('default successThreshold 1 keeps today\u2019s canary-closes-on-first-success', () => {
    const { manager, clock } = makeScopingManager(); // no rules: legacy 1/1
    const outage: ErrorDiagnosis = { ...NET_503, tripScope: 'pair' };
    manager.recordFailureScoped('p/x', outage, 'p', 'K1');
    manager.recordFailureScoped('p/x', outage, 'p', 'K1');
    clock.advance(1000);
    expect(manager.getSnapshot('p/x')?.state).toBe('HALF_OPEN');

    manager.recordSuccessScoped('p/x', 'K1', 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // first tuple success closes (pre-spec behavior)
  });
});
