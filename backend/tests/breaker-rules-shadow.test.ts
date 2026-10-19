import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { ActiveHealthProber, type ProberTargetResolver } from '../src/resilience/health-prober.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { CallCredential } from '../src/opencode/credentials/types.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';
import type { BreakerRulesConfig, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 8 (`circuitBreaker.shadow`, R4J
 * METRICS_ONLY): rules are evaluated and trips recorded (snapshots, ladders,
 * windows, probe slots — full accounting so the observer timeline matches an
 * enforcing one), but canExecute/peekExecute NEVER deny. Exempts: MANUAL trips
 * (operator intent), the DISABLED operator takedown, and SUSPECT gating.
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-rules-shadow-'));
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

const QUOTA_402: ErrorDiagnosis = {
  category: 'QUOTA_EXHAUSTED', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: true, reason: '402 insufficient_quota', reasonCode: 'breaker.quota',
};
const NET_503: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE', isRetriable: true, isInPlaceRetriable: false,
  shouldTripBreaker: true, hardTrip: false, reason: '503 bad gateway', reasonCode: 'breaker.network',
};

function makeShadowManager(rules?: BreakerRulesConfig, over: Partial<CircuitBreakerConfig> = {}) {
  const clock = makeClock();
  const paths = sandboxPaths();
  const credentialState = new CredentialStateStore({ paths, now: clock.now });
  const manager = new CircuitBreakerManager(
    { ...BASE, shadow: true, ...over, ...(rules ? { rules } : {}) },
    clock.now,
    credentialState,
  );
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

describe('shadow: full accounting, never denies', () => {
  it('an automatic trip is recorded and snapshotted while the gate keeps serving', () => {
    const { manager } = makeShadowManager();
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p'); // threshold reached -> OPEN

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN'); // recorded, snapshotted, summary-visible
    expect(snap?.reasonCode).toBe('breaker.consecutive');
    expect(snap?.totalFailures).toBe(2); // the window/ladder accounting ran
    expect(manager.getSummary().tripped).toBe(1);
    // ...yet nothing denies:
    expect(manager.canExecute('p/x').allowed).toBe(true);
    expect(manager.isAvailable('p/x')).toBe(true);
    expect(manager.modelAvailability('p/x', []).available).toBe(true);
    expect(manager.getRulesStatus().shadow).toBe(true);
  });

  it('the ladder keeps advancing while shadowed, and slots keep being consumed', () => {
    const { manager, clock } = makeShadowManager();
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p'); // OPEN @1000
    clock.advance(1000);

    expect(manager.canExecute('p/x').allowed).toBe(true); // HALF_OPEN: verdict flipped, but the SLOT is consumed
    expect(manager.getSnapshot('p/x')?.halfOpenProbes).toBe(1);

    manager.recordFailureScoped('p/x', NET_503, 'p'); // probe failure -> canary re-trip
    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.currentCooldownMs).toBe(2000); // ladder advanced exactly like enforcement
    expect(snap?.reasonCode).toBe('breaker.canary');
    expect(manager.canExecute('p/x').allowed).toBe(true); // still never denies
  });

  it('a shadow-exhausted HALF_OPEN probe quota still cannot strand the trial', () => {
    const { manager, clock } = makeShadowManager();
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');
    clock.advance(1000);
    manager.canExecute('p/x'); // slot 1/1 consumed

    expect(manager.canExecute('p/x').allowed).toBe(true); // over-budget verdict flipped to allowed
    expect(manager.getSnapshot('p/x')?.halfOpenProbes).toBe(1); // slot NOT double-consumed
    expect(manager.getSnapshot('p/x')?.state).toBe('HALF_OPEN');
  });

  it('hard trips are recorded too: 402 opens the snapshot while traffic flows', () => {
    const { manager } = makeShadowManager();
    manager.recordFailureScoped('p/x', QUOTA_402, 'p');

    const snap = manager.getSnapshot('p/x');
    expect(snap?.state).toBe('OPEN');
    expect(snap?.category).toBe('QUOTA_EXHAUSTED');
    expect(snap?.remainingCooldownMs).toBe(60_000); // recorded, not enforced
    expect(manager.canExecute('p/x').allowed).toBe(true);
  });

  it('shadow=false baseline denies (guards the flip from silently staying on)', () => {
    const clock = makeClock();
    const paths = sandboxPaths();
    const manager = new CircuitBreakerManager(
      { ...BASE, shadow: false },
      clock.now,
      new CredentialStateStore({ paths, now: clock.now }),
    );
    manager.registerModel(model('p/x', 'p'));
    manager.recordFailureScoped('p/x', NET_503, 'p');
    manager.recordFailureScoped('p/x', NET_503, 'p');

    expect(manager.canExecute('p/x').allowed).toBe(false);
    expect(manager.isAvailable('p/x')).toBe(false);
  });
});

describe('shadow exemptions: operator intent is not a rule', () => {
  it('a MANUAL OPEN trip enforces under shadow', () => {
    const { manager } = makeShadowManager();
    manager.trip('p/x', { cooldownMs: 5000 }, 'p');

    expect(manager.canExecute('p/x').allowed).toBe(false);
    expect(manager.isAvailable('p/x')).toBe(false);
  });

  it('the DISABLED operator takedown gates selection regardless of shadow', () => {
    const { manager, credentialState } = makeShadowManager();
    expect(credentialState.disable('p', 'K1', 'operator takedown')).toBe(true);
    expect(manager.isPairOut('p/x', 'K1')).toBe(true); // first check in isPairOut, exempt from shadow
    expect(manager.modelAvailability('p/x', ['K1']).openPrefixes).toEqual(['K1']);
  });

  it('SUSPECT gating is unaffected by shadow', () => {
    const { manager, credentialState } = makeShadowManager();
    credentialState.mark('p', 'K1', 'dead key');
    const gate = manager.canExecuteScoped('p/x', 'K1');
    expect(gate.allowed).toBe(false); // suspect refusal is the manager's, not the breaker verdict
    expect(manager.isPairOut('p/x', 'K1')).toBe(true);
  });
});

describe('shadow keeps the ActiveHealthProber faithful', () => {
  interface ProbeCall { modelId: string; prefix?: string }

  it('an OPEN-under-shadow model is still probed and can recover', async () => {
    const { manager, clock } = makeShadowManager();
    const m = model('p/x', 'p');
    // A pair-scope hard 429 (RA 3s > the 2000ms boundary -> hard) with a 3s
    // cooldown: OPEN -> due for a probe once the cooldown elapsed.
    const ra: ErrorDiagnosis = {
      ...NET_503, category: 'RATE_LIMITED', hardTrip: true, retryAfterSeconds: 3,
      tripScope: 'pair', reasonCode: 'breaker.rate_limit',
    };
    manager.recordFailureScoped('p/x', ra, 'p', 'K1');
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN'); // recorded under shadow
    clock.advance(3000); // cooldown max(1000 floor, 3000 RA) elapsed -> HALF_OPEN/due

    const calls: ProbeCall[] = [];
    const chain: CallCredential[] = [{ keyHashPrefix: 'K1', label: 'K1', key: 'sk-K1' }];
    const resolver: ProberTargetResolver = {
      getModel: (id) => (id === m.id ? m : undefined),
      getCredentialChain: () => chain,
      async execute(_req: ChatCompletionRequest, modelArg: ModelRegistration, _ctx?: unknown, prefix?: string) {
        calls.push({ modelId: modelArg.id, prefix });
        return { id: 'ok', object: 'chat.completion', created: 1, model: modelArg.upstreamModel, choices: [] } as unknown as ChatCompletionResponse;
      },
    };
    const prober = new ActiveHealthProber(manager, resolver);
    await prober.probeTrippedModels();

    expect(calls).toEqual([{ modelId: 'p/x', prefix: 'K1' }]); // the prober still runs for observer fidelity
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('CLOSED'); // and a probe can close the breaker
  });
});
