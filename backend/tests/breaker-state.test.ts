import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { BreakerStateStore } from '../src/resilience/breaker-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import { breakerStateFile } from '../src/opencode/credentials/paths.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { BreakerStateFile, CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * Breaker memory on disk.
 *
 * The failure this exists to prevent: a restart used to wipe every cooldown,
 * letting the gateway re-hammer a 402 credential still inside its quota
 * cooldown. Under test: what survives (state, cooldown position, backoff,
 * sliding window, manual trips, pairs), what self-cleans (records for models
 * the config removed), and what never breaks the boot (corrupt files).
 *
 * Determinism: the store is built with a 1h debounce so only an explicit
 * `flush()` writes; the clock is hand-advanced — nothing sleeps.
 */

function sandboxPaths(tag: string): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-breaker-state-${tag}-`));
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

const CFG: CircuitBreakerConfig = {
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

function makeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function model(id: string): ModelRegistration {
  return {
    id,
    provider: 'anthropic',
    upstreamModel: id.split('/')[1] ?? id,
    tier: 'plus',
    pricing: { input: 1, output: 2, cacheRead: 0.1 },
  };
}

const X = 'anthropic/claude-x';
const Y = 'anthropic/claude-y';

const quotaDiag = (over: Partial<ErrorDiagnosis> = {}): ErrorDiagnosis => ({
  category: 'QUOTA_EXHAUSTED',
  isRetriable: false,
  isInPlaceRetriable: false,
  shouldTripBreaker: true,
  hardTrip: true,
  reason: '402 insufficient_quota',
  reasonCode: 'breaker.quota',
  ...over,
});

const outageDiag: ErrorDiagnosis = {
  category: 'SERVICE_UNAVAILABLE',
  isRetriable: true,
  isInPlaceRetriable: false,
  shouldTripBreaker: true,
  hardTrip: false,
  reason: '503 upstream unavailable',
  reasonCode: 'breaker.network',
};

/** A manager wired like the boot path: models registered, THEN store attached. */
function bootManager(clock: ReturnType<typeof makeClock>, paths: CredentialPaths, registered: ModelRegistration[]) {
  const credentialState = new CredentialStateStore({ paths, now: clock.now });
  const store = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
  const manager = new CircuitBreakerManager(CFG, clock.now, credentialState);
  for (const m of registered) manager.registerModel(m);
  manager.attachStateStore(store);
  return { manager, store, credentialState };
}

describe('BreakerStateStore — restart continuity', () => {
  it('a hard quota trip survives a restart: the fresh instance keeps blocking until the cooldown', () => {
    const paths = sandboxPaths('quota');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    first.manager.recordFailureScoped(X, quotaDiag({ tripScope: 'pair' }), 'anthropic', 'k1');
    first.store.flush();

    // "Restart": a brand-new manager over the same file, same instant.
    const second = bootManager(clock, paths, [model(X)]);
    expect(second.manager.restoreState()).toEqual({ pairs: 1 });
    const gate = second.manager.canExecuteScoped(X, 'k1');
    expect(gate.allowed).toBe(false);
    expect(gate.state).toBe('OPEN');
    expect(second.manager.getSnapshot(X)?.remainingCooldownMs).toBe(60_000);

    // The restored cooldown keeps counting down on the ORIGINAL timeline.
    clock.advance(60_000);
    expect(second.manager.canExecuteScoped(X, 'k1').allowed).toBe(true); // canary slot
    second.manager.recordSuccessScoped(X, 'k1');
    expect(second.manager.getPairBreaker(X, 'k1')?.getState()).toBe('CLOSED');
  });

  it('a chain-less sentinel tuple (keyHashPrefix "") survives a restart', () => {
    const paths = sandboxPaths('sentinel-restart');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    // Unattributed failure → the sentinel tuple (chain-less providers).
    first.manager.recordFailure(X, quotaDiag({ tripScope: 'model' }), 'anthropic');
    expect(first.manager.getPairBreaker(X, '')?.getState()).toBe('OPEN');
    first.store.flush();

    const second = bootManager(clock, paths, [model(X)]);
    expect(second.manager.restoreState()).toEqual({ pairs: 1 });
    expect(second.manager.getPairBreaker(X, '')?.getState()).toBe('OPEN');
    expect(second.manager.canExecute(X).allowed).toBe(false);
  });

  it('a snapshot flushed mid-canary restores HALF_OPEN with a fresh probe quota (gate never strands)', () => {
    const paths = sandboxPaths('stranded');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1'); // OPEN, 1000ms cooldown
    clock.advance(1000);
    expect(first.manager.canExecuteScoped(X, 'k1').allowed).toBe(true); // consumes the only probe slot
    first.store.flush();

    const second = bootManager(clock, paths, [model(X)]);
    second.manager.restoreState();
    // Before the applyRecord quota refresh this gate denied forever: the only
    // exits from HALF_OPEN are recordSuccess/recordFailure, which need an
    // admitted probe. With the refresh, one canary still gets through.
    expect(second.manager.canExecuteScoped(X, 'k1').allowed).toBe(true);
    second.manager.recordSuccessScoped(X, 'k1');
    expect(second.manager.getPairBreaker(X, 'k1')?.getState()).toBe('CLOSED');
  });

  it('credential-scoped resetByScope arms the debounced snapshot like every other mutation entry point', () => {
    const paths = sandboxPaths('credential-reset');
    const clock = makeClock();
    const boot = bootManager(clock, paths, [model(X)]);
    boot.manager.recordFailureScoped(X, quotaDiag({ tripScope: 'pair' }), 'anthropic', 'K1');
    boot.store.flush(); // persist the OPEN pair record
    const m = bootManager(clock, paths, [model(X)]);
    m.manager.restoreState();

    let armed = 0;
    const original = m.store.requestSave.bind(m.store);
    m.store.requestSave = (build: () => unknown) => {
      armed++;
      return original(build as () => BreakerStateFile);
    };

    const res = m.manager.resetByScope('credential', { keyHashPrefix: 'K1' });
    expect(res.resetCount).toBe(1);
    expect(m.manager.canExecuteScoped(X, 'K1').allowed).toBe(true);
    // The credential branch calls breaker.reset() directly, bypassing the hooked
    // reset/resetScoped entry points — so it must arm the save itself.
    expect(armed).toBeGreaterThan(0);
  });

  it('a failed save keeps the snapshot for retry — one transient write error must not lose memory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-breaker-savefail-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x'); // a FILE where a directory must be -> mkdir/mkdir-parent fails
    const paths: CredentialPaths = { ...sandboxPaths('savefail'), ocrHome: path.join(blocker, 'home') };
    const store = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
    let builds = 0;
    store.requestSave(() => {
      builds++;
      return { version: 1, savedAt: 0, models: [], pairs: [] };
    });
    store.flush(); // write throws, caught + warned — the thunk must survive
    expect(builds).toBe(1);
    store.flush(); // retried, not silently consumed on the first failure
    expect(builds).toBe(2);
  });

  it('a wall-clock rewind while the gateway was off cannot stretch the restored cooldown', () => {
    const paths = sandboxPaths('rewind');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    first.manager.recordFailureScoped(X, quotaDiag({ tripScope: 'pair' }), 'anthropic', 'k1'); // hard trip: 60_000ms ladder
    first.store.flush();
    clock.advance(-86_400_000); // system clock jumps back 24h before restart

    const second = bootManager(clock, paths, [model(X)]);
    second.manager.restoreState();
    // Liveness invariant remaining <= ladder position, clamped against the
    // rewind (applyRecord Math.min guard).
    const snap = second.manager.getPairBreaker(X, 'k1')?.getSnapshot();
    expect(snap?.remainingCooldownMs).toBeLessThanOrEqual(60_000);
    clock.advance(60_000);
    expect(second.manager.canExecuteScoped(X, 'k1').allowed).toBe(true);
  });

  it('breaker memory is scoped per environment by filename (env switches cannot clobber each other)', () => {
    const paths = sandboxPaths('env-scope');
    expect(path.basename(breakerStateFile(paths, 'work'))).toBe('breaker-state.work.json');
    expect(breakerStateFile(paths, 'work')).not.toBe(breakerStateFile(paths, 'prod'));
  });

  it('no write happens until the debounced/forced save — a storm coalesces to one file', () => {
    const paths = sandboxPaths('debounce');
    const clock = makeClock();
    const m = bootManager(clock, paths, [model(X)]);
    m.manager.recordFailure(X, quotaDiag());
    m.manager.recordFailure(Y, quotaDiag());
    expect(fs.existsSync(m.store.filePath)).toBe(false);
    m.store.flush();
    const file = JSON.parse(fs.readFileSync(m.store.filePath, 'utf8'));
    expect(file.version).toBe(1);
    expect(file.pairs.map((r: { modelId: string }) => r.modelId).sort()).toEqual([X, Y]);
  });

  it('backoff position survives: canary-fail escalation continues where the old process left off', () => {
    const paths = sandboxPaths('backoff');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    // 3 consecutive 5xx -> trip at initial 1000ms; canary fail doubles to 2000.
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    expect(first.manager.getSnapshot(X)?.currentCooldownMs).toBe(1000);
    clock.advance(1000);
    expect(first.manager.canExecuteScoped(X, 'k1').allowed).toBe(true);
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    expect(first.manager.getSnapshot(X)?.currentCooldownMs).toBe(2000);
    first.store.flush();

    const second = bootManager(clock, paths, [model(X)]);
    second.manager.restoreState();
    const snap = second.manager.getPairBreaker(X, 'k1')?.getSnapshot();
    expect(snap?.currentCooldownMs).toBe(2000); // next escalation keeps doubling from here
    expect(snap?.remainingCooldownMs).toBe(2000);
    expect(snap?.reasonCode).toBe('breaker.canary');
  });

  it('failure accumulation survives: consecutive count is not reset by the restart', () => {
    const paths = sandboxPaths('accumulate');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1');
    first.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1'); // 2/3 — not tripped yet
    expect(first.manager.getSnapshot(X)?.state).toBe('CLOSED');
    first.store.flush();

    const second = bootManager(clock, paths, [model(X)]);
    second.manager.restoreState();
    expect(second.manager.getPairBreaker(X, 'k1')?.getSnapshot().consecutiveFailures).toBe(2);
    second.manager.recordFailureScoped(X, { ...outageDiag, tripScope: 'pair' }, 'anthropic', 'k1'); // 3rd -> threshold reached
    expect(second.manager.getSnapshot(X)?.state).toBe('OPEN');
  });

  it('pair breakers (credential-scope fan-out) restore with their keyHashPrefix attribution', () => {
    const paths = sandboxPaths('pairs');
    const clock = makeClock();
    // Hard-trip length resolves from trip.quota.cooldownMs (default = CFG
    // quotaCooldownMs 60_000); minCooldownMs is only a statistical-path floor.
    const credentialDiag = quotaDiag({ tripScope: 'credential', minCooldownMs: 10_000 });
    const first = bootManager(clock, paths, [model(X), model(Y)]);
    first.manager.recordFailureScoped(X, credentialDiag, 'anthropic', 'k1');
    expect(first.manager.isPairOut(X, 'k1')).toBe(true);
    expect(first.manager.isPairOut(Y, 'k1')).toBe(true); // credential-wide blast radius
    first.store.flush();

    const second = bootManager(clock, paths, [model(X), model(Y)]);
    // The CLOSED model breakers ride along too — restore counts every applied record.
    expect(second.manager.restoreState()).toEqual({ pairs: 2 });
    expect(second.manager.isPairOut(X, 'k1')).toBe(true);
    expect(second.manager.isPairOut(Y, 'k1')).toBe(true);
    // Aggregation degenerates correctly: k2 never failed, so the model stays up.
    const avail = second.manager.modelAvailability(X, ['k1', 'k2']);
    expect(avail.available).toBe(true);
    expect(avail.openPrefixes).toEqual(['k1']);
    // k1-only chain: nothing else can serve X right now.
    expect(second.manager.modelAvailability(X, ['k1']).available).toBe(false);
  });

  it('manual trips persist and an operator reset persists too (the console gesture survives)', () => {
    const paths = sandboxPaths('manual');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X)]);
    first.manager.tripByScope('pair', { modelId: X, keyHashPrefix: 'kZ', providerId: 'anthropic' }, { cooldownMs: 3_600_000, reason: 'vendor maintenance' });
    first.store.flush();

    const second = bootManager(clock, paths, [model(X)]);
    second.manager.restoreState();
    const snap = second.manager.getPairBreaker(X, 'kZ')?.getSnapshot();
    expect(snap?.state).toBe('OPEN');
    expect(snap?.category).toBe('MANUAL');
    expect(snap?.reasonCode).toBe('breaker.manual');
    expect(snap?.remainingCooldownMs).toBe(3_600_000);

    second.manager.reset(X);
    second.store.flush();
    const third = bootManager(clock, paths, [model(X)]);
    expect(third.manager.restoreState()).toEqual({ pairs: 1 }); // the CLOSED tuple persists (reset state survived)
    expect(third.manager.getSnapshot(X)?.state).toBe('CLOSED');
  });

  it('pair records for models the config removed are dropped and never ghost back', () => {
    const paths = sandboxPaths('prune');
    const clock = makeClock();
    const first = bootManager(clock, paths, [model(X), model(Y)]);
    first.manager.recordFailureScoped(X, quotaDiag({ tripScope: 'pair' }), 'anthropic', 'k1');
    first.manager.recordFailureScoped(Y, quotaDiag({ tripScope: 'pair' }), 'anthropic', 'k1');
    first.store.flush();

    // "Config change": Y is gone from the gateway.
    const second = bootManager(clock, paths, [model(X)]);
    expect(second.manager.restoreState()).toEqual({ pairs: 1 }); // Y's tuple record: dropped, unknown model
    expect(second.manager.getSnapshot(Y)).toBeUndefined();
    second.manager.recordSuccessScoped(X, 'k1'); // any mutation re-saves the pruned set
    second.store.flush();
    const file = JSON.parse(fs.readFileSync(second.store.filePath, 'utf8'));
    expect(file.pairs.filter((r: { keyHashPrefix: string }) => r.keyHashPrefix).map((r: { modelId: string }) => r.modelId)).toEqual([X]);
  });

  it('an unparseable file starts with empty memory and is preserved aside on the first write', () => {
    const paths = sandboxPaths('corrupt');
    const clock = makeClock();
    const m = bootManager(clock, paths, [model(X)]);
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(m.store.filePath, '{ half-written');
    expect(m.manager.restoreState()).toEqual({ pairs: 0 });

    m.manager.recordFailure(X, quotaDiag());
    m.store.flush();
    const live = JSON.parse(fs.readFileSync(m.store.filePath, 'utf8'));
    expect(live.pairs.length).toBe(1);
    const asides = fs.readdirSync(paths.ocrHome).filter(f => f.includes('.corrupt.'));
    expect(asides.length).toBe(1);
  });

  it('junk pair entries are sanitized at the boundary: valid records still restore, garbage is dropped', () => {
    const paths = sandboxPaths('sanitize');
    const clock = makeClock();
    const m = bootManager(clock, paths, [model(X), model(Y)]);
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    fs.writeFileSync(
      m.store.filePath,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        // A legacy models[] ledger is ignored wholesale on restore.
        models: [{ modelId: X, provider: 'anthropic', state: 'OPEN' }],
        pairs: [
          { modelId: X, provider: 'anthropic', state: 'BOGUS' }, // illegal state -> dropped
          { modelId: 'anon', provider: 'anthropic', keyHashPrefix: 'k9', state: 'OPEN' }, // unknown model -> dropped
          { modelId: X, provider: 'anthropic', state: 'OPEN' }, // pair without prefix -> dropped
          { modelId: Y, provider: 'anthropic', keyHashPrefix: 'k1', state: 'OPEN', cooldownUntil: 999_000, consecutiveFailures: 'NaN' },
        ],
      })
    );
    expect(m.manager.restoreState()).toEqual({ pairs: 1 });
    const snap = m.manager.getPairBreaker(Y, 'k1')?.getSnapshot();
    // cooldownUntil 999_000 < now 1_000_000: the restored machine flips to
    // HALF_OPEN on the first check exactly like a live one would have.
    expect(snap?.state).toBe('HALF_OPEN');
    expect(snap?.consecutiveFailures).toBe(0); // coerced garbage scalar -> zero value
  });
});
