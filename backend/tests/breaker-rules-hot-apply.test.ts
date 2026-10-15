import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStateStore } from '../src/resilience/account-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules hot-apply — spec docs/design/circuit-breaker-rules-config.md
 * invariant 6 (v3.2, hot-apply).
 * `CircuitBreakerManager.applyConfig` swaps the resolved ruleset into the gate
 * and every live breaker; semantics: next-decision-point, no retroactive
 * re-evaluation, plus the invariant-2 reconciliation of a disabled rule's
 * OPEN breakers (the live twin of restoreState()'s startup filter).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-hotapply-'));
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
  const accountState = new AccountStateStore({ paths, now: clock.now });
  const config: CircuitBreakerConfig = { ...BASE, ...over, shadow, ...(rules ? { rules } : {}) };
  const manager = new CircuitBreakerManager(config, clock.now, accountState);
  manager.registerModel(model('p/x', 'p'));
  return { manager, clock, accountState, paths };
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
const QUOTA_402_PAIR: ErrorDiagnosis = { ...QUOTA_402, tripScope: 'pair' };
const SERVICE_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: true,
  shouldTripBreaker: true, hardTrip: false, minCooldownMs: 1000,
  reason: '503 upstream unavailable', reasonParams: { model: 'p/x', provider: 'p' },
};

describe('breaker rules hot-apply (invariant 6, v3.2)', () => {
  it('a rule disabled by the save reconciles its OPEN breakers right away — model AND pair', () => {
    const { manager } = makeManager();
    manager.recordFailure('p/x', QUOTA_402, 'p');
    expect(manager.canExecute('p/x').allowed).toBe(false);

    manager.recordFailureScoped('p/x', QUOTA_402_PAIR, 'p', 'abc123');
    expect(manager.getPairBreaker('p/x', 'abc123')?.getState()).toBe('OPEN');
    expect(manager.canExecuteScoped('p/x', 'abc123').allowed).toBe(false);

    // Disable the quota rule: the live twin of restoreState()'s filter —
    // the block nobody asked for goes away at save time, not at next boot.
    manager.applyConfig({ ...BASE, rules: { trip: { quota: { enabled: false } } } });
    expect(manager.canExecute('p/x').allowed).toBe(true);
    expect(manager.getPairBreaker('p/x', 'abc123')?.getState()).toBe('CLOSED');
    expect(manager.canExecuteScoped('p/x', 'abc123').allowed).toBe(true);

    // And the disabled rule drops NEW quota failures too (gate consults the
    // swapped ruleset).
    manager.recordFailure('p/x', QUOTA_402, 'p');
    expect(manager.canExecute('p/x').allowed).toBe(true);
  });

  it('rules still enabled leave existing OPEN cooldowns untouched — no retroactive re-evaluation', () => {
    const { manager } = makeManager();
    manager.recordFailure('p/x', QUOTA_402, 'p');
    const before = manager.getBreaker('p/x')?.getSnapshot();
    expect(before?.state).toBe('OPEN');

    // Re-resolve with a longer quota cooldown (rule stays ON): the running
    // OPEN timer keeps its original length — cooldownUntil is never recomputed.
    manager.applyConfig({ ...BASE, quotaCooldownMs: 120_000 });
    const after = manager.getBreaker('p/x')?.getSnapshot();
    expect(after?.state).toBe('OPEN');
    expect(after?.cooldownUntil).toBe(before?.cooldownUntil);
    expect(manager.canExecute('p/x').allowed).toBe(false);

    // Reconciliation is predicate-based, not diff-based: only OPEN breakers
    // whose reasonCode belongs to a now-disabled rule reset. breaker.manual
    // never reconciles even when other rules toggle.
    manager.trip('p/x', { reason: 'operator', cooldownMs: 30_000 });
    manager.applyConfig({ ...BASE, rules: { counting: { serverErrors: { enabled: false } } } });
    expect(manager.getBreaker('p/x')?.getSnapshot().state).toBe('OPEN');
  });

  it('new trip params govern from the next failure without touching accumulated state', () => {
    const { manager } = makeManager({
      trip: { consecutiveFailures: { threshold: 5, initialCooldownMs: 1000, cooldownMultiplier: 2, maxCooldownMs: 50_000 } },
    });
    for (let i = 0; i < 4; i++) manager.recordFailure('p/x', SERVICE_503, 'p');
    expect(manager.canExecute('p/x').allowed).toBe(true); // 4 < 5

    // Lower the threshold live: the NEXT failure trips under the new rules.
    manager.applyConfig({
      ...BASE,
      rules: { trip: { consecutiveFailures: { threshold: 2, initialCooldownMs: 1000, cooldownMultiplier: 2, maxCooldownMs: 50_000 } } },
    });
    manager.recordFailure('p/x', SERVICE_503, 'p');
    expect(manager.canExecute('p/x').allowed).toBe(false);
    expect(manager.getBreaker('p/x')?.getSnapshot().reasonCode).toBe('breaker.consecutive');
  });

  it('shadow flips live for existing breakers; the master enabled switch too', () => {
    const { manager } = makeManager();
    manager.recordFailure('p/x', QUOTA_402, 'p');
    expect(manager.canExecute('p/x').allowed).toBe(false);

    manager.applyConfig({ ...BASE, shadow: true });
    expect(manager.getRulesStatus().shadow).toBe(true);
    expect(manager.canExecute('p/x').allowed).toBe(true); // shadow verdict flips, state stays OPEN
    expect(manager.getBreaker('p/x')?.getState()).toBe('OPEN');

    manager.applyConfig({ ...BASE, shadow: false, enabled: false });
    expect(manager.canExecute('p/x').allowed).toBe(true); // master switch short-circuits the gate
  });
});
