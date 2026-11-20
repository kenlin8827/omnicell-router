import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WarnThrottle } from '../../src/observability/warn-throttle.js';

/**
 * Build a throttle with a controllable time source and a captured sink.
 * Default window = 1000ms, cap = 5 — easy to drive from the test.
 */
function makeThrottle(opts: { windowMs?: number; maxPerWindow?: number; now?: number } = {}) {
  const nowVal = { t: opts.now ?? 0 };
  const lines: string[] = [];
  const t = new WarnThrottle({
    windowMs: opts.windowMs ?? 1000,
    maxPerWindow: opts.maxPerWindow ?? 5,
    now: () => nowVal.t,
    sink: (line) => lines.push(line),
  });
  return { t, lines, advance: (ms: number) => { nowVal.t += ms; } };
}

describe('WarnThrottle — dedup', () => {
  it('first call to a key emits the line', () => {
    const { t, lines } = makeThrottle();
    t.warn('k1', 'first');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0], 'first');
  });

  it('repeated calls with the SAME key do NOT emit, but bump the repeat counter', () => {
    const { t, lines } = makeThrottle();
    t.warn('k1', 'first');
    t.warn('k1', 'second');
    t.warn('k1', 'third');
    assert.strictEqual(lines.length, 1, 'only the first call prints');
    assert.strictEqual(t.repeatCount('k1'), 3, 'repeat counter is the number of calls');
  });

  it('different keys emit independently', () => {
    const { t, lines } = makeThrottle();
    t.warn('a', 'line a');
    t.warn('b', 'line b');
    t.warn('a', 'a-again');
    t.warn('b', 'b-again');
    assert.deepStrictEqual(lines, ['line a', 'line b']);
  });

  it('dedup is process-lifetime: same key after window roll still does NOT emit', () => {
    // Industry-standard behavior: a persistent misconfig should not flood
    // logs forever. The dedup map survives across windows. The repeat
    // counter (repeatCount) is the operator's signal that the condition
    // is still occurring. Window roll only resets the rate cap.
    const { t, lines, advance } = makeThrottle();
    t.warn('k', 'first');
    advance(2000); // roll past window
    t.warn('k', 'after-roll');
    assert.strictEqual(lines.length, 1, 'dedup is per-process, not per-window');
    assert.strictEqual(t.repeatCount('k'), 2);
  });
});

describe('WarnThrottle — rate limit per window', () => {
  it('suppresses after maxPerWindow, regardless of key', () => {
    const { t, lines } = makeThrottle({ maxPerWindow: 3 });
    t.warn('a', 'A');
    t.warn('b', 'B');
    t.warn('c', 'C');
    t.warn('d', 'D');
    t.warn('e', 'E');
    assert.strictEqual(lines.length, 3);
  });

  it('window roll unblocks the cap', () => {
    const { t, lines, advance } = makeThrottle({ windowMs: 1000, maxPerWindow: 2 });
    t.warn('a', 'A'); // emit
    t.warn('b', 'B'); // emit
    t.warn('c', 'C'); // suppressed
    assert.strictEqual(lines.length, 2);
    advance(1500); // roll window
    t.warn('d', 'D'); // emit again
    assert.strictEqual(lines.length, 3);
  });

  it('flushSuppressed reports the suppressed count without exceeding the cap', () => {
    const { t, lines } = makeThrottle({ maxPerWindow: 2 });
    t.warn('a', 'A'); // emit (1)
    t.warn('b', 'B'); // emit (2)
    t.warn('c', 'C'); // suppressed
    t.warn('d', 'D'); // suppressed
    assert.strictEqual(lines.length, 2);
    t.flushSuppressed();
    // The summary line itself is one warn → counted as the 3rd line.
    assert.strictEqual(lines.length, 3);
    assert.match(lines[2], /suppressed 2 similar warn lines/);
    // Calling again with no new suppression prints nothing.
    t.flushSuppressed();
    assert.strictEqual(lines.length, 3);
  });
});

describe('WarnThrottle — singleton helpers', () => {
  it('reset() clears all state', async () => {
    const { WarnThrottle } = await import('../../src/observability/warn-throttle.js');
    const t = new WarnThrottle({ sink: () => {} });
    t.warn('k', 'first');
    assert.strictEqual(t.keyCount(), 1);
    t.reset();
    assert.strictEqual(t.keyCount(), 0);
  });

  it('summary() emits one line per deduped key with repeat count + age', () => {
    const { t, lines, advance } = makeThrottle();
    t.warn('downgrade|claude|xhigh->high', 'm1');
    t.warn('downgrade|claude|xhigh->high', 'dup');
    t.warn('downgrade|claude|xhigh->high', 'dup2');
    t.warn('no-cap|gpt|openai', 'm2');
    advance(5000);
    t.summary();
    // m1 line prints the original "m1" message; m2 prints "m2". Summary
    // adds two recurring lines.
    assert.strictEqual(lines.length, 4);
    assert.match(lines[2], /recurring warn key='downgrade\|claude\|xhigh->high' repeats=3 since 5s ago/);
    assert.match(lines[3], /recurring warn key='no-cap\|gpt\|openai' repeats=1 since 5s ago/);
  });

  it('summary() is a no-op when nothing has been deduped', () => {
    const { t, lines } = makeThrottle();
    t.summary();
    assert.strictEqual(lines.length, 0);
  });
});

describe('WarnThrottle — interaction with orchestrator warn keys', () => {
  // The orchestrator composes keys as
  //   `no-capability|<modelId>|<wire>` and `downgrade|<modelId>|<req>-><actual>`.
  // Verify these key shapes are correctly separated by the throttle.
  it('"downgrade" key for two different (req,actual) pairs emits two lines', () => {
    const { t, lines } = makeThrottle();
    t.warn('downgrade|claude-x|xhigh->high', 'first');
    t.warn('downgrade|claude-x|xhigh->high', 'dup');
    t.warn('downgrade|claude-x|xhigh->medium', 'second');
    t.warn('downgrade|claude-x|xhigh->medium', 'dup');
    t.warn('no-capability|claude-x|anthropic', 'third');
    assert.strictEqual(lines.length, 3);
  });
});