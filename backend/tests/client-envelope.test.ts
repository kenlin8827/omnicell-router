import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayPromptText, firstDisplayText } from '../src/utils/client-envelope.js';
import { harnessProfileOf } from '../src/utils/harness-profiles.js';

/**
 * The display normalizer's own contract (see the module doc for the four
 * rules). Session titles / per-turn summaries / route snippets all read it, so
 * a regression here silently mislabels every console row — these cases pin the
 * envelope shapes measured from real Cursor traffic (2026-11-08) and real
 * Claude Code traffic (2026-11-14, claude-cli/2.1.317), plus the structural
 * fallbacks that exist so a future client needs no code change.
 */
describe('displayPromptText — client envelope normalizer', () => {
  it('keeps human text verbatim (whitespace flattened)', () => {
    assert.equal(displayPromptText('  你是谁\n'), '你是谁');
    assert.equal(displayPromptText('a < b and 1 < 2'), 'a < b and 1 < 2');
  });

  it('drops known metadata blocks, keeping human text around them', () => {
    assert.equal(displayPromptText('<timestamp>11/8/2026, 9:01:10 PM GMT+8</timestamp>'), '');
    assert.equal(displayPromptText('<user_info>OS: win32</user_info>\n你是谁'), '你是谁');
    assert.equal(displayPromptText('<rules>r</rules><mcp_meta_tool_servers name="x" /> 你是谁'), '你是谁');
  });

  it('unwraps <user_query> and lets it outrank context in the same message', () => {
    assert.equal(displayPromptText('<user_query>\n你知道项目结构吗\n</user_query>'), '你知道项目结构吗');
    assert.equal(
      displayPromptText('<user_info>OS: win32</user_info>\n<user_query>\n你是谁\n</user_query>'),
      '你是谁'
    );
    // A wrapper quoted inside known client metadata is an example, not the turn.
    assert.equal(
      displayPromptText('<hooks_context><user_query>example</user_query></hooks_context>'),
      ''
    );
  });

  it('drops a tag-only message whatever its vocabulary (rule 3)', () => {
    const unknownBundle =
      '<environment_context><cwd>D:\\x</cwd></environment_context>' +
      '<open_and_recently_viewed_files><file path="a" /></open_and_recently_viewed_files>';
    assert.equal(displayPromptText(unknownBundle), '');
    // Balanced same-name nesting is still a shell.
    assert.equal(displayPromptText('<a><a>x</a></a>'), '');
    assert.equal(
      displayPromptText('<a><a>x</a></a>', { keepUnknownEnvelope: true }),
      '<a><a>x</a></a>',
      'the title fallback keeps a tag-only message rather than naming nothing'
    );
  });

  it('drops the head block-run of a prepend-machinery message, keeping the later text (rule 4)', () => {
    // The measured Claude Code shape: machinery blocks FIRST, human text last
    // (content parts joined, exactly as the orchestrator joins them). Without
    // rule 4 the raw blocks ranked ahead of the prompt and the 200-char cap
    // made the whole title attribution boilerplate (session cc_c6a59aae…).
    assert.equal(
      displayPromptText('<foo_state>x</foo_state> 你是谁'),
      '你是谁',
      'a leading block-run is machinery; the later text is the turn'
    );
    // Text BEFORE the first block disables the rule — human prose then data.
    assert.equal(
      displayPromptText('please analyze <data>x</data>'),
      'please analyze <data>x</data>'
    );
    // A wrapper still outranks the head-run rule (rule 1 fires first).
    assert.equal(
      displayPromptText('<user_info>OS: win32</user_info>\n<user_query>\n你是谁\n</user_query>'),
      '你是谁'
    );
    // Tag-only messages keep their rule 3 verdict; rule 4 adds nothing.
    assert.equal(displayPromptText('<a><a>x</a></a>'), '');
    // Unterminated markup is untouched in practice: the verbatim tail IS the
    // post text, so the output equals the fallback.
    assert.equal(displayPromptText('<a>hey'), '<a>hey', 'unclosed markup is not an envelope');
    // The head run must not starve the tail out of the display budget: a
    // context bundle well past the cap (Cursor's `<agent_transcripts>`) still
    // names the turn, because the post run carries its own budget.
    const hugeHead = '<foo_state>' + 'x'.repeat(20_000) + '</foo_state> 你是谁';
    assert.equal(displayPromptText(hugeHead), '你是谁');
  });

  it('keeps unknown blocks that ride with real text, and unterminated markup', () => {
    assert.equal(displayPromptText('<task>修复登录</task>'), '');
    assert.equal(
      displayPromptText('<task>修复登录</task>', { keepUnknownEnvelope: true }),
      '修复登录',
      'a lone plain-text block is a WRAPPER: the permissive pass unwraps it'
    );
    assert.equal(
      displayPromptText('<session> 关注当天的行情 </session>'),
      '关注当天的行情',
      'the measured WorkBuddy wrapper unwraps in the strict pass too'
    );
    assert.equal(displayPromptText('x </a> y'), 'x </a> y', 'a stray closer is plain text');
  });

  it('firstDisplayText: strict pass skips envelopes, permissive keeps a markup prompt', () => {
    assert.equal(firstDisplayText(['<user_info>x</user_info>', '<user_query>你是谁</user_query>']), '你是谁');
    assert.equal(firstDisplayText(['<environment_context>x</environment_context>', '你是谁']), '你是谁');
    assert.equal(firstDisplayText(['<task>修复登录</task>']), '修复登录');
    assert.equal(firstDisplayText(['<timestamp>11/8/2026</timestamp>']), undefined);
    const capped = firstDisplayText(['x'.repeat(300)], 200);
    assert.equal(capped?.length, 200);
    assert.ok(capped?.endsWith('…'), 'truncation is visible');
  });

  it('scans linearly (an unclosed-tag flood must not stall the request path)', () => {
    // The regex block matcher this replaced took ~1.2 s here (quadratic); the
    // scan is milliseconds. The bound is deliberately loose — it only has to
    // fail on a complexity regression, not on a slow machine.
    const flood = '<a>'.repeat(50_000) + 'x';
    const started = performance.now();
    const out = displayPromptText(flood);
    const elapsed = performance.now() - started;
    assert.ok(out.startsWith('<a><a>'), 'unterminated flood stays verbatim');
    assert.ok(elapsed < 1_500, `unclosed-tag flood took ${elapsed.toFixed(0)}ms`);
  });
});

describe('harness profiles — scoped envelope vocabulary (ADR-0025 layer 2)', () => {
  const claudeCode = harnessProfileOf('claude-cli/2.1.317 (external, cli)');

  it('fingerprints by User-Agent, first match wins, unknown stays unprofiled', () => {
    assert.ok(claudeCode, 'claude-cli/ resolves the Claude Code profile');
    assert.equal(harnessProfileOf('cursor/1.0'), undefined, 'no profile seeds Cursor yet');
    assert.equal(harnessProfileOf(undefined), undefined);
    assert.equal(harnessProfileOf('  '), undefined, 'whitespace-only UA is absent');
    assert.equal(harnessProfileOf('curl/8.0'), undefined);
  });

  it('drops Claude Code machinery tags ONLY when the profile is in play', () => {
    const mixed =
      '<system-reminder>Co-Authored-By: Claude Code <noreply@anthropic.com></system-reminder>' +
      '<local-command-caveat>recorded here as context</local-command-caveat>' +
      '<command-name>/clear</command-name><command-message>clear</command-message>' +
      '<command-args></command-args><local-command-stdout></local-command-stdout> 你是谁';
    // Scoped: without the profile these are unknown blocks — and rule 4 alone
    // still recovers the prompt (the structural bet of ADR-0025 layer 1).
    assert.equal(displayPromptText(mixed), '你是谁');
    assert.equal(displayPromptText(mixed, { profile: claudeCode }), '你是谁');
    // A LONE system-reminder message: blank in strict; with the profile the
    // permissive pass must not unwrap it into a last-resort title either.
    const loneReminder = '<system-reminder>attribution boilerplate</system-reminder>';
    assert.equal(displayPromptText(loneReminder), '');
    assert.equal(displayPromptText(loneReminder, { keepUnknownEnvelope: true }), 'attribution boilerplate');
    assert.equal(
      displayPromptText(loneReminder, { profile: claudeCode, keepUnknownEnvelope: true }),
      '',
      'scoped metadata is never a lone-wrapper candidate'
    );
    // Scoped vocabulary never leaks to other clients: the same tag pasted by
    // an unprofiled client inside leading prose keeps the old behavior.
    assert.equal(
      displayPromptText('see <command-name>/clear</command-name> docs'),
      'see <command-name>/clear</command-name> docs'
    );
  });

  it('blanks Claude Code hook-output messages by anchored prefix, profile-scoped', () => {
    // Measured on the wire: a SessionStart hook result arrives as a standalone
    // user message whose own words open with the convention.
    const hookMsg = 'SessionStart:clear hook success: <EXTREMELY_IMPORTANT>You have the Postman plugin.';
    assert.equal(displayPromptText(hookMsg, { profile: claudeCode }), '');
    // Permissive pass must not resurrect it as a title.
    assert.equal(displayPromptText(hookMsg, { profile: claudeCode, keepUnknownEnvelope: true }), '');
    // Without the profile the message is just prose — nothing structural.
    assert.ok(displayPromptText(hookMsg).startsWith('SessionStart:clear hook success:'));
    // A HUMAN message that merely mentions the convention later is untouched:
    // the prefix is anchored at the start of the text.
    assert.equal(
      displayPromptText('我的 SessionStart:clear hook success: 前缀出现在中间', { profile: claudeCode }),
      '我的 SessionStart:clear hook success: 前缀出现在中间'
    );
  });

  it('titles the real Claude Code session-opening wire shape (fixture from cc_c6a59aae)', () => {
    // Verbatim content-part texts of the session-opening user message
    // (claude-cli/2.1.317, capture archive 2026-11-14), joined the way the
    // orchestrator joins multimodal text parts. Before ADR-0025 the title
    // was the raw `<system-reminder>` attribution text.
    const parts = [
      '<system-reminder>\nAttribution for git commits and pull requests you create from here on:\n- End git commit messages with:\nCo-Authored-By: Claude Code <noreply@anthropic.com>\n</system-reminder>\n',
      "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>\n",
      '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>\n',
      '<local-command-stdout></local-command-stdout>\n',
      '你是谁',
    ];
    const joined = parts.join(' ');
    // Structural rule 4 alone — no vocabulary — already names the session.
    assert.equal(firstDisplayText([joined], 200), '你是谁');
    assert.equal(firstDisplayText([joined], 200, { profile: claudeCode }), '你是谁');
    // The SessionStart hook message that follows rides the NEXT user message;
    // with the profile it is machinery, so the title still resolves to the
    // prompt and the hook message never outranks it.
    const hookMsg = 'SessionStart:clear hook success: <EXTREMELY_IMPORTANT>You have the Postman plugin.';
    assert.equal(firstDisplayText([joined, hookMsg], 200, { profile: claudeCode }), '你是谁');
  });
});
