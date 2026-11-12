import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorClassifier,
  UpstreamError,
  CLASSIFIER_TAXONOMY,
  ERROR_CATEGORIES,
  resolveBreakerRules,
} from '../src/resilience/index.js';
import type { ClassifierTaxonomyEntry, ErrorDiagnosis } from '../src/resilience/index.js';

/**
 * Anti-drift guard for the console's read-only classifier-reference panel.
 * CLASSIFIER_TAXONOMY is a hand-maintained SUMMARY of classify() behavior — the
 * single source the /admin/breaker-rules panel renders. These tests pin every
 * behavioral field (defaultScope / disposition / countingToggle / governedBy /
 * variants) to the REAL classify() output, so a classifier edit that forgets the
 * descriptor (or vice-versa) fails here instead of silently lying to operators.
 */

const MODEL = 'p/x';
const PROVIDER = 'p';

/** Stamp the credential attribution registry.execute would have stamped. */
const attributed = (err: any): any => {
  err.usedCredentialKeyHashPrefix = 'k1';
  return err;
};
const classifyA = (err: any): ErrorDiagnosis => ErrorClassifier.classify(attributed(err), MODEL, PROVIDER);
const classifyChainless = (err: any): ErrorDiagnosis => ErrorClassifier.classify(err, MODEL, PROVIDER);

const statusErr = (status: number, message = `upstream ${status}`): UpstreamError =>
  new UpstreamError({ message, status, provider: PROVIDER, modelId: MODEL });

const byCategory = (category: string): ClassifierTaxonomyEntry => {
  const e = CLASSIFIER_TAXONOMY.find((x) => x.category === category);
  assert.ok(e, `descriptor must carry an entry for ${category}`);
  return e;
};

/** Map a diagnosis to the descriptor's disposition vocabulary. */
const dispositionOf = (d: ErrorDiagnosis): 'hard_trip' | 'counted' | 'ignored' =>
  !d.shouldTripBreaker ? 'ignored' : d.hardTrip ? 'hard_trip' : 'counted';

describe('CLASSIFIER_TAXONOMY: coverage and rule-tree consistency', () => {
  it('covers exactly the six auto-detected categories (MANUAL is operator intent, not a class)', () => {
    const auto = ERROR_CATEGORIES.filter((c) => c !== 'MANUAL');
    // Coverage is a set: the descriptor lists classes in EVALUATION precedence
    // (request-fault 4xx before 5xx/network), which is intentionally not the
    // ERROR_CATEGORIES vocabulary order. The per-category tests below pin the
    // precedence behaviorally (415 -> CLIENT_ERROR, never SERVICE_UNAVAILABLE).
    assert.deepEqual([...CLASSIFIER_TAXONOMY.map((e) => e.category)].sort(), [...auto].sort());
    assert.equal(new Set(CLASSIFIER_TAXONOMY.map((e) => e.category)).size, CLASSIFIER_TAXONOMY.length);
  });

  it('countingToggle matches the governing family, and every governedBy is a real resolved rule path', () => {
    const rules = resolveBreakerRules();
    const resolveKey = (key: string): unknown =>
      key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), rules);
    for (const e of CLASSIFIER_TAXONOMY) {
      assert.equal(
        e.countingToggle,
        e.governedBy.startsWith('counting.'),
        `${e.category}: a counting family owns the toggle, a trip family does not`
      );
      assert.ok(resolveKey(e.governedBy), `${e.category}: governedBy '${e.governedBy}' must resolve in the rule tree`);
    }
    // The three counting families really expose an enabled toggle; 429 does not.
    assert.equal(typeof rules.counting.serverErrors.enabled, 'boolean');
    assert.equal(typeof rules.counting.unknownErrors.enabled, 'boolean');
    assert.equal(typeof rules.counting.clientErrors.enabled, 'boolean');
    assert.equal('enabled' in rules.counting.rateLimitErrors, false);
  });
});

describe('CLASSIFIER_TAXONOMY: each entry pinned to classify() behavior', () => {
  it('QUOTA_EXHAUSTED — 402 hard-trips the credential, never SUSPECT', () => {
    const e = byCategory('QUOTA_EXHAUSTED');
    const d = classifyA(statusErr(402, 'insufficient_quota'));
    assert.equal(d.category, e.category);
    assert.equal(d.tripScope, e.defaultScope);
    assert.equal(dispositionOf(d), e.disposition);
    assert.equal(e.disposition, 'hard_trip');
    assert.notEqual(d.credentialSuspect, true);
    assert.equal(e.marksSuspect, undefined);
    // Chain-less: no attribution -> no tripScope (model-sentinel degeneracy).
    assert.equal(classifyChainless(statusErr(402, 'insufficient_quota')).tripScope, undefined);
  });

  it('AUTHENTICATION_ERROR — 401 hard-trips the credential and marks SUSPECT', () => {
    const e = byCategory('AUTHENTICATION_ERROR');
    const d = classifyA(statusErr(401, 'invalid_api_key'));
    assert.equal(d.category, e.category);
    assert.equal(d.tripScope, e.defaultScope);
    assert.equal(dispositionOf(d), e.disposition);
    assert.equal(e.disposition, 'hard_trip');
    assert.equal(d.credentialSuspect, true);
    assert.equal(e.marksSuspect, true);
  });

  it('RATE_LIMITED — base 429 counts the pair; long Retry-After hard-trips; budget wording widens to credential', () => {
    const e = byCategory('RATE_LIMITED');
    assert.equal(e.disposition, 'counted');
    assert.equal(e.conditionalHardTrip, true);
    assert.equal(e.credentialScope, 'credential');

    // No Retry-After: counted, pair-scoped (the base disposition).
    const base = classifyA(statusErr(429, 'rate_limit exceeded'));
    assert.equal(base.category, e.category);
    assert.equal(base.tripScope, e.defaultScope);
    assert.equal(dispositionOf(base), 'counted');
    assert.equal(base.shouldTripBreaker, true); // 429 countedness has no toggle

    // Long Retry-After (10s > the 2s in-place boundary): hard-trip, still pair.
    const long = classifyA(Object.assign(statusErr(429, 'rate_limit'), { retryAfterSeconds: 10 }));
    assert.equal(long.hardTrip, true);
    assert.equal(long.tripScope, e.defaultScope);

    // Credential-budget wording widens the radius to the credential.
    const budget = classifyA(statusErr(429, 'daily limit reached for this key'));
    assert.equal(budget.tripScope, e.credentialScope);
  });

  it('CLIENT_ERROR — request-fault 4xx never trips and carries no scope (the 415 false-kill guard)', () => {
    const e = byCategory('CLIENT_ERROR');
    assert.equal(e.disposition, 'ignored');
    // The only taxonomy entry that does NOT stamp a tripScope: an ignored class
    // never reaches the manager's fan-out, so `defaultScope` here is the
    // `effectiveScope` fallback (`tripScope ?? 'model'`) — pinned literally so
    // the console's radius pill cannot drift from the manager's degeneracy.
    assert.equal(e.defaultScope, 'model');
    for (const status of [400, 413, 415, 422]) {
      const d = classifyA(statusErr(status));
      assert.equal(d.category, e.category, `HTTP ${status} must be CLIENT_ERROR`);
      assert.equal(d.shouldTripBreaker, false);
      assert.equal(d.hardTrip, false);
      assert.equal(dispositionOf(d), 'ignored');
      assert.equal(d.tripScope, undefined);
    }
  });

  it('SERVICE_UNAVAILABLE — endpoint evidence is model-scoped; host-level connection failure widens to provider', () => {
    const e = byCategory('SERVICE_UNAVAILABLE');
    assert.equal(e.disposition, 'counted');
    assert.equal(e.hostScope, 'provider');

    // Endpoint evidence (5xx / timeout / reset): model, counted, never hard.
    for (const err of [statusErr(503), statusErr(500), new Error('ETIMEDOUT'), new Error('ECONNRESET socket hang up')]) {
      const d = classifyA(err);
      assert.equal(d.category, e.category);
      assert.equal(d.tripScope, e.defaultScope);
      assert.equal(dispositionOf(d), 'counted');
      assert.equal(d.hardTrip, false);
    }

    // Host-level connection failure: provider, statistical only, travels WITHOUT attribution.
    for (const msg of ['fetch failed (ENOTFOUND)', 'EAI_AGAIN', 'connect ECONNREFUSED', 'self-signed certificate']) {
      const d = classifyA(new Error(msg));
      assert.equal(d.category, e.category);
      assert.equal(d.tripScope, e.hostScope);
      assert.equal(d.hardTrip, false);
      assert.equal(classifyChainless(new Error(msg)).tripScope, e.hostScope, 'host-level provider scope is attribution-independent');
    }
  });

  it('UNKNOWN — 403/404/410 and unclassified errors count the pair, never widen', () => {
    const e = byCategory('UNKNOWN');
    assert.equal(e.disposition, 'counted');
    for (const err of [statusErr(403), statusErr(404), statusErr(410), new Error('something unclassifiable')]) {
      const d = classifyA(err);
      assert.equal(d.category, e.category);
      assert.equal(d.tripScope, e.defaultScope);
      assert.equal(dispositionOf(d), 'counted');
      assert.equal(d.hardTrip, false);
    }
  });
});