import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { currentLaunchVerb, findLaunchVerb } from '../../src/cli/clients/index.js';

/**
 * Retired launch-verb spellings (`ocr agy`) are RESOLVED, never dispatched:
 * `currentLaunchVerb` answers a retired word with its current name (so the CLI
 * can refuse it and name the replacement), while `findLaunchVerb` — the table
 * `ocr <verb>` dispatches from — must keep answering nothing for it.
 *
 * The verb table is package-declared, so these assertions run against whatever
 * packages the sandbox has loaded; the antigravity case is skipped when its
 * package is absent (a fresh checkout ships no plugins).
 */
describe('launch verb aliases', () => {
  it('resolve a retired spelling to its current name', () => {
    const withAlias = findLaunchVerb('antigravity-cli');
    if (!withAlias) return; // package not installed in this sandbox
    assert.deepEqual(withAlias.aliases, ['agy']);
    assert.equal(currentLaunchVerb('agy'), 'antigravity-cli');
    assert.equal(currentLaunchVerb('AGY'), 'antigravity-cli', 'the CLI lowercases the action');
    assert.equal(findLaunchVerb('agy'), undefined, 'a retired spelling is never dispatched');
  });

  it('leave unknown words unresolved', () => {
    assert.equal(currentLaunchVerb('no-such-verb-9381'), undefined);
    assert.equal(currentLaunchVerb(''), undefined);
  });
});
