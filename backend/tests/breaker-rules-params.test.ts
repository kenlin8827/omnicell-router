import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 2: per-rule parameters beat the
 * global knob; unset parameters fall back to it; a config with NO `rules` key
 * at all behaves byte-for-byte like the pre-rules pipeline (legacy constants:
 * threshold 3, initial 30s, multiplier 2.0, quota 12h, single canary).
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-params-'));
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
  maxCooldownMs: 300_000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

function makeManager(rules?: BreakerRulesConfig, over: Partial<CircuitBreakerConfig> = {}) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const credentialState = new CredentialStateStore({ paths, now: clock.now });
  const config: CircuitBreakerConfig = { ...BASE, ...over, ...(rules ? { rules } : {}) };
  const manager = new CircuitBreakerManager(config, clock.now, credentialState);
  manager.registerModel(model('p/x', 'p'));
  return { manager, clock, credentialState };
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

const QUOTA_402: ErrorDiagnosis = {
  category: 'QUOTA_EXHAUSTED', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, minCooldownMs: 999_999,
  reason: '402 insufficient_quota', reasonCode: 'breaker.quota',
};
const AUTH_401: ErrorDiagnosis = {
  category: 'AUTHENTICATION_ERROR', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, minCooldownMs: 999_999,
  reason: '401 invalid_api_key', reasonCode: 'breaker.auth',
};
const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, minCooldownMs: 1000,
  reason: '503 bad gateway', reasonCode: 'breaker.network', reasonParams: { cause: 'GATEWAY_ERROR', status: 503 },
};

// ─── hard-trip durations resolve from the RULE, never from the diagnosis ────

describe('hard trip: trip.quota/auth.cooldownMs beat the global knob', () => {
  it('trip.quota.cooldownMs overrides quotaCooldownMs and the diagnosis minCooldownMs', () => {
    const { manager } = makeManager({ trip: { quota: { cooldownMs: 5000 } } });
    manager.recordFailureScoped('p/x', QUOTA_402, 'p'); // diagnosis carries 999_999

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.currentCooldownMs).toBe(5000); // rule param wins over global 60_000 and the carrier field
    expect(snap?.remainingCooldownMs).toBe(5000);
    expect(snap?.reasonCode).toBe('breaker.quota');
  });

  it('trip.auth.cooldownMs overrides the global quota cooldown', () => {
    const { manager } = makeManager({ trip: { auth: { cooldownMs: 7000 } } });
    manager.recordFailureScoped('p/x', AUTH_401, 'p');

    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(7000);
  });

  it('unset cooldownMs falls back to the global quotaCooldownMs knob', () => {
    const { manager } = makeManager({ trip: { quota: {}, auth: {} } }, { quotaCooldownMs: 45_000 });
    manager.recordFailureScoped('p/x', QUOTA_402, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(45_000);

    manager.reset('p/x');
    manager.recordFailureScoped('p/x', AUTH_401, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(45_000);
  });
});

// ─── statistical params: rule beats global, unset inherits ──────────────────

describe('statistical trip rules: per-rule params beat the global knobs', () => {
  it('trip.consecutiveFailures.threshold beats global failureThreshold', () => {
    const { manager } = makeManager({ trip: { consecutiveFailures: { threshold: 2 } } }, { failureThreshold: 5 });
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.consecutive');
    expect(snap?.reasonParams?.threshold).toBe(2);
  });

  it('unset threshold falls back to the global failureThreshold', () => {
    const { manager } = makeManager({ trip: { consecutiveFailures: {} } }, { failureThreshold: 2 });
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN');
  });

  it('trip.consecutiveFailures.initialCooldownMs beats the global initialCooldownMs', () => {
    const { manager } = makeManager({ trip: { consecutiveFailures: { initialCooldownMs: 4000 } } });
    for (let i = 0; i < 3; i++) manager.recordFailureScoped('p/x', NET_503, 'p');

    // max(counting floor 1000, computed 4000) — the rule ladder starts at 4000.
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(4000);
  });

  it('trip.failureRate windowSize/failureRate/cooldownMs beat the global knobs', () => {
    const { manager } = makeManager(
      {
        trip: {
          consecutiveFailures: { enabled: false },
          failureRate: { windowSize: 3, failureRate: 1.0, cooldownMs: 9000 },
        },
      },
      { slidingWindowSize: 20, failureRateThreshold: 0.5 },
    );
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // below the rule window (minCalls default 3)
    manager.recordFailureScoped('p/x', NET_503, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.reasonCode).toBe('breaker.rate_window');
    expect(snap?.reasonParams?.threshold).toBe(100); // 1.0, not the global 0.5
    expect(snap?.currentCooldownMs).toBe(9000); // rule cooldownMs beats global initial 1000
  });

  it('counting.serverErrors.minCooldownMs raises the floor via max(min, computed)', () => {
    const { manager } = makeManager(
      { counting: { serverErrors: { minCooldownMs: 8000 } } },
      { failureThreshold: 1 },
    );
    manager.recordFailureScoped('p/x', NET_503, 'p');

    // Computed ladder would be 1000; the counted class floor lifts it to 8000 (rule #6).
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(8000);
  });

  it('counting.unknownErrors.minCooldownMs floors UNKNOWN-class trips', () => {
    const unk: ErrorDiagnosis = {
      category: 'UNKNOWN', isRetriable: true, isInPlaceRetriable: false,
      shouldTripBreaker: true, hardTrip: false, reason: 'HTTP 418 something', reasonCode: 'breaker.unknown',
    };
    const { manager } = makeManager(
      { counting: { unknownErrors: { minCooldownMs: 9000 } } },
      { failureThreshold: 1 },
    );
    manager.recordFailureScoped('p/x', unk, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(9000);
  });
});

// ─── recovery params ────────────────────────────────────────────────────────

describe('recovery params', () => {
  it('recovery.cooldownMultiplier overrides the canary escalation rung', () => {
    const { manager, clock } = makeManager({ recovery: { cooldownMultiplier: 4 } });
    for (let i = 0; i < 3; i++) manager.recordFailureScoped('p/x', NET_503, 'p'); // trip @1000
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // consume the canary slot
    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe failure

    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(4000); // 1000 x 4 (recovery), not x 2 (global)
  });

  it('trip.consecutiveFailures.cooldownMultiplier + maxCooldownMs own the statistical ladder rung', () => {
    // Ladder escalation is exercised via the optimistic-close retention path:
    // consecutiveFailures survives the close, so the next failure lands on the
    // ladder exponent (consec - threshold) with THIS rule's multiplier/cap.
    const { manager, clock } = makeManager(
      {
        trip: { consecutiveFailures: { threshold: 2, initialCooldownMs: 4000, cooldownMultiplier: 3, maxCooldownMs: 50_000 } },
        recovery: { onCanaryFailure: 'close' },
      },
      { failureThreshold: 9, initialCooldownMs: 1000, cooldownMultiplier: 2 },
    );
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p'); // consec 2 -> trip at rule initial 4000
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(4000);

    clock.advance(4000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true); // HALF_OPEN slot
    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe fail -> optimistic CLOSE (consec kept)
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');

    manager.recordFailureScoped('p/x', NET_503, 'p'); // consec 4 -> 4000 x 3^(4-2) = 36000
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(36_000); // rule mult 3, NOT global 2 (=16000)

    clock.advance(36_000);
    manager.canExecuteScoped('p/x');
    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe fail closes optimistically again (consec 5 kept)
    manager.recordFailureScoped('p/x', NET_503, 'p'); // consec 6 -> 4000 x 3^4 = 324000 -> rule cap 50000
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(50_000);
  });
});

// ─── byte-for-byte legacy (no rules key, no knobs) ──────────────────────────

describe('legacy config with NO rules key behaves byte-for-byte as today', () => {
  it('threshold 3, initial 30s, multiplier 2.0, quota 12h, single canary — the hardcoded constants', () => {
    const clock = makeClock();
    const manager = new CircuitBreakerManager({ enabled: true }, clock.now, new CredentialStateStore({ paths: sandboxPaths(), now: clock.now }));
    manager.registerModel(model('p/x', 'p'));

    // 5xx statistical: 3 strikes, 30s initial rung.
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(30_000);

    // Canary failure doubles: 30s -> 60s (global multiplier 2.0).
    clock.advance(30_000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true);
    manager.recordFailureScoped('p/x', NET_503, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(60_000);

    // Hard trips at the 12h quota block.
    manager.reset('p/x');
    manager.recordFailureScoped('p/x', QUOTA_402, 'p');
    expect(manager.getSnapshot('p/x')?.currentCooldownMs).toBe(12 * 3600 * 1000);

    // Single-probe HALF_OPEN budget: the 2nd gate call is denied.
    manager.reset('p/x');
    manager.trip('p/x', { cooldownMs: 1000 }, 'p');
    clock.advance(1000);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(true);
    expect(manager.canExecuteScoped('p/x').allowed).toBe(false);
  });

  it('burst 429 (at-or-below 2000ms default boundary) stays counted; long RA stays hard', () => {
    const { manager } = makeManager(); // BASE, no rules
    const burst: ErrorDiagnosis = { ...NET_503, category: 'RATE_LIMITED', retryAfterSeconds: 2, hardTrip: false, reasonCode: 'breaker.rate_limit' };
    manager.recordFailureScoped('p/x', burst, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED'); // counted, not hard

    const long: ErrorDiagnosis = { ...burst, retryAfterSeconds: 3, hardTrip: true };
    manager.recordFailureScoped('p/x', long, 'p');
    expect(manager.getSnapshot('p/x')?.state).toBe('OPEN'); // hard trip
  });

  it('CLIENT_ERROR default: never counted, never trips (today non-penalizing default)', () => {
    const { manager } = makeManager();
    const client: ErrorDiagnosis = {
      category: 'CLIENT_ERROR', isRetriable: false, isInPlaceRetriable: false,
      shouldTripBreaker: false, hardTrip: false, reason: '400 context_length_exceeded',
    };
    for (let i = 0; i < 5; i++) manager.recordFailureScoped('p/x', client, 'p');
    expect(manager.getSnapshot('p/x')?.totalFailures).toBe(0);
    expect(manager.getSnapshot('p/x')?.state).toBe('CLOSED');
  });
});
