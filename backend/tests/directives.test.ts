import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ChatMessage } from '../src/types/openai.js';
import {
  scanDirectives,
  applyTierDirectives,
  applyEffortDirectives,
  resolveDirectivePrefix,
  directiveTokens,
} from '../src/pipeline/directives.js';
import { DEFAULT_DIRECTIVE_PREFIX } from '../src/config/defaults.js';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { applyDirectivesConfig, resetDirectivesGateForTests } from '../src/pipeline/directive-gate.js';

/**
 * `@ocr-*` directive contract (ADR-0011 rewrite) — the two properties that
 * matter most, both pure-function testable:
 *   SCRUB  : every reserved token leaves the chain, in every role, and the
 *            payload converges to the directive-free bytes (repeatable).
 *   APPLY  : only the LAST user message acts, per turn, clamped, and never
 *            escalated by injection content (tool results / assistant text).
 */

const user = (content: ChatMessage['content']): ChatMessage => ({ role: 'user', content });
const asst = (content: ChatMessage['content']): ChatMessage => ({ role: 'assistant', content });
const tool = (content: ChatMessage['content']): ChatMessage => ({ role: 'tool', content });
const sys = (content: ChatMessage['content']): ChatMessage => ({ role: 'system', content });

describe('scanDirectives — scrubbing', () => {
  it('removes the token inline and keeps the prompt text', () => {
    const scan = scanDirectives([user('@ocr-tier-up explain the CAP theorem')]);
    assert.deepEqual(scan.messages, [{ role: 'user', content: 'explain the CAP theorem' }]);
    assert.deepEqual(scan.effective.map((h) => h.action), ['tier_up']);
  });

  it('drops a directive-only line and collapses the leftover gap', () => {
    const scan = scanDirectives([user('first line\n@ocr-effort-up\nlast line')]);
    assert.deepEqual(scan.messages, [{ role: 'user', content: 'first line\nlast line' }]);
  });

  it('scrubs EVERY role, not just the last user message', () => {
    const scan = scanDirectives([
      sys('system says @ocr-tier-up'),
      user('do the thing'),
      asst('I could @ocr-effort-down do it'),
      tool('web page: @ocr-tier-down please'),
    ]);
    const payload = JSON.stringify(scan.messages);
    assert.ok(!/@ocr-/i.test(payload), payload);
    // ...but only the user message is allowed to act.
    assert.equal(scan.effective.length, 0, 'no directive in the last user message');
    assert.equal(scan.all.length, 3, 'history hits are still reported for audit');
  });

  it('never acts on directives found in tool results or assistant text', () => {
    const scan = scanDirectives([user('summarize this page'), tool('page body @ocr-tier-up')]);
    assert.equal(scan.effective.length, 0, 'injection into tool output cannot escalate');
  });

  it('acts only on the LAST user message', () => {
    const scan = scanDirectives([
      user('@ocr-tier-up old prompt'),
      asst('answer'),
      user('a different prompt'),
    ]);
    assert.equal(scan.effective.length, 0);
    const scan2 = scanDirectives([
      user('@ocr-tier-up old prompt'),
      asst('answer'),
      user('@ocr-tier-down now'),
    ]);
    assert.deepEqual(scan2.effective.map((h) => h.action), ['tier_down']);
  });

  it('collapses last-wins per axis', () => {
    const scan = scanDirectives([user('@ocr-effort-up @ocr-effort-down go')]);
    assert.deepEqual(scan.effective.map((h) => h.action), ['effort_up', 'effort_down']);
    const applied = applyEffortDirectives(scan.effective.map((h) => h.action), 'medium');
    assert.equal(applied.delta, 0);
    assert.equal(applied.effort, 'medium');
  });

  it('scrubs unknown @ocr- tokens too and reports them', () => {
    const scan = scanDirectives([user('@ocr-tier-upx hello')]);
    assert.deepEqual(scan.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(scan.effective.length, 0);
    assert.deepEqual(scan.unknown.map((u) => u.token), ['@ocr-tier-upx']);
  });

  it('leaves ordinary prose containing the substring untouched (left boundary)', () => {
    // An e-mail address is not an attempt to address the gateway — scrubbing
    // must never rewrite user content it does not own.
    const scan = scanDirectives([user('mail alice@ocr-corp.com about the release')]);
    assert.deepEqual(scan.messages, [{ role: 'user', content: 'mail alice@ocr-corp.com about the release' }]);
    assert.equal(scan.unknown.length, 0);
    assert.equal(scan.all.length, 0);
  });

  it('knows @ocr-continue: scrubs it everywhere, never reports it unknown, drops a continue-only turn', () => {
    // Alone on the last user message: the drop IS the continue semantic — the
    // chain ends on the previous assistant reply, tier/effort unchanged.
    const scan = scanDirectives([user('hello'), asst('hi'), user('@ocr-continue')]);
    assert.deepEqual(scan.messages, [user('hello'), asst('hi')]);
    assert.equal(scan.lastUserDropped, true);
    assert.deepEqual(scan.effective.map((h) => h.action), ['continue']);
    assert.equal(scan.unknown.length, 0, 'a known token must not read as a typo');
    // Mixed with prompt text the token is inert: the text survives, no effect.
    const mixed = scanDirectives([user('@ocr-continue summarize the options')]);
    assert.deepEqual(mixed.messages, [{ role: 'user', content: 'summarize the options' }]);
    // History occurrences are scrubbed everywhere, like every reserved token.
    const history = scanDirectives([user('@ocr-continue earlier'), asst('ok'), user('next question')]);
    assert.ok(!JSON.stringify(history.messages).includes('@ocr-'));
    assert.equal(history.unknown.length, 0);
  });

  it('drops a message left empty after scrubbing', () => {
    const scan = scanDirectives([user('hello'), asst('hi'), user('@ocr-tier-up')]);
    assert.equal(scan.droppedMessages, 1);
    assert.equal(scan.lastUserDropped, true, 'pure continue turn — no prompt identity of its own');
    assert.deepEqual(scan.messages, [user('hello'), asst('hi')]);
    // The dropped message was still the turn's instruction.
    assert.deepEqual(scan.effective.map((h) => h.action), ['tier_up']);
  });

  it('keeps a directive-only EARLIER message dropped without claiming the last user message', () => {
    const scan = scanDirectives([user('hello'), user('@ocr-tier-down'), asst('hi'), user('real prompt')]);
    assert.equal(scan.droppedMessages, 1);
    assert.equal(scan.lastUserDropped, false);
    assert.equal(scan.effective.length, 0, 'the surviving last message carries no directive');
  });

  it('handles multimodal text parts and keeps non-text parts', () => {
    const scan = scanDirectives([
      user([
        { type: 'text', text: '@ocr-effort-up describe this image' },
        { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
      ]),
    ]);
    assert.equal(scan.effective.length, 1);
    const parts = scan.messages[0].content as any[];
    assert.equal(parts.length, 2);
    assert.equal(parts[0].text, 'describe this image');
  });

  it('is idempotent and byte-stable across turns (prefix cache)', () => {
    const chain = [user('A'), asst('B'), user('@ocr-tier-up C')];
    const first = scanDirectives(chain);
    const second = scanDirectives(chain);
    assert.deepEqual(first.messages, second.messages);
    // Re-scanning an already scrubbed chain changes nothing.
    assert.deepEqual(scanDirectives(first.messages).messages, first.messages);
  });

  it('never mutates the input chain', () => {
    const chain = [user('@ocr-tier-up hello')];
    scanDirectives(chain);
    assert.equal(chain[0].content, '@ocr-tier-up hello');
  });
});

describe('applyTierDirectives', () => {
  it('steps one tier up and down from the base', () => {
    assert.equal(applyTierDirectives(['tier_up'], 'plus').tier, 'pro');
    assert.equal(applyTierDirectives(['tier_down'], 'pro').tier, 'plus');
  });

  it('clamps at ultra and lite', () => {
    const up = applyTierDirectives(['tier_up'], 'ultra');
    assert.equal(up.tier, 'ultra');
    assert.equal(up.clamped, true);
    assert.equal(up.changed, false);
    const down = applyTierDirectives(['tier_down'], 'lite');
    assert.equal(down.tier, 'lite');
    assert.equal(down.clamped, true);
  });

  it('nets opposite steps and reports delta 0', () => {
    const r = applyTierDirectives(['tier_up', 'tier_down'], 'plus');
    assert.equal(r.delta, 0);
    assert.equal(r.tier, 'plus');
    assert.equal(r.changed, false);
  });

  it('a continue action is inert: no overlay on either axis', () => {
    const t = applyTierDirectives(['continue'], 'pro');
    assert.equal(t.applied, false, 'continue carries no tier effect');
    assert.equal(t.changed, false);
    assert.equal(t.tier, 'pro');
    const e = applyEffortDirectives(['continue'], 'medium');
    assert.equal(e.delta, 0);
    assert.equal(e.changed, false);
    assert.equal(e.effort, 'medium');
  });
});

describe('applyEffortDirectives', () => {
  it('raises from an unspecified baseline to low', () => {
    const r = applyEffortDirectives(['effort_up'], undefined);
    assert.equal(r.effort, 'low');
    assert.equal(r.changed, true);
  });

  it('lowers one rung, and is a no-op at the floor', () => {
    assert.equal(applyEffortDirectives(['effort_down'], 'high').effort, 'medium');
    // An explicit 'none' baseline stays 'none' (already at the floor).
    const explicitNone = applyEffortDirectives(['effort_down'], 'none');
    assert.equal(explicitNone.effort, 'none');
    assert.equal(explicitNone.changed, false);
    // An UNSPECIFIED baseline is not 'none': never inject an explicit level.
    const unspecified = applyEffortDirectives(['effort_down'], undefined);
    assert.equal(unspecified.effort, undefined, 'nothing below unspecified');
    assert.equal(unspecified.changed, false);
  });

  it('never rises above the model capability, flagged as clamped', () => {
    const r = applyEffortDirectives(['effort_up'], 'high', ['none', 'low', 'medium', 'high']);
    assert.equal(r.effort, 'high');
    assert.equal(r.clamped, true);
    assert.equal(r.changed, false);
  });

  it('is a no-op on a model without explicit effort control', () => {
    const r = applyEffortDirectives(['effort_up'], 'medium', []);
    assert.equal(r.effort, 'medium');
    assert.equal(r.changed, false);
    assert.equal(r.clamped, true);
  });

  it('never serves BELOW the baseline on an up-step the capability cannot reach', () => {
    // baseline 'low' against a ['high','max']-only model: the degraded-or-equal
    // rule has no rung ≤ 'medium' and would fall through to 'none' — explicitly
    // NOT thinking for a "think more" ask. The baseline must be kept.
    const r = applyEffortDirectives(['effort_up'], 'low', ['high', 'max']);
    assert.equal(r.effort, 'low');
    assert.equal(r.changed, false);
    assert.equal(r.clamped, true);
    // Same guard for an UNSPECIFIED baseline: fall-through 'none' must not be
    // injected either (unspecified ≠ explicit no-thinking).
    const unspecified = applyEffortDirectives(['effort_up'], undefined, ['high']);
    assert.equal(unspecified.effort, undefined);
    assert.equal(unspecified.changed, false);
    assert.equal(unspecified.clamped, true);
  });

  it('still serves a reachable up-step on a sparse capability ladder', () => {
    const r = applyEffortDirectives(['effort_up'], 'low', ['low', 'high']);
    assert.equal(r.effort, 'medium');
    assert.equal(r.changed, true);
    assert.equal(r.clamped, false);
  });

  it('keeps the down-direction honest: a below-baseline serve is legal there', () => {
    // Down + unreachable rungs degrades to 'none' — never ABOVE what was
    // asked, which is the only property the down direction promises.
    const r = applyEffortDirectives(['effort_down'], 'low', ['high', 'max']);
    assert.equal(r.effort, 'none');
    assert.equal(r.changed, true);
  });
});

describe('configurable namespace (ADR-0011 §4)', () => {
  // The isolated runner shares one sandbox across files — restore the config
  // this suite touches, whatever happens.
  const restore = () => {
    saveConfig({ directives: { enabled: true, prefix: DEFAULT_DIRECTIVE_PREFIX } });
    resetDirectivesGateForTests();
  };

  it('round-trips through config.yaml: save → load → gate', () => {
    try {
      assert.equal(saveConfig({ directives: { enabled: true, prefix: '@onecast-' } }).success, true);
      assert.equal(loadConfig().directives?.prefix, '@onecast-', 'persisted + read back');
      assert.equal(applyDirectivesConfig().prefix, '@onecast-', 'gate seeds from disk');
      assert.equal(applyDirectivesConfig().enabled, true);
      // An invalid value cannot be persisted into effect — load sanitizes it.
      saveConfig({ directives: { enabled: false, prefix: 'not-a-prefix' } });
      assert.deepEqual(loadConfig().directives, { enabled: false, prefix: DEFAULT_DIRECTIVE_PREFIX });
    } finally {
      restore();
    }
  });

  it('hot-applied prefix immediately governs the reserved namespace (no restart)', () => {
    try {
      const gate = applyDirectivesConfig({ enabled: true, prefix: '@onecast-' });
      assert.equal(gate.prefix, '@onecast-');
      // The live gate prefix IS the scrub contract: OLD tokens become prose,
      // NEW ones are scrubbed and effective — in the same request.
      const scan = scanDirectives([user('@onecast-tier-up hello @ocr-tier-up')], gate.prefix);
      assert.deepEqual(scan.messages, [{ role: 'user', content: 'hello @ocr-tier-up' }]);
      assert.deepEqual(scan.effective.map((h) => h.action), ['tier_up']);
      assert.equal(scan.unknown.length, 0);
    } finally {
      restore();
    }
  });

  it('validates the shape and falls back to the default on anything unusable', () => {
    assert.equal(resolveDirectivePrefix('@onecast-'), '@onecast-');
    assert.equal(resolveDirectivePrefix('  @ONEcast:  '), '@onecast:', 'trimmed + lower-cased');
    assert.equal(resolveDirectivePrefix('@x_'), '@x_');
    for (const bad of [
      undefined, null, 42, '', 'ocr-', '@', '@ocr', 'ocr', '@oc r-', '@ocr/',
      '@-ocr', '@ocr tier-', '@' + 'a'.repeat(40) + '-', 0,
    ]) {
      assert.equal(resolveDirectivePrefix(bad), DEFAULT_DIRECTIVE_PREFIX, `rejects ${String(bad)}`);
    }
  });

  it('exposes the whole vocabulary for the resolved prefix', () => {
    // 4 steps + continue + 4 tier pins + 6 effort pins.
    assert.equal(directiveTokens().length, 15);
    assert.deepEqual(directiveTokens().slice(0, 4), [
      '@ocr-tier-up', '@ocr-tier-down', '@ocr-effort-up', '@ocr-effort-down',
    ]);
    assert.equal(directiveTokens()[4], '@ocr-continue');
    assert.deepEqual(directiveTokens().slice(5, 9), [
      '@ocr-tier-lite', '@ocr-tier-plus', '@ocr-tier-pro', '@ocr-tier-ultra',
    ]);
    assert.deepEqual(directiveTokens().slice(9), [
      '@ocr-effort-none', '@ocr-effort-low', '@ocr-effort-medium',
      '@ocr-effort-high', '@ocr-effort-xhigh', '@ocr-effort-max',
    ]);
    assert.equal(directiveTokens('@onecast-')[5], '@onecast-tier-lite');
  });

  it('a relocated prefix makes the OLD namespace ordinary text — untouched, no effect', () => {
    const scan = scanDirectives(
      [user('@ocr-tier-up refactor this'), asst('ok'), user('@onecast-tier-up refactor this')],
      '@onecast-'
    );
    assert.equal(scan.prefix, '@onecast-');
    // The old token is just prose now: not scrubbed, not classified …
    assert.equal(scan.messages[0].content, '@ocr-tier-up refactor this');
    assert.equal(scan.all.length, 1);
    assert.equal(scan.unknown.length, 0);
    // … while the new namespace is scrubbed and only effective from the last user message.
    assert.equal(scan.messages[2].content, 'refactor this');
    assert.deepEqual(scan.effective.map((h) => h.action), ['tier_up']);
  });

  it('a disabled surface (prefix === null) passes the chain through untouched', () => {
    const chain = [user('@ocr-tier-up refactor this'), asst('ok'), user('@ocr-effort-down again')];
    const scan = scanDirectives(chain, null);
    assert.equal(scan.active, false);
    assert.deepEqual(scan.messages, chain);
    assert.equal(scan.effective.length, 0);
    assert.equal(scan.droppedMessages, 0);
  });

  it('an OCR-domain token is out of the namespace once the prefix moves', () => {
    // The collision this feature exists for: real prose, no leading boundary
    // issue, no directive semantics.
    const scan = scanDirectives([user('our @ocr-pipeline needs @ocr-v2 handling')], '@onecast-');
    assert.equal(scan.messages[0].content, 'our @ocr-pipeline needs @ocr-v2 handling');
    assert.equal(scan.effective.length, 0);
    assert.equal(scan.unknown.length, 0);
  });
});

describe('absolute pins (tier-<level> / effort-<level>)', () => {
  it('pins the tier to the named level in one token, up or down', () => {
    const up = applyTierDirectives(['tier_set:ultra'], 'plus');
    assert.equal(up.tier, 'ultra');
    assert.equal(up.pinned, true);
    assert.equal(up.applied, true);
    assert.equal(up.direction, 'up');
    assert.equal(up.changed, true);
    assert.equal(up.suffix, 'tier-ultra');
    // A pin BELOW the automatic decision is an explicit downgrade.
    const down = applyTierDirectives(['tier_set:lite'], 'ultra');
    assert.equal(down.tier, 'lite');
    assert.equal(down.direction, 'down');
    // Pinning the level already in play is a no-op, not an error.
    const same = applyTierDirectives(['tier_set:plus'], 'plus');
    assert.equal(same.changed, false);
    assert.equal(same.direction, 'none');
    assert.equal(same.applied, true);
  });

  it('a pin outranks steps on the same axis and reports the ignored ones', () => {
    const r = applyTierDirectives(['tier_up', 'tier_set:pro', 'tier_up'], 'plus');
    assert.equal(r.tier, 'pro', 'the pin wins over the net +2');
    assert.equal(r.pinned, true);
    assert.equal(r.ignoredSteps, 2);
    // Last pin wins when several are present.
    const last = applyTierDirectives(['tier_set:lite', 'tier_set:ultra'], 'plus');
    assert.equal(last.tier, 'ultra');
  });

  it('pins effort absolutely, capability-clamped like a client field', () => {
    const r = applyEffortDirectives(['effort_set:high'], 'low');
    assert.equal(r.effort, 'high');
    assert.equal(r.pinned, true);
    assert.equal(r.direction, 'up');
    // Below the effortFloor is legal — the floor binds automatic machinery only.
    const floored = applyEffortDirectives(['effort_set:none'], 'medium');
    assert.equal(floored.effort, 'none');
    assert.equal(floored.direction, 'down');
    // Capability clamp is honest: the served level is what the model can do.
    const clamped = applyEffortDirectives(['effort_set:max'], 'low', ['low', 'medium']);
    assert.equal(clamped.effort, 'medium');
    assert.equal(clamped.clamped, true);
    assert.equal(clamped.suffix, 'effort-max');
    // No explicit effort control at all: no-op, still ledgered as applied.
    const none = applyEffortDirectives(['effort_set:high'], 'low', []);
    assert.equal(none.effort, 'low');
    assert.equal(none.changed, false);
    assert.equal(none.applied, true);
  });

  it('a pin is classified by the scanner like any other reserved token', () => {
    const scan = scanDirectives([user('@ocr-tier-ultra rewrite this'), asst('ok'), user('plain')]);
    assert.deepEqual(scan.effective, [], 'only the last user message acts');
    assert.deepEqual(scan.all.map((h) => h.action), ['tier_set:ultra']);
    assert.equal(scan.messages[0].content, 'rewrite this');
    assert.equal(scan.unknown.length, 0);
  });
});
