import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { CircuitBreakerManager, resolveBreakerRules } from '../src/resilience/index.js';
import { loadConfig } from '../src/config/index.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec `trip.failureRate.minCalls` (R4J
 * minimumNumberOfCalls / Envoy *_request_volume): the sliding-window rate is
 * evaluated only once >= minCalls recorded outcomes exist. Default = windowSize
 * keeps today's full-window judgment; lower it to trip faster on sparse
 * traffic. The sanitizer clamps minCalls <= windowSize (cross-field, resolved
 * against the effective global fallback) — otherwise the rate rule can never
 * evaluate and dies silently (invariant 5).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-mincalls-'));
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
  failureThreshold: 99, // keep the consecutive detector out of the rate tests' way
  slidingWindowSize: 20,
  failureRateThreshold: 0.5,
  initialCooldownMs: 1000,
  maxCooldownMs: 300_000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeManager(rules: BreakerRulesConfig, over: Partial<CircuitBreakerConfig> = {}) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const credentialState = new CredentialStateStore({ paths, now: clock.now });
  const manager = new CircuitBreakerManager({ ...BASE, ...over, rules }, clock.now, credentialState);
  const m: ModelRegistration = {
    id: 'p/x', provider: 'p', upstreamModel: 'x', tier: 'plus',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
  manager.registerModel(m);
  return { manager, clock };
}

const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, reason: '503 bad gateway', reasonCode: 'breaker.network',
};

describe('minCalls gate', () => {
  it('rate is NOT decided below minCalls, and trips the moment it is reached', () => {
    const { manager } = makeManager({
      trip: { failureRate: { windowSize: 4, minCalls: 2, failureRate: 0.5 } },
    });
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // 1 < minCalls 2 — a 100% rate is ignored

    manager.recordFailureScoped('p/x', NET_503, 'p'); // 2 >= minCalls -> 100% >= 50%
    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.rate_window');
    expect(snap?.reasonParams?.rate).toBe(100);
    expect(snap?.reasonParams?.threshold).toBe(50);
  });

  it('a success does not evaluate the rate even once the sample floor is met', () => {
    const { manager } = makeManager({
      trip: { failureRate: { windowSize: 4, minCalls: 2, failureRate: 0.5 } },
    });
    manager.recordFailureScoped('p/x', NET_503, 'p'); // window [F] below the floor
    manager.recordSuccess('p/x'); // window [F,S] — 50% would cross, but only failures count toward it

    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    manager.recordFailureScoped('p/x', NET_503, 'p'); // window [F,S,F] — 66% >= 50% at 3 samples
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
  });

  it('default minCalls = windowSize preserves the full-window judgment', () => {
    const { manager } = makeManager({ trip: { failureRate: { windowSize: 3 } } }); // minCalls unset -> 3
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // 2/2 would be 100% — but the floor is 3
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');

    // Legacy shape (no per-rule window): nothing trips before the whole
    // global slidingWindowSize of 20 fills — today's implicit behavior.
    const legacy = makeManager({ trip: { consecutiveFailures: { enabled: false } } });
    for (let i = 0; i < 19; i++) legacy.manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(legacy.manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    legacy.manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(legacy.manager.getSnapshot('p/x')?.state).toBe('OPEN');
    expect(legacy.manager.getSnapshot('p/x')?.reasonCode).toBe('breaker.rate_window');
  });

  it('minCalls=1 trips the rate on the very first failure (sparse-traffic fast trip)', () => {
    const { manager } = makeManager({
      trip: { failureRate: { windowSize: 10, minCalls: 1, failureRate: 0.5 } },
    });
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
  });

  it('rule windowSize beats the global slidingWindowSize (ring sized per rule)', () => {
    const { manager } = makeManager(
      { trip: { failureRate: { windowSize: 3 } } }, // minCalls default = rule 3, not global 20
      { slidingWindowSize: 20 },
    );
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // tripped at 3, not 20
  });
});

describe('minCalls clamps (sanitizer + resolver defense)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-mincalls-cfg-'));
  let n = 0;
  const cfg = (yaml: string): CircuitBreakerConfig => {
    const p = path.join(dir, `c${n++}.yaml`);
    fs.writeFileSync(p, yaml, 'utf8');
    return loadConfig(p).circuitBreaker!;
  };

  it('minCalls above the RULE windowSize clamps down to it', () => {
    const c = cfg('circuitBreaker:\n  rules:\n    trip:\n      failureRate:\n        windowSize: 4\n        minCalls: 9\n');
    expect(c.rules?.trip?.failureRate?.minCalls).toBe(4);
    expect(resolveBreakerRules(c).trip.failureRate.minCalls).toBe(4);
  });

  it('minCalls above the GLOBAL slidingWindowSize clamps down to it (auto fallback)', () => {
    const c = cfg('circuitBreaker:\n  slidingWindowSize: 6\n  rules:\n    trip:\n      failureRate:\n        minCalls: 9\n');
    expect(c.rules?.trip?.failureRate?.minCalls).toBe(6);
  });

  it('negative minCalls clamps to 0 (rate decided from the first outcome)', () => {
    const c = cfg('circuitBreaker:\n  rules:\n    trip:\n      failureRate:\n        minCalls: -3\n');
    expect(c.rules?.trip?.failureRate?.minCalls).toBe(0);
  });

  it('the resolver re-clamps config that skipped the sanitizer (defense in depth)', () => {
    // Cast: programmatic construction deliberately violates the saved-YAML contract.
    const r = resolveBreakerRules({
      slidingWindowSize: 10,
      rules: { trip: { failureRate: { windowSize: 3, minCalls: 99 } } },
    } as unknown as CircuitBreakerConfig);
    expect(r.trip.failureRate.windowSize).toBe(3);
    expect(r.trip.failureRate.minCalls).toBe(3);
  });
});
