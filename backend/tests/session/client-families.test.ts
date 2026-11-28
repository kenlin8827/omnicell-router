import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientFamilyOf,
  clientFamiliesOf,
  UNKNOWN_CLIENT_FAMILY_ID,
} from '../../src/utils/client-families.js';

// The family id is the machine key the /admin/sessions `?client=` selector and
// `?q=` match; the label is only a display fallback. `pi` must stay ANCHORED:
// an unanchored `/pi/i` would classify every `Anthropic/...` UA as `pi`.

describe('clientFamilyOf (console client filter — client fingerprint)', () => {
  const cases: [string, string, string][] = [
    // pi agent — detailed and short forms.
    ['pi/1.2.3 (win32; node/v26.3.0; x64)', 'pi', 'pi'],
    ['pi', 'pi', 'pi'],
    // The console playground identifies itself instead of borrowing the
    // webview's UA (which lands in the `unknown` family as `Mozilla/5.0`).
    ['OmniCellRouter-Playground/0.1.2', 'playground', 'Playground'],
    ['omnicellrouter-playground/1.0', 'playground', 'Playground'],
    // The anchored-pi bug this test exists for.
    ['Anthropic/1.0 (Python 3.12)', 'anthropic-sdk', 'Anthropic SDK'],
    ['anthropic-sdk-typescript/0.30.1', 'anthropic-sdk', 'Anthropic SDK'],
    ['opencode/0.4.2', 'opencode', 'OpenCode'],
    ['claude-cli/1.0.0 (external, cli)', 'claude-code', 'Claude Code'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0', UNKNOWN_CLIENT_FAMILY_ID, 'Mozilla/5.0'],
  ];
  for (const [ua, id, label] of cases) {
    it(`${JSON.stringify(ua)} → ${id}`, () => {
      const family = clientFamilyOf(ua);
      assert.equal(family.id, id);
      assert.equal(family.label, label);
    });
  }

  it('unknown UA keeps a capped leading token, never invents a client', () => {
    const long = 'X'.repeat(60) + ' something';
    const family = clientFamilyOf(long);
    assert.equal(family.id, UNKNOWN_CLIENT_FAMILY_ID);
    assert.equal(family.label, 'X'.repeat(32) + '…');
  });
});

describe('clientFamiliesOf (per-session distinct families)', () => {
  it('dedupes by id in write order', () => {
    const list = clientFamiliesOf([
      { userAgent: 'opencode/0.4.2' },
      { userAgent: 'opencode/0.5.0' },
      { userAgent: 'pi/1.2.3 (linux; node/v22; x64)' },
      { userAgent: 'Anthropic/1.0' },
    ]);
    assert.deepEqual(
      list.map(f => f.id),
      ['opencode', 'pi', 'anthropic-sdk']
    );
  });

  it('empty / blank fingerprints produce no families', () => {
    assert.deepEqual(clientFamiliesOf([]), []);
    assert.deepEqual(clientFamiliesOf([{}]), []);
    assert.deepEqual(clientFamiliesOf([{ userAgent: '' }]), []);
    assert.deepEqual(clientFamiliesOf([{ hint: '  ' }]), []);
  });

  it('keeps every contributing fingerprint per family, in write order', () => {
    const list = clientFamiliesOf([
      { userAgent: 'opencode/0.4.2' },
      { userAgent: 'opencode/0.5.0' },
      { userAgent: 'pi/1.2.3 (linux; node/v22; x64)' },
    ]);
    assert.deepEqual(list.map(f => f.id), ['opencode', 'pi']);
    assert.deepEqual(list[0].fingerprints, ['opencode/0.4.2', 'opencode/0.5.0']);
    assert.deepEqual(list[1].fingerprints, ['pi/1.2.3 (linux; node/v22; x64)']);
  });

  // The reason the hint channel exists: a browser webview silently drops a
  // script-set `User-Agent` on fetch and sends its own, so the UA alone would
  // classify playground traffic as `unknown` / `Mozilla/5.0`. The custom
  // `x-ocr-client` header survives and must WIN over the browser UA.
  it('a self-declared hint wins over the browser User-Agent', () => {
    const list = clientFamiliesOf([
      {
        hint: 'OmniCellRouter-Playground/0.8.5',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
      },
    ]);
    assert.deepEqual(list.map(f => f.id), ['playground']);
    assert.deepEqual(list[0].fingerprints, ['OmniCellRouter-Playground/0.8.5']);
  });

  it('an unrecognized hint falls back to the User-Agent', () => {
    const list = clientFamiliesOf([{ hint: 'my-homegrown-tool/1.0', userAgent: 'opencode/0.4.2' }]);
    assert.deepEqual(list.map(f => f.id), ['opencode']);
    assert.deepEqual(list[0].fingerprints, ['opencode/0.4.2']);
  });

  it('an unrecognized hint with no UA still classifies (unknown family)', () => {
    const list = clientFamiliesOf([{ hint: 'my-homegrown-tool/1.0' }]);
    assert.deepEqual(list.map(f => f.id), [UNKNOWN_CLIENT_FAMILY_ID]);
    assert.deepEqual(list[0].fingerprints, ['my-homegrown-tool/1.0']);
  });
});
