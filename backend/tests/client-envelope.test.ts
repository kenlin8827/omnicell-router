import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayPromptText, firstDisplayText } from '../src/utils/client-envelope.js';

/**
 * The display normalizer's own contract (see the module doc for the three
 * rules). Session titles / per-turn summaries / route snippets all read it, so
 * a regression here silently mislabels every console row — these cases pin the
 * envelope shapes measured from real Cursor traffic (2026-11-08) plus the
 * structural fallbacks that exist so a future client needs no code change.
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

  it('keeps unknown blocks that ride with real text, and unterminated markup', () => {
    assert.equal(displayPromptText('<foo_state>x</foo_state> 你是谁'), '<foo_state>x</foo_state> 你是谁');
    assert.equal(displayPromptText('<task>修复登录</task>'), '');
    assert.equal(
      displayPromptText('<task>修复登录</task>', { keepUnknownEnvelope: true }),
      '<task>修复登录</task>',
      'a pure-markup human prompt survives the permissive pass'
    );
    assert.equal(displayPromptText('<a>hey'), '<a>hey', 'unclosed markup is not an envelope');
    assert.equal(displayPromptText('x </a> y'), 'x </a> y', 'a stray closer is plain text');
  });

  it('firstDisplayText: strict pass skips envelopes, permissive keeps a markup prompt', () => {
    assert.equal(firstDisplayText(['<user_info>x</user_info>', '<user_query>你是谁</user_query>']), '你是谁');
    assert.equal(firstDisplayText(['<environment_context>x</environment_context>', '你是谁']), '你是谁');
    assert.equal(firstDisplayText(['<task>修复登录</task>']), '<task>修复登录</task>');
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
