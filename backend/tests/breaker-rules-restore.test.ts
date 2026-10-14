import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStateStore } from '../src/resilience/account-state.js';
import { BreakerStateStore } from '../src/resilience/breaker-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerReasonCode, BreakerRecord, BreakerRulesConfig, BreakerStateFile, CircuitBreakerConfig } from '../src/resilience/types.js';

/**
 * Circuit-breaker rules config — spec area 9 (hard invariant 2): restore
 * reconciliation. OPEN records whose reasonCode belongs to a now-disabled trip
 * rule are dropped/skipped by restoreState() — a restart must never resurrect
 * a 12h quota block nobody asked for. HALF_OPEN and manual records are
 * unaffected; legacy record files without the new fields sanitize to 0.
 */

function sandboxPaths(tag: string): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-rules-restore-${tag}-`));
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
  maxCooldownMs: 5000,
  cooldownMultiplier: 2,
  quotaCooldownMs: 60_000,
  halfOpenMaxProbes: 1,
};

const X = 'p/x';

function model(id: string): ModelRegistration {
  return {
    id,
    provider: 'p',
    upstreamModel: id.split('/')[1] ?? id,
    tier: 'plus',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
}

function rec(over: Partial<BreakerRecord> = {}): BreakerRecord {
  return {
    modelId: X,
    provider: 'p',
    state: 'OPEN',
    consecutiveFailures: 1,
    totalRequests: 1,
    totalSuccesses: 0,
    totalFailures: 1,
    lastFailureTime: 0,
    lastSuccessTime: 0,
    trippedAt: 1,
    cooldownUntil: 9_999_999_999, // far future: restored records STAY open at clock 1_000_000
    currentCooldownMs: 60_000,
    halfOpenProbes: 0,
    halfOpenSuccesses: 0,
    halfOpenEnteredAt: 0,
    outcomeWindow: [],
    reason: 'persisted trip',
    ...over,
  };
}

/** Boot-shaped manager (register models, THEN attach the store) over a pre-seeded file. */
function bootedWith(tag: string, file: BreakerStateFile, rules?: BreakerRulesConfig) {
  const paths = sandboxPaths(tag);
  const clock = makeClock();
  fs.mkdirSync(paths.ocrHome, { recursive: true });
  const store = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
  fs.writeFileSync(store.filePath, JSON.stringify(file), 'utf8');
  const accountState = new AccountStateStore({ paths, now: clock.now });
  const manager = new CircuitBreakerManager({ ...BASE, ...(rules ? { rules } : {}) }, clock.now, accountState);
  manager.registerModel(model(X));
  manager.attachStateStore(store);
  return { manager, store, clock };
}

const file = (models: BreakerRecord[], pairs: BreakerRecord[] = []): BreakerStateFile => ({
  version: 1,
  savedAt: 1,
  models,
  pairs,
});

// (reasonCode, rules-with-that-switch-off) pairs per disabledTripReasonCodes().
const RULE_OFF_CASES: Array<[BreakerReasonCode, BreakerRulesConfig]> = [
  ['breaker.quota', { trip: { quota: { enabled: false } } }],
  ['breaker.auth', { trip: { auth: { enabled: false } } }],
  ['breaker.rate_limit', { trip: { rateLimit: { enabled: false } } }],
  ['breaker.consecutive', { trip: { consecutiveFailures: { enabled: false } } }],
  ['breaker.rate_window', { trip: { failureRate: { enabled: false } } }],
];

describe('restore drops OPEN records of disabled rules (invariant 2)', () => {
  it.each(RULE_OFF_CASES)('OPEN %s with its rule disabled: skipped, gate stays open', (code, rules) => {
    const { manager } = bootedWith(`drop-${code}`, file([rec({ reasonCode: code })]), rules);
    expect(manager.restoreState()).toEqual({ models: 0, pairs: 0 });
    // registerModel created the breaker eagerly, but it stays PRISTINE — the
    // OPEN record was skipped, not applied (invariant 2).
    const snap = manager.getSnapshot(X);
    expect(snap?.state).toBe('CLOSED');
    expect(snap?.totalRequests).toBe(0);
    expect(snap?.reasonCode).toBeUndefined();
    expect(manager.canExecute(X).allowed).toBe(true);
  });

  it('the same records DO restore when the rule is enabled (control)', () => {
    for (const [code] of RULE_OFF_CASES) {
      const { manager } = bootedWith(`keep-${code}`, file([rec({ reasonCode: code })]));
      expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
      expect(manager.canExecute(X).allowed).toBe(false);
    }
  });

  it('pair records of a disabled rule are dropped too', () => {
    const { manager } = bootedWith(
      'drop-pair',
      file([], [rec({ keyHashPrefix: 'K1', reasonCode: 'breaker.quota' })]),
      { trip: { quota: { enabled: false } } },
    );
    expect(manager.restoreState()).toEqual({ models: 0, pairs: 0 });
    expect(manager.getPairBreaker(X, 'K1')).toBeUndefined();
    expect(manager.isPairOut(X, 'K1')).toBe(false);
  });

  it('dropping one record does not drop the rest of the ledger', () => {
    const { manager } = bootedWith(
      'mixed',
      file([rec({ modelId: X, reasonCode: 'breaker.quota' }), rec({ modelId: 'p/z', reasonCode: 'breaker.manual' })],
      ),
      { trip: { quota: { enabled: false } } },
    );
    manager.registerModel(model('p/z'));
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    expect(manager.getSnapshot(X)?.state).toBe('CLOSED'); // dropped: pristine
    expect(manager.getSnapshot('p/z')?.state).toBe('OPEN'); // manual: kept
  });
});

describe('restore keeps what reconciliation must not touch', () => {
  it('HALF_OPEN records survive their reasonCode\u2019s rule being off (revived = OPEN only)', () => {
    const { manager } = bootedWith(
      'halfopen',
      file([rec({ state: 'HALF_OPEN', reasonCode: 'breaker.quota', cooldownUntil: 900 })]),
      { trip: { quota: { enabled: false } } },
    );
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    expect(manager.getSnapshot(X)?.state).toBe('HALF_OPEN');
    expect(manager.canExecute(X).allowed).toBe(true); // re-armed probe slot
  });

  it('manual OPEN records survive EVERY trip switch off (operator intent, not a rule)', () => {
    const allOff: BreakerRulesConfig = {
      trip: {
        quota: { enabled: false },
        auth: { enabled: false },
        rateLimit: { enabled: false },
        consecutiveFailures: { enabled: false },
        failureRate: { enabled: false },
      },
    };
    const { manager } = bootedWith('manual', file([rec({ reasonCode: 'breaker.manual', category: 'MANUAL' })]), allOff);
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    const snap = manager.getSnapshot(X);
    expect(snap?.category).toBe('MANUAL');
    expect(snap?.state).toBe('OPEN');
    expect(manager.canExecute(X).allowed).toBe(false);
  });

  it('canary-wrapped OPEN records are not reconciled (canary is not a rule\u2019s direct code)', () => {
    const { manager } = bootedWith(
      'canary',
      file([rec({ reasonCode: 'breaker.canary', category: 'SERVICE_UNAVAILABLE' })]),
      { trip: { consecutiveFailures: { enabled: false } } },
    );
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    expect(manager.getSnapshot(X)?.reasonCode).toBe('breaker.canary');
  });

  it('records without a reasonCode survive any toggle (legacy ledger control)', () => {
    const { manager } = bootedWith('noreason', file([rec({ reasonCode: undefined, reason: 'pre-code trip' })]), {
      trip: { quota: { enabled: false } },
    });
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    expect(manager.getSnapshot(X)?.state).toBe('OPEN');
  });
});

describe('legacy record files without the new fields sanitize to 0/undefined', () => {
  it('halfOpenSuccesses/halfOpenEnteredAt/outcomeWindow default; restore still applies', () => {
    const paths = sandboxPaths('legacy-fields');
    const clock = makeClock();
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    const store = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
    // A pre-rules-spec ledger: no halfOpenSuccesses, no halfOpenEnteredAt, no
    // outcomeWindow, plus an unknown reasonCode string a hand-edit could carry.
    fs.writeFileSync(
      store.filePath,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        models: [
          {
            modelId: X, provider: 'p', state: 'OPEN',
            consecutiveFailures: 4, totalRequests: 9, totalSuccesses: 5, totalFailures: 4,
            lastFailureTime: 5, lastSuccessTime: 6, trippedAt: 7,
            cooldownUntil: 9_999_999_999, currentCooldownMs: 60_000, halfOpenProbes: 0,
            reasonCode: 'breaker.bogus', reason: 'old trip',
          },
        ],
        pairs: [],
      }),
      'utf8',
    );

    const loaded = store.load()!;
    const loadedRec = loaded.models[0]!;
    expect(loadedRec.halfOpenSuccesses).toBe(0); // sanitized to zero, never undefined-into-the-machine
    expect(loadedRec.halfOpenEnteredAt).toBe(0);
    expect(loadedRec.outcomeWindow).toEqual([]);
    expect(loadedRec.reasonCode).toBeUndefined(); // closed vocabulary at the trust boundary

    const manager = new CircuitBreakerManager(BASE, clock.now, new AccountStateStore({ paths, now: clock.now }));
    manager.registerModel(model(X));
    manager.attachStateStore(store);
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    const snap = manager.getSnapshot(X)!;
    expect(snap.state).toBe('OPEN');
    expect(snap.consecutiveFailures).toBe(4); // old accumulation intact
    expect(snap.halfOpenSuccesses).toBe(0);
    expect(snap.halfOpenEnteredAt).toBeUndefined();
    expect(snap.reasonCode).toBeUndefined(); // pre-code trip renders via the verbatim reason fallback
    // reasonCode-less records are NOT reconciliation targets: quota-off would still keep this one.
  });

  it('a HALF_OPEN legacy record re-arms the refreshed counters on restore', () => {
    const { manager } = bootedWith(
      'legacy-halfopen',
      {
        version: 1,
        savedAt: 1,
        models: [
          {
            modelId: X, provider: 'p', state: 'HALF_OPEN',
            consecutiveFailures: 2, totalRequests: 3, totalSuccesses: 0, totalFailures: 3,
            lastFailureTime: 0, lastSuccessTime: 0, trippedAt: 0,
            cooldownUntil: 900, currentCooldownMs: 1000, halfOpenProbes: 1,
          } as unknown as BreakerRecord,
        ],
        pairs: [],
      },
      { recovery: { halfOpen: { maxProbes: 2, successThreshold: 2 } } },
    );
    expect(manager.restoreState()).toEqual({ models: 1, pairs: 0 });
    const snap = manager.getSnapshot(X)!;
    expect(snap.state).toBe('HALF_OPEN');
    expect(snap.halfOpenProbes).toBe(0); // today's quota refresh
    expect(snap.halfOpenSuccesses).toBe(0); // new counter refreshed too (rule #10)
    expect(snap.halfOpenEnteredAt).toBe(1_000_000); // maxWait clock re-arms from now
  });
});
