import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { responsesSurface, __resetResponsesSurfaceForTests } from '../src/surfaces/responses.js';

/**
 * The persist=off nudge (ADR-0015 amendment): the first request that proves a
 * live client relies on gateway-held state (previous_response_id) while the
 * recovery log is off must produce exactly ONE warn per process pointing at
 * the switch — and the 400 fail-visible contract must stay untouched.
 */
describe('responses surface: persist=off nudge', () => {
  it('warns once per process on previous_response_id use, then still 400s', () => {
    __resetResponsesSurfaceForTests();
    const origWarn = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const body = { model: 'auto', input: 'hi', previous_response_id: 'resp_nonexistent' };
      const r1 = responsesSurface.parse(body);
      const r2 = responsesSurface.parse(body);

      // Fail-visible contract preserved (frozen step-3b text).
      assert.ok(r1.error && r1.error.startsWith('Unknown previous_response_id "resp_nonexistent"'));
      assert.ok(r2.error && r2.error.startsWith('Unknown previous_response_id "resp_nonexistent"'));

      // Nudge: fired, names the switch, deduped to one line across both parses.
      const nudges = lines.filter((l) => l.includes('responses.persist'));
      assert.strictEqual(nudges.length, 1);
      assert.ok(nudges[0].includes('previous_response_id in use'));
    } finally {
      console.warn = origWarn;
      __resetResponsesSurfaceForTests();
    }
  });
});
