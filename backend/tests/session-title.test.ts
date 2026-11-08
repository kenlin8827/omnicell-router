import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { RouterConfig } from '../src/config/types.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Console session titles (ADR-0002 §3) — `firstUserMessage` on the
 * `/api/admin/sessions` row.
 *
 * The title is captured ONCE at session birth and written to two places from
 * the same extraction: the live entity and the session's traces (re-stamped
 * verbatim on every later turn). The trace copy is what keeps a row named
 * when no entity exists at all (combo / stateless sessions) or after a
 * restart — the request-capture archive is never consulted, so the title
 * survives with capture disabled.
 *
 * Auth mirror of server.ts preHandler key resolution: when the local
 * config.yaml defines apiKeys, inference endpoints require a valid key even
 * though the test config passes none (disk keys win over the test config by
 * design). Reuse the first enabled disk key so the e2e cases run both on
 * machines with a populated config.yaml and in clean CI checkouts.
 */
function authHeaders(): Record<string, string> {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
}

const baseConfig: RouterConfig = {
  port: 3000,
  host: '127.0.0.1',
  baselineModel: 'plus-1',
  fallback: {
    enabled: false,
    maxRetries: 1,
    escalateTier: 'plus',
    injectErrorContext: false,
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 3,
  },
  retry: {
    enabled: true,
    inplace: {
      enabled: true,
      maxAttempts: 1,
      backoffMs: 10,
      jitterMs: 5,
    },
    failover: {
      enabled: true,
      maxAttempts: 3,
      tierCrossPolicy: 'allow_escalate',
    },
  },
  models: [
    {
      id: 'lite-1',
      provider: 'mock',
      upstreamModel: 'lite-1',
      tier: 'lite',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
    },
    {
      id: 'plus-1',
      provider: 'mock',
      upstreamModel: 'plus-1',
      tier: 'plus',
      priority: 1,
      isDefaultInTier: true,
      pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
    },
  ],
  // A combo never mints a session entity (sessionMode='bypass'), so its
  // console row is rebuilt from traces alone — exactly the shape this suite
  // must keep titled.
  combos: [{ id: 'combo-title', selection: 'priority', models: ['lite-1'] }],
};

describe('Console session title (firstUserMessage)', () => {
  let app: FastifyInstance;

  before(async () => {
    app = createServer(baseConfig, true).app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const rows = async (): Promise<any[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/sessions', headers: authHeaders() });
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body).data;
  };

  const chat = async (sessionId: string, body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...authHeaders(), 'x-session-id': sessionId },
      payload: { model: 'auto', ...body },
    });
    assert.equal(res.statusCode, 200);
    return res;
  };

  it('names a live session from its birth entity and never rewrites it', async () => {
    await chat('sess_title_live', {
      messages: [{ role: 'user', content: 'Plan a trip to Kyoto' }],
    });

    const first = (await rows()).find(s => s.id === 'sess_title_live');
    assert.ok(first, 'live session must be listed');
    assert.equal(first.firstUserMessage, 'Plan a trip to Kyoto');

    // A later turn carries the whole history plus a new prompt — the title is
    // the OPENING prompt, not the latest one.
    await chat('sess_title_live', {
      messages: [
        { role: 'user', content: 'Plan a trip to Kyoto' },
        { role: 'assistant', content: 'Sure.' },
        { role: 'user', content: 'Add a day in Osaka' },
      ],
    });

    const second = (await rows()).find(s => s.id === 'sess_title_live');
    assert.equal(second.firstUserMessage, 'Plan a trip to Kyoto');
    assert.equal(second.turnCount, 2);
  });

  it('re-stamps the birth title on every later trace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/sessions/sess_title_live/traces',
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    const traces = JSON.parse(res.body).data;

    assert.equal(traces[0].request.firstUserSummary, 'Plan a trip to Kyoto');
    assert.equal(
      traces[1].request.firstUserSummary,
      'Plan a trip to Kyoto',
      'a later turn copies the birth title, so evicting the birth trace cannot blank it'
    );
  });

  it('names a combo session that has no live entity (trace-reconstructed row)', async () => {
    await chat('sess_title_combo', {
      model: 'combo-title',
      messages: [{ role: 'user', content: 'Compare two laptops' }],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_combo');
    assert.ok(row, 'combo session is trace-only but must still be listed');
    assert.equal(row.firstUserMessage, 'Compare two laptops');

    // Proof the row came from the trace path: bypass never mints an entity,
    // so the single-session endpoint has nothing to return.
    const detail = await app.inject({
      method: 'GET',
      url: '/api/admin/sessions/sess_title_combo',
      headers: authHeaders(),
    });
    assert.equal(detail.statusCode, 404);
  });

  it('names a session whose opening message is multimodal (text parts joined)', async () => {
    await chat('sess_title_multimodal', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'text', text: 'this chart' },
          ],
        },
      ],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_multimodal');
    assert.ok(row, 'multimodal session must be listed');
    assert.equal(row.firstUserMessage, 'Describe this chart');
  });

  it('skips a client metadata envelope and unwraps the real prompt (Cursor agent)', async () => {
    // Cursor's agent opens a conversation with a standalone `<timestamp>`
    // message, then wraps the human turn in `<user_query>`. The gateway
    // forwards both verbatim, but the console title must name the PROMPT —
    // the timezone clock reading identifies nothing.
    await chat('sess_title_envelope', {
      messages: [
        { role: 'user', content: '<timestamp>11/8/2026, 8:53:57 PM GMT+8</timestamp>' },
        { role: 'user', content: '<user_query>\n你知道项目结构吗\n</user_query>' },
      ],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_envelope');
    assert.ok(row, 'envelope-led session must be listed');
    assert.equal(row.firstUserMessage, '你知道项目结构吗');

    // The per-turn summary uses the same display normalizer, so the trace
    // carries the unwrapped prompt rather than the wrapper tags.
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/sessions/sess_title_envelope/traces',
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    const traces = JSON.parse(res.body).data;
    assert.equal(traces[0].request.userPromptSummary, '你知道项目结构吗');
  });

  it('skips a Cursor context bundle and titles the real turn after it', async () => {
    // Cursor's agent also opens a conversation with a standalone context
    // BUNDLE (measured 2026-11-08): `<user_info>` first, then rules, skills,
    // MCP catalog and hooks, with the human turn arriving as the next
    // `<user_query>` message. Titling from the bundle named sessions
    // `<user_info> OS Version: win32 …` — the operating system tells the
    // operator nothing about what they asked.
    await chat('sess_title_context_bundle', {
      messages: [
        {
          role: 'user',
          content:
            '<user_info>\nOS Version: win32 10.0.26200\n\nShell: powershell\n\n' +
            'Workspace Path: D:\\Projects\\BaijiuShop\n\n' +
            'Is directory a git repo: Unknown (git repository detection still warming)\n' +
            "</user_info>\n\n<rules>\n<always_applied_workspace_rules />\n</rules>\n\n" +
            '<hooks_context description="session hooks">\n<EXTREMELY_IMPORTANT>postman</EXTREMELY_IMPORTANT>\n</hooks_context>',
        },
        { role: 'user', content: '<user_query>\n你是谁\n</user_query>' },
      ],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_context_bundle');
    assert.ok(row, 'context-bundle-led session must be listed');
    assert.equal(row.firstUserMessage, '你是谁');
  });

  it('skips a context envelope of UNKNOWN tag vocabulary (no tag list can cover it)', async () => {
    // Rule 3 in utils/client-envelope.ts: a message that is nothing but
    // XML-style blocks is a client envelope whatever its tag names are — the
    // evidence-backed list only fast-paths today's clients, it is not the
    // contract. `<environment_context>`/`<open_and_recently_viewed_files>` are
    // deliberately absent from that list.
    await chat('sess_title_unknown_envelope', {
      messages: [
        {
          role: 'user',
          content:
            "<environment_context>\n  <cwd>D:\\Projects\\BaijiuShop</cwd>\n  <shell>powershell</shell>\n</environment_context>\n\n" +
            '<open_and_recently_viewed_files>\n  <file path="src/main.ts" />\n</open_and_recently_viewed_files>',
        },
        { role: 'user', content: '<user_query>\n你是谁\n</user_query>' },
      ],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_unknown_envelope');
    assert.ok(row, 'unknown-envelope-led session must be listed');
    assert.equal(row.firstUserMessage, '你是谁');
  });

  it('prefers the wrapped human turn over context riding in the SAME message', async () => {
    // Rule 1: the `<user_query>` body is the human content, so a client that
    // prepends its context to the turn instead of sending it separately still
    // names the session after the prompt.
    await chat('sess_title_inline_bundle', {
      messages: [
        {
          role: 'user',
          content:
            '<user_info>\nOS Version: win32 10.0.26200\n</user_info>\n\n' +
            '<user_query>\n你知道项目结构吗\n</user_query>',
        },
      ],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_inline_bundle');
    assert.ok(row, 'inline-bundle session must be listed');
    assert.equal(row.firstUserMessage, '你知道项目结构吗');
  });

  it('keeps a prompt that is itself pure markup instead of naming the session nothing', async () => {
    // Cost of rule 3: a tag-only HUMAN prompt is structurally identical to a
    // client envelope. The title's permissive pass keeps it, so the session is
    // still identifiable by the snippet the operator actually typed.
    await chat('sess_title_markup_prompt', {
      messages: [{ role: 'user', content: '<task>修复登录</task>' }],
    });

    const row = (await rows()).find(s => s.id === 'sess_title_markup_prompt');
    assert.ok(row, 'markup-prompt session must be listed');
    assert.equal(row.firstUserMessage, '<task>修复登录</task>');
  });

  it('q searches the title on trace-reconstructed rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/sessions?q=${encodeURIComponent('Compare two laptops')}`,
      headers: authHeaders(),
    });
    assert.equal(res.statusCode, 200);
    const ids = JSON.parse(res.body).data.map((s: any) => s.id);
    assert.ok(ids.includes('sess_title_combo'), 'title must be searchable on reconstructed rows');
  });
});
