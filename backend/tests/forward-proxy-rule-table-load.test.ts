import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { resolveHost } from '../src/forward-proxy/rules.js';

/**
 * What the loader makes of the `forwardProxy` section (ADR-0018).
 *
 * The rule table has exactly ONE spelling — `{ match, ingress, egress }` — and
 * the loader has exactly one rule about it: an explicit `rules` array wins (even
 * empty), otherwise the shipped default applies. There is no translation and no
 * folding: a row or a section key this vocabulary does not know is reported and
 * dropped, never quietly reinterpreted, because guessing at a half-understood
 * row is how a `reject` silently becomes a `proxy`.
 */

function writeConfig(body: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-fp-rules-'));
  const file = path.join(dir, 'config.yaml');
  // v1 disk shape (ADR-0016): the forward-proxy section lives under `client`.
  const lines = ['schemaVersion: 1', 'client:', '  forwardProxy:', '    enabled: false'];
  for (const [k, v] of Object.entries(body)) lines.push(`    ${k}: ${JSON.stringify(v)}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('forward-proxy: loading the rule table', () => {
  it('an explicit table wins, including an EMPTY one', () => {
    const table = [
      { match: 'ads.example.com', ingress: 'reject', egress: 'direct' },
      { match: '*.pinned.example', ingress: 'passthrough', egress: 'proxy' },
      { match: '*', ingress: 'intercept', egress: 'proxy' },
    ];
    const cfg = loadConfig(writeConfig({ rules: table }));
    assert.deepEqual(cfg.forwardProxy?.rules, table);
    // The consequences the table exists for.
    const rules = cfg.forwardProxy!.rules!;
    assert.equal(resolveHost('ads.example.com', rules).action, 'reject');
    assert.equal(resolveHost('x.pinned.example', rules).tunnel, true);
    assert.equal(resolveHost('api.example.com', rules).action, 'proxy');

    const empty = loadConfig(writeConfig({ rules: [] }));
    assert.deepEqual(empty.forwardProxy?.rules, [], 'an empty table is a decision, not "absent"');
  });

  it('a section without `rules` gets the shipped default table', () => {
    const cfg = loadConfig(writeConfig({}));
    assert.deepEqual(cfg.forwardProxy?.rules, [{ match: '*', ingress: 'intercept', egress: 'proxy' }]);
  });

  it('a row without ingress/egress is an invalid slot — never translated', () => {
    const cfg = loadConfig(
      writeConfig({
        rules: [
          { match: 'a.example', action: 'proxy' },
          { match: '*', ingress: 'intercept', egress: 'direct' },
        ],
      })
    );
    // Position-preserving invalid slot: the row cannot match anything, and the
    // valid row after it keeps its place (so a lint index still addresses what
    // the operator typed).
    assert.deepEqual(cfg.forwardProxy?.rules, [
      { match: '', ingress: 'intercept', egress: 'direct' },
      { match: '*', ingress: 'intercept', egress: 'direct' },
    ]);
  });

  it('drops section keys the config type does not declare, and never re-persists them', () => {
    // A file from a pre-ADR-0018 install still carries these; they are gone from
    // the schema, so the loader removes them instead of carrying them into the
    // runtime object (where the next console save would write them back).
    const cfg = loadConfig(
      writeConfig({
        bypassHosts: ['a.example'],
        viaOutboundProxy: true,
        mitmHosts: ['b.example'],
      })
    );
    const fp = cfg.forwardProxy as unknown as Record<string, unknown>;
    assert.equal(fp.bypassHosts, undefined);
    assert.equal(fp.viaOutboundProxy, undefined);
    assert.equal(fp.mitmHosts, undefined);
    // …and the table is untouched by them: the default posture stands.
    assert.deepEqual(cfg.forwardProxy?.rules, [{ match: '*', ingress: 'intercept', egress: 'proxy' }]);
  });

  it('reads `requireCredential` strictly: absent/junk is off, true is on', () => {
    assert.equal(loadConfig(writeConfig({})).forwardProxy?.requireCredential, false);
    assert.equal(loadConfig(writeConfig({ requireCredential: true })).forwardProxy?.requireCredential, true);
    assert.equal(loadConfig(writeConfig({ requireCredential: 'yes' })).forwardProxy?.requireCredential, false);
  });
});
