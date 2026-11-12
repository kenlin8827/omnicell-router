/**
 * Session-list identity additions: inbound-protocol badge + System One
 * decision-session titles.
 *   • protocolFromRequestLine classifies the client request line per surface
 *     (every recognized surface labeled explicitly — chat included);
 *   • listSessions derives `protocol` from the first client-request event;
 *   • decision-surface bodies ({model, state, questions}) yield a preview
 *     from `state` where the chat-shape extractor previously returned
 *     nothing (the untitled sess_* rows); turn prompts stamp the same text
 *     via the shared lastUserText path.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureRecorder } from '../src/capture/recorder.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-protocol-'));
const recorder = new CaptureRecorder({
  enabled: true,
  dir: tmp,
  retentionDays: 7,
  maxTotalMB: 64,
  maxBodyBytes: 65536,
});
const dateDir = CaptureRecorder.localDateDir(new Date());

/** One client-request event with the given request line + JSON body. */
function clientRequest(sessionId: string, requestId: string, requestLine: string, body: unknown): Parameters<CaptureRecorder['recordEvent']>[0] {
  return {
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    exchangeId: `span-${requestId}`,
    requestId,
    sessionId,
    model: 'probe-model',
    status: 'ok',
    wire: {
      requestLine,
      requestHeaders: {},
      requestBody: JSON.stringify(body),
      responseLine: '',
      status: 0,
      responseHeaders: {},
      responseBody: '',
    },
  };
}

describe('capture-protocol (session-list protocol badge + decision titles)', () => {
  it('protocolFromRequestLine classifies the four inference surfaces', () => {
    assert.equal(CaptureRecorder.protocolFromRequestLine('POST /v1/chat/completions HTTP/1.1'), 'chat', 'chat labeled explicitly');
    assert.equal(CaptureRecorder.protocolFromRequestLine('POST /v1/messages HTTP/1.1'), 'anthropic');
    assert.equal(CaptureRecorder.protocolFromRequestLine('POST /v1/responses?beta=true HTTP/1.1'), 'responses', 'query string stripped');
    assert.equal(CaptureRecorder.protocolFromRequestLine('POST /v1/systemone HTTP/1.1'), 'systemone');
    assert.equal(CaptureRecorder.protocolFromRequestLine('CONNECT host:443 HTTP/1.1'), undefined, 'non-inference lines stay unbadged');
    assert.equal(CaptureRecorder.protocolFromRequestLine(''), undefined);
    assert.equal(CaptureRecorder.protocolFromRequestLine(undefined), undefined);
  });

  it('extractSessionPreview reads System One state (string and structured)', () => {
    assert.equal(
      CaptureRecorder.extractSessionPreview({ model: 'm', state: '  评估这段话  ', questions: {} }),
      '评估这段话',
      'string state trims into the preview'
    );
    const structured = CaptureRecorder.extractSessionPreview({ model: 'm', state: { context: 'pick a tier', history: [1, 2] } });
    assert.ok(structured?.startsWith('{"context":"pick a tier"'), 'structured state flattens to JSON');
    assert.equal(CaptureRecorder.extractSessionPreview({ model: 'm', questions: {} }), undefined, 'absent state stays undefined');
    assert.equal(CaptureRecorder.extractSessionPreview({ model: 'm', state: 7 }), undefined, 'scalar junk state stays undefined');
  });

  it('listSessions: decision archive gets protocol=systemone + state-derived preview', async () => {
    const sid = `sess_decision_${Date.now()}`;
    await recorder.recordEvent(
      clientRequest(sid, 'tr-decision-1', 'POST /v1/systemone HTTP/1.1', {
        model: 'decision-1',
        state: '为这句选择梯队',
        questions: { q1: { type: 'choice' } },
      })
    );
    const row = recorder.listSessions(dateDir).find(r => r.sessionId === sid);
    assert.ok(row, 'decision archive row exists');
    assert.equal(row!.protocol, 'systemone', 'protocol badge derived from the request line');
    assert.equal(row!.preview, '为这句选择梯队', 'preview extracted from state (was: untitled sess_ id)');
  });

  it('listSessions: chat archive labeled chat with the message preview', async () => {
    const sid = `sess_chat_${Date.now()}`;
    await recorder.recordEvent(
      clientRequest(sid, 'tr-chat-1', 'POST /v1/chat/completions HTTP/1.1', {
        model: 'auto',
        messages: [{ role: 'user', content: 'hello router' }],
      })
    );
    const row = recorder.listSessions(dateDir).find(r => r.sessionId === sid);
    assert.ok(row, 'chat archive row exists');
    assert.equal(row!.protocol, 'chat', 'chat surface labeled');
    assert.equal(row!.preview, 'hello router');
  });

  it('turn prompt stamps state text on decision client-request events (metadata-only reads)', async () => {
    const sid = `sess_decision_prompt_${Date.now()}`;
    await recorder.recordEvent(
      clientRequest(sid, 'tr-decision-2', 'POST /v1/systemone HTTP/1.1', {
        model: 'decision-1',
        state: '评估当前会话语气',
        questions: {},
      })
    );
    const { turns } = await recorder.readEvents(dateDir, CaptureRecorder.sessionFileName(sid), 10, 'none');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].promptSummary, '评估当前会话语气', 'promptSummary survives bodies=none via the state path');
  });

  it('extractSessionPreview skips a Cursor context bundle and titles the real turn', () => {
    const bundle = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content:
            '<user_info>\nOS Version: win32 10.0.26200\nWorkspace Path: D:\\Projects\\B\n</user_info>\n\n' +
            '<rules>\n<always_applied_workspace_rules />\n</rules>\n\n' +
            '<hooks_context description="x">\n<EXTREMELY_IMPORTANT>postman</EXTREMELY_IMPORTANT>\n</hooks_context>',
        },
        { role: 'user', content: '<user_query>\n是谁\n</user_query>' },
      ],
    };
    assert.equal(
      CaptureRecorder.extractSessionPreview(bundle),
      '是谁',
      'the session list names the human turn, not <user_info>'
    );

    // An UNKNOWN envelope vocabulary needs no list entry: a tag-only message is
    // skipped by the same structural rule the console title uses.
    assert.equal(
      CaptureRecorder.extractSessionPreview({
        model: 'm',
        messages: [
          { role: 'user', content: '<environment_context><cwd>D:\\x</cwd></environment_context>' },
          { role: 'user', content: '你好' },
        ],
      }),
      '你好'
    );
  });

  it('extractTurnPrompt leaves a metadata-only turn unprompted instead of quoting the bundle', () => {
    assert.equal(
      CaptureRecorder.extractTurnPrompt({
        model: 'm',
        messages: [
          { role: 'user', content: '<user_info>OS: win32</user_info>' },
        ],
      }),
      undefined,
      'a context-refresh turn carries no prompt chip'
    );
    assert.equal(
      CaptureRecorder.extractTurnPrompt({
        model: 'm',
        messages: [
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: '<user_query>\n继续\n</user_query>' },
        ],
      }),
      '继续',
      'the wrapped human turn is unwrapped'
    );
  });

  after(() => {
    recorder.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
