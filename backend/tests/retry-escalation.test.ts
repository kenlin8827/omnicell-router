import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import {
  detectRetry,
  planEscalation,
  nextEffort,
  nextTier,
  RETRY_MIN_PROMPT_CHARS,
  type SessionRetryState,
} from '../src/router/retry-escalation.js';

/**
 * Retry detection + escalation planning (ADR-0011) — the pure core of the
 * repeated-prompt ladder, no store, no network.
 */

describe('detectRetry — the three conditions', () => {
  const okState = (hash: string, retryCount = 0): SessionRetryState => ({
    lastPromptHash: hash,
    lastOutcomeOk: true,
    lastTierUsed: 'plus',
    retryCount,
  });

  it('fires only when the previous turn completed, succeeded and hashed the same', () => {
    assert.deepEqual(detectRetry(okState('aaa'), 'aaa'), { isRetry: true, attempt: 1 });
    // different prompt → fresh question
    assert.deepEqual(detectRetry(okState('aaa'), 'bbb'), { isRetry: false, attempt: 0 });
    // previous turn FAILED (technical resend never counts)
    assert.deepEqual(
      detectRetry({ ...okState('aaa'), lastOutcomeOk: false }, 'aaa'),
      { isRetry: false, attempt: 0 }
    );
    // no previous state (first turn / pre-feature sessions)
    assert.deepEqual(detectRetry(undefined, 'aaa'), { isRetry: false, attempt: 0 });
    // no current hash (no user message)
    assert.deepEqual(detectRetry(okState('aaa'), undefined), { isRetry: false, attempt: 0 });
  });

  it('counts consecutive repeats', () => {
    assert.deepEqual(detectRetry(okState('aaa', 1), 'aaa'), { isRetry: true, attempt: 2 });
    assert.deepEqual(detectRetry(okState('aaa', 2), 'aaa'), { isRetry: true, attempt: 3 });
  });

  it('exposes the 20-char floor for the caller to gate on', () => {
    assert.equal(RETRY_MIN_PROMPT_CHARS, 20);
  });
});

describe('planEscalation — the ladder', () => {
  it('attempt 1 raises effort on the same tier', () => {
    const plan = planEscalation({ attempt: 1, lastTierUsed: 'plus', lastEffortUsed: 'medium' });
    assert.equal(plan.action, 'effort');
    assert.equal(plan.effort, 'high');
    assert.equal(plan.reasonCode, 'retry.effort');
  });

  it('attempt 1 with no prior effort starts from none', () => {
    const plan = planEscalation({ attempt: 1, lastTierUsed: 'plus' });
    assert.equal(plan.action, 'effort');
    assert.equal(plan.effort, 'low');
  });

  it('A3: a pinned model that cannot serve the next effort jumps straight to tier+1', () => {
    const plan = planEscalation({
      attempt: 1,
      lastTierUsed: 'plus',
      lastEffortUsed: 'medium',
      pinnedSupportedEfforts: ['none', 'low', 'medium'], // 'high' unsupported
    });
    assert.equal(plan.action, 'tier');
    assert.equal(plan.tier, 'pro');
    assert.equal(plan.reasonParams.cause, 'effort_ceiling');
  });

  it('A3: a pin with NO thinking support jumps to tier+1 even from none', () => {
    const plan = planEscalation({
      attempt: 1,
      lastTierUsed: 'plus',
      lastEffortUsed: 'none',
      pinnedSupportedEfforts: [],
    });
    assert.equal(plan.action, 'tier');
    assert.equal(plan.tier, 'pro');
  });

  it('attempt 2 escalates the tier and drops the effort step', () => {
    const plan = planEscalation({ attempt: 2, lastTierUsed: 'plus', lastEffortUsed: 'high' });
    assert.equal(plan.action, 'tier');
    assert.equal(plan.tier, 'pro');
    assert.equal(plan.effort, undefined);
  });

  it('the ultra ceiling returns none — no infinite ladder', () => {
    assert.deepEqual(planEscalation({ attempt: 1, lastTierUsed: 'ultra', lastEffortUsed: 'max' }).action, 'none');
    assert.deepEqual(planEscalation({ attempt: 9, lastTierUsed: 'ultra' }).action, 'none');
  });

  it('nextEffort / nextTier helpers', () => {
    assert.equal(nextEffort('none'), 'low');
    assert.equal(nextEffort('max'), undefined);
    assert.equal(nextTier('lite'), 'plus');
    assert.equal(nextTier('ultra'), undefined);
  });
});
