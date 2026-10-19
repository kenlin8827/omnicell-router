import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { resetCredentialStateStoreForTests } from '../src/resilience/credential-state.js';
import { ErrorClassifier } from '../src/resilience/error-classifier.js';
import type { RouterConfig } from '../src/config/types.js';

/**
 * Manual-trip scope on the admin REST surface.
 *
 *   scope 'model'   (default, legacy body)  -> model trip, today's behavior
 *   scope 'credential' (keyHashPrefix)         -> every pair breaker of one credential
 *   scope 'pair'    (model + credential)       -> exactly one breaker
 * plus the explicit SUSPECT clear endpoint. Bad combos keep returning 400.
 *
 * The suspect store is sandboxed through OCR_HOME before the server is built
 * (the default store resolves lazily, never at import time), so the operator's
 * real ~/.onecast-router is never written.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pairs-rest-'));
const previousOcrHome = process.env.OCR_HOME;
process.env.OCR_HOME = path.join(sandbox, 'ocr-home');
// Owns its home → declares its book-set name (the runner's tripwire name
// `itest` exists only in the runner's own sandbox home).
process.env.OCR_ENV = 'default';
resetCredentialStateStoreForTests();

const config = {
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'plus-1',
  fallback: { enabled: true, maxRetries: 1, escalateTier: 'plus', injectErrorContext: true },
  circuitBreaker: { enabled: true, failureThreshold: 2 },
  models: [
    {
      id: 'plus-1',
      provider: 'mock',
      upstreamModel: 'plus-1',
      tier: 'plus',
      isDefaultInTier: true,
      pricing: { input: 3.0, cacheRead: 0.75, output: 12.0 },
    },
    {
      id: 'plus-2',
      provider: 'mock',
      upstreamModel: 'plus-2',
      tier: 'plus',
      pricing: { input: 1.0, cacheRead: 0.25, output: 4.0 },
    },
  ],
} as unknown as RouterConfig;

const { app, registry } = createServer(config, true);
const cb = () => registry.getCircuitBreakerManager();

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  if (previousOcrHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = previousOcrHome;
  resetCredentialStateStoreForTests();
});

const post = (url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload: payload ?? {} });

describe('POST /api/admin/health/circuit-breakers/trip — scopes', () => {
  it('legacy body {model} still trips the model breaker (backward compatible)', async () => {
    cb().reset();
    const res = await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-1', cooldownMs: 60000 });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('ok');
    expect(json.model).toBe('plus-1');
    expect(json.tripped).toBe(true);
    expect(json.scope).toBe('model');
    expect(cb().getBreaker('plus-1')?.getState()).toBe('OPEN');
    expect(cb().snapshotsWithPairs().filter((s) => s.keyHashPrefix)).toEqual([]); // no pair breakers invented
  });

  it('rejects a body with no model (unchanged 400 contract)', async () => {
    const res = await post('/api/admin/health/circuit-breakers/trip', { reason: 'oops' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Model id is required');
  });

  it("scope 'pair' trips one (model, credential) breaker and leaves its siblings", async () => {
    cb().reset();
    const res = await post('/api/admin/health/circuit-breakers/trip', {
      scope: 'pair',
      model: 'plus-1',
      credential: 'k1prefix0000',
      cooldownMs: 60000,
      reason: 'canary',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().affected).toBe(1);

    expect(cb().getPairBreaker('plus-1', 'k1prefix0000')?.getState()).toBe('OPEN');
    expect(cb().getPairBreaker('plus-2', 'k1prefix0000')).toBeUndefined(); // other model untouched
    expect(cb().getBreaker('plus-1')?.getState()).toBe('CLOSED'); // and NOT the model breaker
    expect(cb().modelAvailability('plus-1', ['k1prefix0000', 'k2prefix0000'])).toEqual({
      available: true,
      openPrefixes: ['k1prefix0000'],
    });
  });

  it("scope 'credential' trips every pair breaker of the credential without marking SUSPECT", async () => {
    cb().reset();
    await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', model: 'plus-1', credential: 'kA' });
    const res = await post('/api/admin/health/circuit-breakers/trip', {
      scope: 'credential',
      credential: 'kA',
      cooldownMs: 30000,
      reason: 'billing freeze',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.affected).toBeGreaterThanOrEqual(1);
    expect(json.credential).toBe('kA');
    expect(cb().getPairBreaker('plus-1', 'kA')?.getState()).toBe('OPEN');
    // provider 'mock' owns both registered models -> the credential scope covers them both
    expect(cb().getPairBreaker('plus-2', 'kA')?.getState()).toBe('OPEN');
    expect(cb().getCredentialStateStore().list()).toEqual([]); // manual != administrative
  });

  it('keeps a cooldown floor and ceiling via the shared manual trip rule', async () => {
    cb().reset();
    const tiny = await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-1', cooldownMs: 1 });
    expect(tiny.statusCode).toBe(200);
    expect(cb().getSnapshot('plus-1')?.remainingCooldownMs).toBeGreaterThan(0);
  });

  it('400s the unknown combos', async () => {
    // Old wire words from the matrix vocabulary ('row') must fail LOUD, never
    // silently map to a scope.
    const badScope = await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-1', scope: 'row' });
    expect(badScope.statusCode).toBe(400);
    expect(badScope.json().message).toContain("Unknown scope 'row'");

    const credentialWithoutPrefix = await post('/api/admin/health/circuit-breakers/trip', { scope: 'credential' });
    expect(credentialWithoutPrefix.statusCode).toBe(400);
    expect(credentialWithoutPrefix.json().message).toContain('requires an credential');

    const pairWithoutCredential = await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', model: 'plus-1' });
    expect(pairWithoutCredential.statusCode).toBe(400);

    const pairWithoutModel = await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', credential: 'kA' });
    expect(pairWithoutModel.statusCode).toBe(400);
  });
});

describe('POST /api/admin/health/circuit-breakers/reset — scopes', () => {
  it('scope pair / credential reset their breakers, leaving the model path alone', async () => {
    cb().reset();
    await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', model: 'plus-1', credential: 'kA' });
    await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', model: 'plus-1', credential: 'kB' });

    const one = await post('/api/admin/health/circuit-breakers/reset', { scope: 'pair', model: 'plus-1', credential: 'kA' });
    expect(one.statusCode).toBe(200);
    expect(one.json().resetCount).toBe(1);
    expect(cb().getPairBreaker('plus-1', 'kA')?.getState()).toBe('CLOSED');
    expect(cb().getPairBreaker('plus-1', 'kB')?.getState()).toBe('OPEN');

    const credentialReset = await post('/api/admin/health/circuit-breakers/reset', { scope: 'credential', credential: 'kB' });
    expect(credentialReset.statusCode).toBe(200);
    expect(credentialReset.json().resetCount).toBe(1);
    expect(cb().getPairBreaker('plus-1', 'kB')?.getState()).toBe('CLOSED');
  });

  it("scope credential never lifts SUSPECT — that needs the explicit clear endpoint", async () => {
    cb().reset();
    const auth = ErrorClassifier.classify(
      Object.assign(new Error('invalid_api_key'), { status: 401, usedCredentialKeyHashPrefix: 'kS' }),
      'plus-1',
      'mock'
    );
    cb().recordFailureScoped('plus-1', auth, 'mock', 'kS');
    expect(cb().getCredentialStateStore().isSuspect('mock', 'kS')).toBe(true);

    const reset = await post('/api/admin/health/circuit-breakers/reset', { scope: 'credential', credential: 'kS' });
    expect(reset.statusCode).toBe(200);
    expect(cb().getCredentialStateStore().isSuspect('mock', 'kS')).toBe(true);
    expect(cb().modelAvailability('plus-1', ['kS']).available).toBe(false); // still out of service
  });

  it('legacy ?model= query still resets the model breaker, and no target resets everything', async () => {
    cb().reset();
    await post('/api/admin/health/circuit-breakers/trip', { scope: 'pair', model: 'plus-1', credential: 'kZ', cooldownMs: 600000 });
    await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-1', cooldownMs: 60000 });

    const res = await post('/api/admin/health/circuit-breakers/reset?model=plus-1');
    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe('model');
    expect(res.json().resetCount).toBeGreaterThanOrEqual(2); // model breaker + its pair
    expect(cb().getBreaker('plus-1')?.getState()).toBe('CLOSED');
    expect(cb().getPairBreaker('plus-1', 'kZ')?.getState()).toBe('CLOSED'); // model reset clears its pairs

    await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-1', cooldownMs: 60000 });
    await post('/api/admin/health/circuit-breakers/trip', { model: 'plus-2', cooldownMs: 60000 });
    const all = await post('/api/admin/health/circuit-breakers/reset');
    expect(all.json().resetCount).toBeGreaterThanOrEqual(2); // every model and pair breaker
    expect(cb().getBreaker('plus-1')?.getState()).toBe('CLOSED');
    expect(cb().getBreaker('plus-2')?.getState()).toBe('CLOSED');
  });

  it('400s an unknown scope and a scope that needs an credential without one', async () => {
    // 'column' is not in the manual vocabulary (model / credential / pair) — rejected, not mapped.
    expect((await post('/api/admin/health/circuit-breakers/reset', { scope: 'column' })).statusCode).toBe(400);
    expect((await post('/api/admin/health/circuit-breakers/reset', { scope: 'pair', model: 'plus-1' })).statusCode).toBe(400);
  });
});

describe('POST /api/admin/health/suspect-credentials/clear', () => {
  it('requires both halves of the composite key, clears, and is idempotent', async () => {
    cb().reset();
    const auth = ErrorClassifier.classify(
      Object.assign(new Error('unauthorized'), { status: 401, usedCredentialKeyHashPrefix: 'kC' }),
      'plus-1',
      'mock'
    );
    cb().recordFailureScoped('plus-1', auth, 'mock', 'kC');
    expect(cb().getCredentialStateStore().isSuspect('mock', 'kC')).toBe(true);

    expect((await post('/api/admin/health/suspect-credentials/clear', { credential: 'kC' })).statusCode).toBe(400);
    expect((await post('/api/admin/health/suspect-credentials/clear', { provider: 'mock' })).statusCode).toBe(400);

    const cleared = await post('/api/admin/health/suspect-credentials/clear', { provider: 'mock', credential: 'kC' });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ status: 'ok', provider: 'mock', credential: 'kC', cleared: true });
    expect(cb().isSuspect('plus-1', 'kC')).toBe(false);
    // Clearing the ADMINISTRATIVE flag does not un-trip the the pair breakers the credential
    // expansion left open — the two gates are independent by design.
    expect(cb().modelAvailability('plus-1', ['kC'])).toEqual({ available: false, openPrefixes: ['kC'] });
    await post('/api/admin/health/circuit-breakers/reset', { scope: 'credential', credential: 'kC' });
    expect(cb().modelAvailability('plus-1', ['kC'])).toEqual({ available: true, openPrefixes: [] });

    const again = await post('/api/admin/health/suspect-credentials/clear', { provider: 'mock', credential: 'kC' });
    expect(again.json().cleared).toBe(false);

    // and the file landed in the sandboxed state root, display-safe only
    const file = path.join(process.env.OCR_HOME!, 'suspect-credentials.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/kC/);
  });
});
