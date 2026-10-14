import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStateStore } from '../src/resilience/account-state.js';
import { CircuitBreakerManager, resolveBreakerRules } from '../src/resilience/index.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 4 (rule #9): the
 * recovery.onCanaryFailure tri-state on the HALF_OPEN -> OPEN edge:
 *   backoff  = ladder x recovery.cooldownMultiplier (today's behavior)
 *   initial  = re-OPEN at the initial ladder rung
 *   close    = go CLOSED but RETAIN consecutiveFailures + currentCooldownMs
 *              so the next counted failure re-trips escalated
 * MANUAL breakers ignore `close` and always re-OPEN (never defeat an operator
 * takedown).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-canary-'));
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
  failureThreshold: 2,
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 1000,
  maxCooldownMs: 300_000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeManager(rules?: BreakerRulesConfig) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const accountState = new AccountStateStore({ paths, now: clock.now });
  const config: CircuitBreakerConfig = { ...BASE, ...(rules ? { rules } : {}) };
  const manager = new CircuitBreakerManager(config, clock.now, accountState);
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

const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, reason: '503 bad gateway', reasonCode: 'breaker.network',
  reasonParams: { cause: 'GATEWAY_ERROR', status: 503, message: 'bad gateway' },
};

/** Trip the model breaker (2 counted failures @1000ms), then poll into HALF_OPEN. */
function tripAndHalfOpen(manager: CircuitBreakerManager, clock: ReturnType<typeof makeClock>) {
  manager.recordFailureScoped('p/x', NET_503, 'p');
  manager.recordFailureScoped('p/x', NET_503, 'p');
  expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
  clock.advance(1000);
  expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // -> HALF_OPEN, slot consumed
}

describe('onCanaryFailure = backoff (today)', () => {
  it('probe failure doubles the ladder rung and wraps the cause as breaker.canary', () => {
    const { manager, clock } = makeManager({ recovery: { onCanaryFailure: 'backoff' } });
    tripAndHalfOpen(manager, clock);
    manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.currentCooldownMs).toBe(2000); // 1000 x 2 (global multiplier default)
    expect(snap?.reasonCode).toBe('breaker.canary');
    expect(snap?.reasonParams?.cause_code).toBe('breaker.network');
  });

  it('an unrecognized mode value resolves to backoff (fallback = today)', () => {
    // Programmatic config that never passed the sanitizer — the resolver's own default.
    const rules = resolveBreakerRules({ rules: { recovery: { onCanaryFailure: 'nonsense' as never } } });
    expect(rules.recovery.onCanaryFailure).toBe('backoff');
  });
});

describe('onCanaryFailure = initial', () => {
  it('probe failure re-OPENs at the initial ladder rung even from an escalated position', () => {
    const { manager, clock } = makeManager({ recovery: { onCanaryFailure: 'initial' } });
    // Manual trip at a 20s ladder position (escalated state to drop FROM).
    manager.trip('p/x', { cooldownMs: 20_000 }, 'p');
    clock.advance(20_000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // HALF_OPEN, slot consumed

    manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN'); // re-OPEN, not CLOSED
    expect(snap?.currentCooldownMs).toBe(1000); // the initial rung, not backoff's 40000
    expect(snap?.reasonCode).toBe('breaker.canary');
  });
});

describe('onCanaryFailure = close (optimistic)', () => {
  it('probe failure CLOSES the breaker but retains consecutiveFailures + currentCooldownMs', () => {
    const { manager, clock } = makeManager({ recovery: { onCanaryFailure: 'close' } });
    tripAndHalfOpen(manager, clock);
    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe failure -> optimistic close

    const closed = manager.getSnapshot('p/x');
    expect(closed?.state).toBe('CLOSED');
    expect(closed?.consecutiveFailures).toBe(3); // 2 (trip) + 1 (the probe failure counted) — retained
    expect(closed?.currentCooldownMs).toBe(1000); // ladder position retained, NOT reset
    expect(closed?.reasonCode).toBeUndefined(); // display reason cleared

    // The very next counted failure re-trips with the ESCALATED ladder:
    // computed = initial 1000 x 2^(4-2) = 4000 (rule #9 retention payoff).
    manager.recordFailureScoped('p/x', NET_503, 'p');
    const retripped = manager.getSnapshot('p/x');
    expect(retripped?.state).toBe('OPEN');
    expect(retripped?.currentCooldownMs).toBe(4000);
    expect(retripped?.reasonCode).toBe('breaker.consecutive');
  });

  it('MANUAL breaker ignores close: probe failure always re-OPENS (backoff rung)', () => {
    const { manager, clock } = makeManager({ recovery: { onCanaryFailure: 'close' } });
    manager.trip('p/x', { cooldownMs: 1000 }, 'p'); // operator takedown, category MANUAL
    expect(manager.getSnapshot('p/x')?.category).toBe('MANUAL');
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // HALF_OPEN, slot consumed

    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe failure under a manual takedown

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN'); // never defeated: re-OPEN, not CLOSED
    expect(snap?.currentCooldownMs).toBe(2000); // backoff rung 1000 x 2
    expect(snap?.reasonCode).toBe('breaker.canary');
  });

  it('a MANUAL breaker under close keeps denying while its trial lingers (gate honors the takedown)', () => {
    const { manager, clock } = makeManager({ recovery: { onCanaryFailure: 'close' } });
    manager.trip('p/x', { cooldownMs: 1000 }, 'p');
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // the single probe slot
    expect(manager.canExecuteScoped('p/x').allowed).toBe(false); // quota exhausted -> still enforced
    expect(manager.getSnapshot('p/x')?.state).toBe('HALF_OPEN');
  });
});
