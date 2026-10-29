import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStateStore } from '../src/resilience/credential-state.js';
import { BreakerStateStore } from '../src/resilience/breaker-state.js';
import { CircuitBreakerManager } from '../src/resilience/circuit-breaker-manager.js';
import { ErrorClassifier, UpstreamError } from '../src/resilience/error-classifier.js';
import { ActiveHealthProber, type ProberTargetResolver } from '../src/resilience/health-prober.js';
import type { CredentialPaths } from '../src/opencode/credentials/paths.js';
import type { ChatCompletionRequest, ChatCompletionResponse } from '../src/types/openai.js';
import type { ModelRegistration } from '../src/config/types.js';
import type { CallCredential } from '../src/opencode/credentials/types.js';
import type { CircuitBreakerConfig, ErrorDiagnosis } from '../src/resilience/types.js';

/**
 * The resilience CORE: pair breakers keyed
 * (modelId x credentialKeyHashPrefix), classifier tripScope, SUSPECT credential
 * flags, model aggregation, prober per-model budget.
 *
 * State root is sandboxed the same way the credential tests sandbox theirs —
 * the operator's ~/.omnicell-router is never touched.
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pairs-'));
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

const CELL_CFG: CircuitBreakerConfig = {
  enabled: true,
  failureThreshold: 3,
  initialCooldownMs: 1000,
  quotaCooldownMs: 60_000,
};

/** Fixed clock, advanced by hand — no sleeping in resilience tests. */
function makeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function makeManager(cfg: CircuitBreakerConfig = CELL_CFG, clock = makeClock(), store?: CredentialStateStore) {
  const paths = sandboxPaths();
  const credentialState = store ?? new CredentialStateStore({ paths, now: clock.now });
  const manager = new CircuitBreakerManager(cfg, clock.now, credentialState);
  return { manager, credentialState, paths, clock };
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

const diagnosis = (over: Partial<ErrorDiagnosis> = {}): ErrorDiagnosis => ({
  category: 'RATE_LIMITED',
  isRetriable: true,
  isInPlaceRetriable: false,
  shouldTripBreaker: true,
  hardTrip: true,
  // Realistic hard-429 shape: the manager gate re-derives hard/counted from
  // retryAfterSeconds vs trip.rateLimit.hardTripAboveMs (2000ms default), and
  // the hard-trip length from Retry-After — minCooldownMs is only a
  // statistical-path floor, never a hard-trip duration anymore.
  retryAfterSeconds: 60,
  minCooldownMs: 60_000,
  reason: 'test diagnosis',
  ...over,
});

// ─── (a) classifier tripScope table ─────────────────────────────────────────

function stamped(status: number, message: string, keyHashPrefix?: string, extra: Record<string, unknown> = {}): UpstreamError {
  const err = new UpstreamError({ message, status, provider: 'p', modelId: 'p/m1', ...extra });
  if (keyHashPrefix) (err as { usedCredentialKeyHashPrefix?: string }).usedCredentialKeyHashPrefix = keyHashPrefix;
  return err;
}

describe('(a) classifier tripScope + credentialSuspect table', () => {
  const K = 'aaaaaaaaaaaa';

  it('QUOTA 402 -> credential, and NOT suspect (quota recovers on its own)', () => {
    const d = ErrorClassifier.classify(stamped(402, 'insufficient_quota', K), 'p/m1', 'p');
    expect(d.category).toBe('QUOTA_EXHAUSTED');
    expect(d.tripScope).toBe('credential');
    expect(d.credentialSuspect).toBeUndefined();
  });

  it('AUTH 401 -> credential + credentialSuspect', () => {
    const d = ErrorClassifier.classify(stamped(401, 'invalid_api_key', K), 'p/m1', 'p');
    expect(d.category).toBe('AUTHENTICATION_ERROR');
    expect(d.tripScope).toBe('credential');
    expect(d.credentialSuspect).toBe(true);
  });

  it('RATE_LIMITED 429 -> pair (per-model RPM window), Retry-After still honored', () => {
    const d = ErrorClassifier.classify(stamped(429, 'requests per minute exceeded', K, { retryAfterSeconds: 3600 }), 'p/m1', 'p');
    expect(d.category).toBe('RATE_LIMITED');
    expect(d.tripScope).toBe('pair');
    expect(d.minCooldownMs).toBe(3_600_000);
    expect(d.credentialSuspect).toBeUndefined();
  });

  it('RATE_LIMITED with daily/weekly-limit wording -> credential', () => {
    const weekly = ErrorClassifier.classify(stamped(429, 'You have hit your weekly limit, resets at 9pm', K), 'p/m1', 'p');
    expect(weekly.tripScope).toBe('credential');
    const daily = ErrorClassifier.classify(stamped(429, 'daily limit of 100 requests exceeded', K), 'p/m1', 'p');
    expect(daily.tripScope).toBe('credential');
    expect(weekly.credentialSuspect).toBeUndefined(); // a spent budget is not a dead key
  });

  it('5xx / network jitter -> model', () => {
    const five = ErrorClassifier.classify(stamped(503, 'bad gateway', K), 'p/m1', 'p');
    expect(five.category).toBe('SERVICE_UNAVAILABLE');
    expect(five.tripScope).toBe('model');
    const net = ErrorClassifier.classify(stamped(0, 'socket hang up', K), 'p/m1', 'p');
    expect(net.tripScope).toBe('model');
  });

  it('unclassified -> pair (Decision 6: under-cool rather than over-cool)', () => {
    const d = ErrorClassifier.classify(stamped(418, 'something nobody recognizes', K), 'p/m1', 'p');
    expect(d.category).toBe('UNKNOWN');
    expect(d.tripScope).toBe('pair');
  });

  it('CLIENT_ERROR -> no trip at all, even under attribution', () => {
    const d = ErrorClassifier.classify(
      stamped(400, 'context_length_exceeded: this prompt is too long', K),
      'p/m1',
      'p'
    );
    expect(d.category).toBe('CLIENT_ERROR');
    expect(d.shouldTripBreaker).toBe(false);
    expect(d.tripScope).toBeUndefined();
  });

  // The legacy guarantee: with no credential attribution the diagnosis is
  // field-for-field what pre-P3 produced — same keys, same values. With
  // attribution the ONLY additions are the new blast-radius fields.
  const legacyCases: Array<[string, number, string, string | undefined]> = [
    ['quota', 402, 'insufficient_quota', 'credential'],
    ['auth', 401, 'invalid_api_key', 'credential'],
    ['rate', 429, 'too many requests', 'pair'],
    ['rate-weekly', 429, 'weekly limit reached', 'credential'],
    ['outage', 503, 'bad gateway', 'model'],
    ['unknown', 418, 'something nobody recognizes', 'pair'],
    ['client', 400, 'context_length_exceeded', undefined],
  ];

  it.each(legacyCases)('chain-less %s error keeps byte-identical model-level semantics', (_label, status, message, scope) => {
    const plain = ErrorClassifier.classify(stamped(status, message), 'p/m1', 'p');
    expect('tripScope' in plain).toBe(false);
    expect('credentialSuspect' in plain).toBe(false);
    expect('usedKeyHashPrefix' in plain).toBe(false);

    const attributed = ErrorClassifier.classify(stamped(status, message, 'bbbbbbbbbbbb'), 'p/m1', 'p');
    const plainKeys = Object.keys(plain);
    const added = Object.keys(attributed).filter((k) => !plainKeys.includes(k));
    // The stamp rides only on trip-bearing diagnoses (CLIENT_ERROR never trips
    // and never carries blast radius, so it stays stamp-free).
    const expectedAdded = scope
      ? ['tripScope', 'usedKeyHashPrefix', ...(status === 401 ? ['credentialSuspect'] : [])].sort()
      : [];
    expect(added.sort()).toEqual(expectedAdded);
    expect(attributed.tripScope).toBe(scope);
    if (scope) expect(attributed.usedKeyHashPrefix).toBe('bbbbbbbbbbbb');
    for (const key of plainKeys as Array<keyof ErrorDiagnosis>) {
      if (key === 'rawError') continue;
      expect(attributed[key]).toEqual(plain[key]);
    }
  });
});

// ─── (b) pair trip isolation ────────────────────────────────────────────────

describe('(b) pair trips are isolated per (model x credential)', () => {
  it('a pair trip on X/K1 leaves X/K2 and Y/K1 and every other tuple untouched', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));

    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K1');

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.canExecuteScoped('p/x', 'K2').allowed).toBe(true);
    expect(manager.canExecuteScoped('p/y', 'K1').allowed).toBe(true); // model-specific independence
    expect(manager.getPairBreaker('p/x', '')?.getState() ?? 'CLOSED').toBe('CLOSED'); // sentinel tuple never cooled by a credential fault
    expect(manager.canExecute('p/x').allowed).toBe(true);

    const agg = manager.modelAvailability('p/x', ['K1', 'K2']);
    expect(agg.available).toBe(true);
    expect(agg.openPrefixes).toEqual(['K1']);
  });

  it('a soft no-chain model-scope failure accumulates on the sentinel tuple', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    const soft = diagnosis({ hardTrip: false, category: 'SERVICE_UNAVAILABLE' });

    // Model-scope fan-out without a chain: no materialized tuples and no
    // chain prefixes means the failure degenerates to the sentinel '' tuple.
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'model', ...soft }), 'p', 'K1');

    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('CLOSED'); // threshold not reached yet
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'model', ...soft }), 'p', 'K1');
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'model', ...soft }), 'p', 'K1');
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('OPEN'); // sentinel ladder tripped at threshold
    expect(manager.getPairBreaker('p/x', 'K1')).toBeUndefined(); // attribution never materializes a K1 tuple on a model-scope fan-out
  });
});

// ─── (c) credential expansion ──────────────────────────────────────────────────────

describe('(c) credential scope cools the whole credential, not the model', () => {
  it('quota on K1 opens every K1 pair, K2 stays alive, model available via K2', () => {
    const { manager, credentialState } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));
    manager.registerModel(model('q/z', 'q')); // other provider must not care

    manager.recordFailureScoped('p/x', diagnosis({ category: 'QUOTA_EXHAUSTED', tripScope: 'credential' }), 'p', 'K1');

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.getPairBreaker('p/y', 'K1')?.getState()).toBe('OPEN'); // never-used model, still covered
    expect(manager.canExecuteScoped('p/y', 'K1').allowed).toBe(false);
    expect(manager.canExecuteScoped('p/x', 'K2').allowed).toBe(true);
    expect(manager.canExecute('p/x').allowed).toBe(true); // the sentinel tuple is untouched by a credential-scoped trip

    const agg = manager.modelAvailability('p/x', ['K1', 'K2']);
    expect(agg.available).toBe(true);
    expect(agg.openPrefixes).toEqual(['K1']);
    // Credential scope did not spread to another provider's pair breakers.
    expect(manager.getPairBreaker('q/z', 'K1')).toBeUndefined();
    expect(credentialState.list()).toEqual([]); // quota is NOT suspect
  });

  it('an credential with every credential down takes the model down through the aggregate', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    const credentialDiagnosis = diagnosis({ category: 'QUOTA_EXHAUSTED', tripScope: 'credential' });
    manager.recordFailureScoped('p/x', credentialDiagnosis, 'p', 'K1');
    manager.recordFailureScoped('p/x', credentialDiagnosis, 'p', 'K2');

    const agg = manager.modelAvailability('p/x', ['K1', 'K2']);
    expect(agg.available).toBe(false);
    expect(agg.openPrefixes).toEqual(['K1', 'K2']);
    expect(manager.canExecuteScoped('p/x', 'K1').allowed).toBe(false);
  });
});
// ─── (c2) attribution fallback from the diagnosis stamp ─────────────────────

describe('(c2) a credential fault with no selection prefix still cools the credential', () => {
  it('quota carrying the stamp trips the pair even when the caller passes no prefix', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));

    // Degenerate selection (all-unhealthy / no-session): prefix undefined,
    // but the chain head served the attempt and registry.execute stamped it.
    manager.recordFailureScoped(
      'p/x',
      diagnosis({ category: 'QUOTA_EXHAUSTED', tripScope: 'credential', usedKeyHashPrefix: 'K1' }),
      'p',
      undefined
    );

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.getPairBreaker('p/y', 'K1')?.getState()).toBe('OPEN'); // credential-wide via the stamp
    expect(manager.canExecute('p/x').allowed).toBe(true); // the sentinel tuple is untouched by a credential-scoped trip
    expect(manager.canExecuteScoped('p/x', 'K2').allowed).toBe(true);
  });

  it('end-to-end: a stamped 402 classified without a selection prefix lands on the pair', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    const d = ErrorClassifier.classify(stamped(402, 'insufficient_quota', 'K1'), 'p/x', 'p');

    manager.recordFailureScoped('p/x', d, 'p', undefined);

    expect(d.usedKeyHashPrefix).toBe('K1');
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.canExecute('p/x').allowed).toBe(true); // credential fault never touches the sentinel tuple
  });

  it('no stamp and no prefix lands on the sentinel pair (the chain-less degeneracy)', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));

    manager.recordFailureScoped('p/x', diagnosis({ category: 'QUOTA_EXHAUSTED', tripScope: 'credential' }), 'p', undefined);

    expect(manager.getPairBreaker('p/x', 'K1')).toBeUndefined();
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('OPEN'); // the sentinel tuple carries the unattributed trip
    expect(manager.canExecute('p/x').allowed).toBe(false);
  });
});

// ─── (d) model trip via 5xx ────────────────────────────────────────────────

describe('(d) model trip takes every credential out', () => {
  it('an outage with the chain fans out: every tuple trips at threshold and nothing serves', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    // Realistic shape: SERVICE_UNAVAILABLE counts toward the statistical
    // detectors (threshold 3 in CELL_CFG); no hard-trip hatch exists for 5xx.
    // The orchestrator passes the chain prefixes, so the model-scope fan-out
    // covers credentials that never served the failing attempt.
    const outage = diagnosis({ category: 'SERVICE_UNAVAILABLE', tripScope: 'model', hardTrip: false });
    const chainPrefixes = ['K1', 'K2'];

    for (let i = 0; i < 3; i++) {
      manager.recordFailureScoped('p/x', outage, 'p', 'K1', chainPrefixes);
    }

    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.getPairBreaker('p/x', 'K2')?.getState()).toBe('OPEN'); // created on demand by the fan-out
    const agg = manager.modelAvailability('p/x', chainPrefixes);
    expect(agg.available).toBe(false);
    expect(agg.openPrefixes).toEqual(['K1', 'K2']); // every tuple down = nothing serves
    expect(manager.canExecuteScoped('p/x', 'K2').allowed).toBe(false);
  });

  it('without a chain the model-scope fan-out degenerates to the sentinel tuple', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    const outage = diagnosis({ category: 'SERVICE_UNAVAILABLE', tripScope: 'model', hardTrip: false });

    for (let i = 0; i < 3; i++) {
      manager.recordFailureScoped('p/x', outage, 'p', 'K1');
    }

    // No chain prefixes passed and nothing materialized before the first
    // failure: the fan-out lands on the sentinel '' tuple, never on K1.
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('OPEN');
    expect(manager.getPairBreaker('p/x', 'K1')).toBeUndefined();
    expect(manager.modelAvailability('p/x', ['K1', 'K2']).available).toBe(true); // no tuple is out
  });
});

// ─── (e) SUSPECT flag lifecycle ─────────────────────────────────────────────

describe('(e) SUSPECT flag: auth credential-scope marks it, it survives recreation, clear() lifts it', () => {
  it('marks, persists, blocks after the cooldown expires, clears', () => {
    const paths = sandboxPaths();
    const clock = makeClock();
    const store = new CredentialStateStore({ paths, now: clock.now });
    const { manager } = makeManager(CELL_CFG, clock, store);
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));

    const auth = diagnosis({ category: 'AUTHENTICATION_ERROR', tripScope: 'credential', credentialSuspect: true });
    manager.recordFailureScoped('p/x', auth, 'p', 'K1');

    expect(store.list().map((a) => a.providerId + '/' + a.keyHashPrefix)).toEqual(['p/K1']);
    expect(store.isSuspect('p', 'K1')).toBe(true);
    expect(store.isSuspect('p', 'K2')).toBe(false);
    expect(store.isSuspect('q', 'K1')).toBe(false); // composite key, not prefix-only

    // Idempotent: re-marking never duplicates and never re-stamps markedAt.
    const first = store.get('p', 'K1')!.markedAt;
    store.mark('p', 'K1', 'again');
    expect(store.list()).toHaveLength(1);
    expect(store.get('p', 'K1')!.markedAt).toBe(first);

    // SUSPECT is file-backed under the OCR GLOBAL state root, display-safe only.
    const file = path.join(paths.ocrHome, 'suspect-credentials.json');
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).toContain('K1');
    expect(onDisk).not.toMatch(/sk-/);

    // Cooldown expiry un-trips the pair breakers — the flag must still refuse service.
    clock.advance(120_000);
    manager.reset(); // simulates a restart-and-untrip world
    const rebound = new CircuitBreakerManager(CELL_CFG, clock.now, new CredentialStateStore({ paths, now: clock.now }));
    rebound.registerModel(model('p/x', 'p'));
    expect(rebound.isSuspect('p/x', 'K1')).toBe(true);
    expect(rebound.canExecuteScoped('p/x', 'K1').allowed).toBe(false);
    expect(rebound.modelAvailability('p/x', ['K1', 'K2'])).toEqual({ available: true, openPrefixes: ['K1'] });

    // Explicit clear (console reconnect / admin REST) is the only way back.
    expect(rebound.getCredentialStateStore().clear('p', 'K1')).toBe(true);
    expect(rebound.isSuspect('p/x', 'K1')).toBe(false);
    expect(rebound.canExecuteScoped('p/x', 'K1').allowed).toBe(true);
    expect(rebound.getCredentialStateStore().clear('p', 'K1')).toBe(false); // idempotent clear
    expect(fs.existsSync(file)).toBe(true);
  });

  it('a corrupt flags file is preserved, never silently replaced', () => {
    const paths = sandboxPaths();
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    const file = path.join(paths.ocrHome, 'suspect-credentials.json');
    fs.writeFileSync(file, '{"version":1,"acc', 'utf8');

    const store = new CredentialStateStore({ paths });
    expect(store.isSuspect('p', 'K1')).toBe(false); // reads as empty, does not throw
    store.mark('p', 'K1', 'dead key');

    const survivors = fs.readdirSync(paths.ocrHome).filter((f) => f.includes('.corrupt.'));
    expect(survivors).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('K1');
  });

  it('a well-formed flags file with an unknown version is preserved too', () => {
    const paths = sandboxPaths();
    fs.mkdirSync(paths.ocrHome, { recursive: true });
    const file = path.join(paths.ocrHome, 'suspect-credentials.json');
    // Parses cleanly but no reader here understands it: the preserveCorrupt
    // path must fire on the shape branch, not only on the JSON-error branch.
    fs.writeFileSync(file, '{"version":2,"credentials":{}}', 'utf8');

    const store = new CredentialStateStore({ paths });
    expect(store.isSuspect('p', 'K1')).toBe(false); // read as empty, not fatal
    store.mark('p', 'K1', 'dead key');

    const survivors = fs.readdirSync(paths.ocrHome).filter((f) => f.includes('.corrupt.'));
    expect(survivors).toHaveLength(1);
    expect(fs.readFileSync(path.join(paths.ocrHome, survivors[0]), 'utf8')).toContain('"version":2');
    expect(fs.readFileSync(file, 'utf8')).toContain('K1');
  });

  it('a manual credential trip never implies a suspect mark', () => {
    const { manager, credentialState } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.tripCredential('K1', { reason: 'maintenance' }, 'p');
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(credentialState.list()).toEqual([]);
  });
});

// ─── (f) prober per-model budget ───────────────────────────────────────────

interface ProbeCall {
  modelId: string;
  prefix?: string;
}

function makeResolver(opts: {
  models: ModelRegistration[];
  chains: Record<string, CallCredential[]>;
  failing?: Set<string>; // `${modelId}|${prefix ?? ''}`
}): { resolver: ProberTargetResolver; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const byId = new Map(opts.models.map((m) => [m.id, m]));
  const resolver: ProberTargetResolver = {
    getModel: (id) => byId.get(id),
    getCredentialChain: (name) => opts.chains[name],
    async execute(_req: ChatCompletionRequest, model: ModelRegistration, _ctx?: unknown, prefix?: string) {
      calls.push({ modelId: model.id, prefix });
      if (opts.failing?.has(`${model.id}|${prefix ?? ''}`)) {
        throw new UpstreamError({ message: 'still down', status: 503, provider: model.provider, modelId: model.id });
      }
      return { id: 'ok', object: 'chat.completion', created: 1, model: model.upstreamModel, choices: [] } as ChatCompletionResponse;
    },
  };
  return { resolver, calls };
}

const chain = (...prefixes: string[]): CallCredential[] =>
  prefixes.map((keyHashPrefix) => ({ keyHashPrefix, label: keyHashPrefix, key: `sk-${keyHashPrefix}` }));

describe('(f) prober probes one representative pair per model', () => {
  it('budget 1: a fully tripped model yields exactly one call', () => {
    const clock = makeClock();
    const { manager } = makeManager({ ...CELL_CFG, halfOpenMaxProbes: 1 }, clock);
    const m = model('p/x', 'p');
    manager.registerModel(m);
    for (const prefix of ['K1', 'K2', 'K3']) {
      manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', prefix);
    }
    clock.advance(120_000); // cooldowns elapsed -> HALF_OPEN, due for probe

    const { resolver, calls } = makeResolver({ models: [m], chains: { p: chain('K1', 'K2', 'K3') } });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.modelId).toBe('p/x');
      expect(manager.snapshotsWithPairs().filter((s) => s.keyHashPrefix)).toHaveLength(3);
      // and the probe closed the pair it went through (success)
      expect(manager.getPairBreaker('p/x', calls[0]!.prefix!)?.getState()).toBe('CLOSED');
    });
  });

  it('a tripped model breaker probes through the first live prefix, skipping OPEN and SUSPECT', () => {
    const clock = makeClock();
    const paths = sandboxPaths();
    const store = new CredentialStateStore({ paths, now: clock.now });
    const { manager } = makeManager(CELL_CFG, clock, store);
    const m = model('p/x', 'p');
    manager.registerModel(m);
    // model breaker down with a SHORT cooldown, two pairs down with a LONG one,
    // a third credential administratively suspect: only K4 is live when due.
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'model', hardTrip: true }), 'p', 'K0');
    const stillCooling = diagnosis({ tripScope: 'pair', retryAfterSeconds: 600 }); // hard 429, 600_000ms cooldown
    manager.recordFailureScoped('p/x', stillCooling, 'p', 'K1');
    manager.recordFailureScoped('p/x', stillCooling, 'p', 'K2');
    store.mark('p', 'K3', 'dead key');
    clock.advance(120_000); // model HALF_OPEN; K1/K2 still OPEN; K4 never failed

    const { resolver, calls } = makeResolver({ models: [m], chains: { p: chain('K1', 'K2', 'K3', 'K4') } });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls.map((c) => c.prefix)).toEqual(['K4']);
      // The probe's success lands on K4's tuple; the sentinel tuple that armed
      // the trial stays armed, and K1 was never probed (budget spent).
      expect(manager.getPairBreaker('p/x', 'K4')?.getState()).toBe('CLOSED');
      expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('HALF_OPEN');
      expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN'); // never probed: budget spent
    });
  });

  it('budget 2: two representative credentials per model, never three', () => {
    const clock = makeClock();
    const { manager } = makeManager({ ...CELL_CFG, halfOpenMaxProbes: 2 }, clock);
    const m = model('p/x', 'p');
    manager.registerModel(m);
    for (const prefix of ['K1', 'K2', 'K3']) {
      manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', prefix);
    }
    clock.advance(120_000);

    const { resolver, calls } = makeResolver({ models: [m], chains: { p: chain('K1', 'K2', 'K3') } });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.prefix)).toEqual(['K1', 'K2']);
    });
  });

  it('a suspect pair is never probed (no auto-return, Decision 6)', () => {
    const clock = makeClock();
    const paths = sandboxPaths();
    const store = new CredentialStateStore({ paths, now: clock.now });
    const { manager } = makeManager(CELL_CFG, clock, store);
    const m = model('p/x', 'p');
    manager.registerModel(m);
    store.mark('p', 'K1', 'dead key');
    manager.tripPair('p/x', 'K1', { cooldownMs: 1000 }, 'p');
    clock.advance(120_000);

    const { resolver, calls } = makeResolver({ models: [m], chains: { p: chain('K1') } });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls).toEqual([]);
    });
  });

  it('no pair breakers and no chain = today\'s bare model probe', () => {    const clock = makeClock();
    const { manager } = makeManager(CELL_CFG, clock);
    const m = model('p/x', 'p');
    manager.registerModel(m);
    manager.recordFailure('p/x', diagnosis({ tripScope: undefined, hardTrip: true }), 'p');
    clock.advance(120_000);

    const { resolver, calls } = makeResolver({ models: [m], chains: {} });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls).toEqual([{ modelId: 'p/x', prefix: undefined }]);
      expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('CLOSED');
    });
  });
});

// ─── Extras: degeneracy, snapshots, per-model budget ────────────────────────

describe('Extras: single-pair degeneracy and snapshot surfaces', () => {
  it('a caller that omits the prefix is byte-identical to the legacy API', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    const noScope = diagnosis({ tripScope: undefined });

    manager.recordFailureScoped('p/x', noScope, 'p');

    expect(manager.getPairBreaker('p/x', 'K1')).toBeUndefined();
    expect(manager.snapshotsWithPairs().filter((s) => s.keyHashPrefix)).toEqual([]);
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('OPEN'); // hardTrip diagnosis lands on the sentinel tuple
    expect(manager.canExecuteScoped('p/x')).toEqual(manager.canExecute('p/x'));
    expect(manager.canExecuteScoped('p/x').allowed).toBe(false);
    // A success does not un-trip an OPEN breaker — same as recordSuccess(modelId).
    manager.recordSuccessScoped('p/x');
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('OPEN');
    manager.reset('p/x');
    expect(manager.getPairBreaker('p/x', '')?.getState()).toBe('CLOSED');
    // Empty candidate list = no chain registered = model check alone.
    expect(manager.modelAvailability('p/x', [])).toEqual({ available: true, openPrefixes: [] });
  });

  it('getSummary/getAllSnapshots fold the worst tuple state per model', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K1');
    manager.recordFailureScoped('p/y', diagnosis({ tripScope: 'pair' }), 'p', 'K2');

    expect(manager.getAllSnapshots()).toHaveLength(2);
    expect(manager.getSummary().total).toBe(2);
    expect(manager.getSummary().tripped).toBe(2); // an OPEN tuple folds its model to OPEN
    expect(manager.snapshotsWithPairs()).toHaveLength(2);
    expect(manager.snapshotsWithPairs().filter((s) => s.keyHashPrefix).map((s) => s.keyHashPrefix).sort()).toEqual(['K1', 'K2']);
  });

  it('getPairSummary reports ONLY pair breakers — the console status `pairs` block', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K1');
    manager.recordFailureScoped('p/y', diagnosis({ tripScope: 'pair' }), 'p', 'K2');
    manager.recordFailureScoped('p/y', diagnosis({ tripScope: 'pair' }), 'p', 'K3');
    manager.resetScoped('p/y', 'K2'); // one pair back to CLOSED → split the counts

    const pairs = manager.getPairSummary();
    expect(pairs.total).toBe(3);
    expect(pairs.tripped).toBe(2);
    expect(pairs.healthy).toBe(1);
    expect(pairs.halfOpen).toBe(0);
    // Every row carries the credential identity — readers never mix layers.
    expect(pairs.breakers.every((s) => s.keyHashPrefix !== undefined)).toBe(true);
    // The model summary is the derived fold of the same tuples.
    expect(manager.getSummary().total).toBe(2);
    expect(manager.getSummary().tripped).toBe(2);
  });

  it('reset(modelId) clears every tuple of the model; resetScoped clears one', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K1');
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K2');

    expect(manager.resetScoped('p/x', 'K1').resetCount).toBe(1);
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('CLOSED');
    expect(manager.getPairBreaker('p/x', 'K2')?.getState()).toBe('OPEN');
    expect(manager.resetScoped('p/x', 'K4').resetCount).toBe(0); // unknown pair: no-op

    expect(manager.resetByScope('model', { modelId: 'p/x' }).resetCount).toBe(2); // both tuples of the model
    expect(manager.getPairBreaker('p/x', 'K2')?.getState()).toBe('CLOSED');
  });
});

// ─── Extras: prober budget is per model, not global ────────────────────────

describe('Extras: prober budget is per model, not global', () => {
  it('two tripped models get one probe each, not one in total', () => {
    const clock = makeClock();
    const { manager } = makeManager(CELL_CFG, clock);
    const x = model('p/x', 'p');
    const y = model('p/y', 'p');
    manager.registerModel(x);
    manager.registerModel(y);
    manager.recordFailureScoped('p/x', diagnosis({ tripScope: 'pair' }), 'p', 'K1');
    manager.recordFailureScoped('p/y', diagnosis({ tripScope: 'pair' }), 'p', 'K1');
    clock.advance(120_000);

    const { resolver, calls } = makeResolver({
      models: [x, y],
      chains: { p: chain('K1') },
    });
    const prober = new ActiveHealthProber(manager, resolver);
    return prober.probeTrippedModels().then(() => {
      expect(calls.map((c) => `${c.modelId}/${c.prefix}`)).toEqual(['p/x/K1', 'p/y/K1']);
    });
  });
});

// ─── (c3) manual takedowns mirror the fan-out contract ──────────────────────

describe('(c3) a manual model-scope trip takes the WHOLE chain out', () => {
  it('trips every chain tuple even when nothing has failed yet', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));

    // Operator takedown with the full chain — no prior tuples exist.
    const result = manager.trip('p/x', undefined, 'p', ['K1', 'K2']);

    expect(result.affected).toBe(2);
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('OPEN');
    expect(manager.getPairBreaker('p/x', 'K2')?.getState()).toBe('OPEN');
    expect(manager.canExecuteScoped('p/x', 'K1').allowed).toBe(false);
    expect(manager.modelAvailability('p/x', ['K1', 'K2']).available).toBe(false);
  });

  it('modelAvailability consults the sentinel tuple when the chain is empty', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.trip('p/x', undefined, 'p');
    // A chain-less manual trip lives on the sentinel tuple — it must read out.
    expect(manager.modelAvailability('p/x', []).available).toBe(false);
    expect(manager.modelHealthView('p/x', [])).toBe('unavailable');
  });

  it('an empty chain with a healthy sentinel stays available', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    expect(manager.modelAvailability('p/x', []).available).toBe(true);
  });
});

// ─── (c4) recovery symmetry: resetByScope restores exactly what the trip touched ──

describe('(c4) recovery symmetry per scope, including the lastScope label round-trip', () => {
  it('pair trip → resetByScope(pair) restores only that tuple', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.tripByScope('pair', { modelId: 'p/x', keyHashPrefix: 'K1', providerId: 'p' }, { cooldownMs: 60_000 });
    manager.tripByScope('pair', { modelId: 'p/x', keyHashPrefix: 'K2', providerId: 'p' }, { cooldownMs: 60_000 });

    const r = manager.resetByScope('pair', { modelId: 'p/x', keyHashPrefix: 'K1' });
    expect(r.resetCount).toBe(1);
    expect(manager.getPairBreaker('p/x', 'K1')?.getState()).toBe('CLOSED');
    expect(manager.getPairBreaker('p/x', 'K2')?.getState()).toBe('OPEN'); // sibling untouched
  });

  it('credential trip → resetByScope(credential) restores every model the trip fanned out to', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));
    manager.tripCredential('K1', { cooldownMs: 60_000 }, 'p');

    const r = manager.resetByScope('credential', { keyHashPrefix: 'K1' });
    expect(r.resetCount).toBe(2); // p/x and p/y
    expect(manager.canExecuteScoped('p/x', 'K1').allowed).toBe(true);
    expect(manager.canExecuteScoped('p/y', 'K1').allowed).toBe(true);
  });

  it('model trip → resetByScope(model) restores the whole chain and nothing else', () => {
    const { manager } = makeManager();
    manager.registerModel(model('p/x', 'p'));
    manager.registerModel(model('p/y', 'p'));
    manager.tripByScope('model', { modelId: 'p/x', providerId: 'p', chainPrefixes: ['K1', 'K2'] }, { cooldownMs: 60_000 });

    const r = manager.resetByScope('model', { modelId: 'p/x' });
    expect(r.resetCount).toBe(2);
    expect(manager.modelAvailability('p/x', ['K1', 'K2']).available).toBe(true);
    expect(manager.modelAvailability('p/y', ['K1', 'K2']).available).toBe(true); // p/y untouched
  });

  it('the lastScope label survives snapshotsWithPairs and a persisted restart', () => {
    const paths = sandboxPaths('scope-label');
    const clock = makeClock();
    const credentialState = new CredentialStateStore({ paths, now: clock.now });
    const store = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
    const first = new CircuitBreakerManager(CELL_CFG, clock.now, credentialState);
    first.registerModel(model('p/x', 'p'));
    first.attachStateStore(store);

    first.tripByScope('model', { modelId: 'p/x', providerId: 'p', chainPrefixes: ['K1', 'K2'] }, { cooldownMs: 60_000 });
    first.tripByScope('pair', { modelId: 'p/x', keyHashPrefix: 'K1', providerId: 'p' }, { cooldownMs: 60_000 }); // re-trips K1 as pair
    expect(first.snapshotsWithPairs().find((s) => s.keyHashPrefix === 'K1')?.scope).toBe('pair');
    expect(first.snapshotsWithPairs().find((s) => s.keyHashPrefix === 'K2')?.scope).toBe('model');
    store.flush();

    // "Restart": the labels ride the persisted records back into lastScope.
    const store2 = new BreakerStateStore({ paths, debounceMs: 3_600_000 });
    const second = new CircuitBreakerManager(CELL_CFG, clock.now, credentialState);
    second.registerModel(model('p/x', 'p'));
    second.attachStateStore(store2);
    second.restoreState();
    expect(second.snapshotsWithPairs().find((s) => s.keyHashPrefix === 'K1')?.scope).toBe('pair');
    expect(second.snapshotsWithPairs().find((s) => s.keyHashPrefix === 'K2')?.scope).toBe('model');
  });
});
