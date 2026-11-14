import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CaptureRecorder,
  primaryExchange,
  type CaptureEvent,
  type CaptureRequestSummary,
} from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The canonical wire dump used by schema-2 fixtures. */
const WIRE = {
  requestLine: 'POST /v1/chat/completions HTTP/1.1',
  requestHeaders: {} as Record<string, string>,
  requestBody: '{}',
  responseLine: '',
  status: 0,
  responseHeaders: {} as Record<string, string>,
  responseBody: '',
};

type EventInput = Parameters<CaptureRecorder['recordEvent']>[0];

/** One complete schema-2 client-request event with a write-time turn. */
function requestEvent(over: Partial<EventInput> & { sessionId: string }): EventInput {
  return {
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    exchangeId: `ex_${over.sessionId}`,
    requestId: `req_${over.sessionId}`,
    model: 'auto',
    status: 'ok',
    turnIndex: 1,
    isPromptStart: true,
    turnDecision: 'new_prompt',
    wire: { ...WIRE },
    ...over,
  } as EventInput;
}

/** Write one request event (replaces the retired pre-event `record()` API). */
const writeRequest = (rec: CaptureRecorder, over: Partial<EventInput> & { sessionId: string }) =>
  rec.recordEvent(requestEvent(over));

/**
 * TEST-ONLY assertion projection over the canonical `exchanges[]`, mirroring
 * the frontend's UI view. It is not part of the wire contract — the recorder
 * publishes one shape only. `attempt` ordering keeps failover hops distinct.
 */
function viewOf(r: CaptureRequestSummary) {
  const client = primaryExchange(r, 'client');
  const upstream = primaryExchange(r, 'upstream');
  const decision = primaryExchange(r, 'decision');
  return {
    clientRequest: client?.request,
    clientResponse: client?.response,
    upstreamRequest: upstream?.request,
    upstreamResponse: upstream?.response,
    decisionRequest: decision?.request,
    decisionResponse: decision?.response,
    gatewayLatencyMs: client?.latencyMs,
    gatewayTtftMs: client?.ttftMs,
    gatewayGenMs: client?.genMs,
    upstreamLatencyMs: upstream?.latencyMs,
    upstreamTtftMs: upstream?.ttftMs,
    upstreamGenMs: upstream?.genMs,
    decisionLatencyMs: decision?.latencyMs,
    decisionTtftMs: decision?.ttftMs,
    decisionGenMs: decision?.genMs,
  };
}

describe('CaptureRecorder', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 512,
      maxBodyBytes: 1024,
    });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('is disabled by default (opt-in)', () => {
    const off = new CaptureRecorder(undefined);
    assert.equal(off.isEnabled(), false);
    off.stop();
  });

  it('does not write when disabled', async () => {
    const off = new CaptureRecorder({ enabled: false, dir: makeTmpDir() });
    await writeRequest(off, { sessionId: 's1' });
    assert.equal(fs.readdirSync(off.getDir()).length, 0);
    off.stop();
    rmrf(off.getDir());
  });

  it('archives by local date directory + session id and reads back', async () => {
    await writeRequest(recorder, {
      sessionId: 'sess_demo_1',
      wire: { ...WIRE, requestBody: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] }) },
    });

    const dates = recorder.listDates();
    assert.equal(dates.length, 1);
    assert.match(dates[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(dates[0].sessions, 1);
    assert.ok(dates[0].bytes > 0);

    const sessions = recorder.listSessions(dates[0].date);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].file, 'sess_demo_1.jsonl');
    assert.equal(sessions[0].sessionId, 'sess_demo_1');

    const { records, totalLines } = recorder.readRecords(dates[0].date, sessions[0].file);
    assert.equal(totalLines, 1);
    assert.equal(records[0].eventType, 'http-exchange');
    assert.equal(records[0].schema, 2);
    assert.equal(records[0].turnIndex, 1);
    assert.equal(records[0].isPromptStart, true);
    assert.equal(records[0].turnDecision, 'new_prompt');
    assert.equal(records[0].attempt, 1);
    assert.match(String(records[0].id), /^evt_/);
    assert.equal((records[0].wire as any).requestBody.includes('hello'), true);
    assert.equal(records[0].truncated, undefined);
  });

  it('appends multiple turns into the same session file', async () => {
    await writeRequest(recorder, { sessionId: 'sess_demo_1', requestId: 'req_demo_2', wire: { ...WIRE, requestBody: '{"n":2}' } });
    await writeRequest(recorder, { sessionId: 'sess_demo_1', requestId: 'req_demo_3', status: 'error', error: 'boom', wire: { ...WIRE, requestBody: '{"n":3}' } });

    const date = recorder.listDates()[0].date;
    const { records, totalLines } = recorder.readRecords(date, 'sess_demo_1.jsonl');
    assert.equal(totalLines, 3);
    assert.equal(records[2].status, 'error');
    assert.equal(records[2].error, 'boom');
  });

  it('sanitizes client-controlled session ids (path traversal safe)', async () => {
    const evil = '../../etc/passwd';
    const file = CaptureRecorder.sessionFileName(evil);
    assert.ok(file.startsWith('h_'), `expected hashed name, got ${file}`);
    assert.ok(!file.includes('..') && !file.includes('/'));
    // Stable hash for the same input
    assert.equal(file, CaptureRecorder.sessionFileName(evil));

    await writeRequest(recorder, { sessionId: evil });
    const date = recorder.listDates()[0].date;
    const sessions = recorder.listSessions(date);
    assert.ok(sessions.some(s => s.file === file));
    // Nothing escaped the date dir
    assert.equal(fs.existsSync(path.join(tmp, '..', 'etc')), false);
  });

  it('truncates oversized bodies and marks the record', async () => {
    const big = 'x'.repeat(5000); // > maxBodyBytes 1024 once serialized
    await writeRequest(recorder, {
      sessionId: 'sess_big',
      wire: { ...WIRE, requestBody: JSON.stringify({ messages: [{ role: 'user', content: big }] }) },
    });

    const date = recorder.listDates()[0].date;
    const { records } = recorder.readRecords(date, 'sess_big.jsonl');
    assert.equal(records[0].truncated, true);
    const body = (records[0].wire as any).requestBody;
    assert.equal(typeof body, 'string');
    assert.ok(body.endsWith('...[TRUNCATED]'));
  });

  it('rejects path traversal on reads', () => {
    const date = recorder.listDates()[0].date;
    assert.deepEqual(recorder.readRecords(date, '../../secret.jsonl'), { records: [], totalLines: 0, fileTruncated: false });
    assert.deepEqual(recorder.readRecords('2020-01-01; rm -rf', 'sess_demo_1.jsonl'), { records: [], totalLines: 0, fileTruncated: false });
    assert.equal(recorder.readRecords(date, 'sess_demo_1.jsonl').totalLines > 0, true);
  });

  it('sweep deletes date directories older than retentionDays', () => {
    const old = path.join(tmp, '2020-01-01');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'old_sess.jsonl'), '{"old":true}\n');
    assert.ok(fs.existsSync(old));

    recorder.sweep();
    assert.equal(fs.existsSync(old), false);
    // Today's data survives
    assert.ok(recorder.listDates().length >= 1);
  });

  it('deleteDate removes a whole date directory and validates input', () => {
    const dates = recorder.listDates();
    assert.ok(dates.length >= 1);
    const date = dates[0].date;
    assert.equal(recorder.deleteDate('not-a-date'), false);
    assert.equal(recorder.deleteDate(date), true);
    assert.equal(recorder.deleteDate(date), false); // already gone
  });

  it('deleteSession removes one session file and validates input', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await writeRequest(rec, { sessionId: 'sess_a' });
      await writeRequest(rec, { sessionId: 'sess_b' });
      const date = rec.listDates()[0].date;
      assert.equal(rec.listSessions(date).length, 2);

      assert.equal(rec.deleteSession(date, 'sess_a.jsonl'), true);
      assert.equal(rec.deleteSession(date, 'sess_a.jsonl'), false); // already gone
      const left = rec.listSessions(date);
      assert.equal(left.length, 1);
      assert.equal(left[0].file, 'sess_b.jsonl');

      // Validation: bad date / traversal / wrong suffix / unknown file
      assert.equal(rec.deleteSession('not-a-date', 'sess_b.jsonl'), false);
      assert.equal(rec.deleteSession(date, '../../etc/passwd.jsonl'), false);
      assert.equal(rec.deleteSession(date, 'sess_b.txt'), false);
      assert.equal(rec.deleteSession(date, 'sess_missing.jsonl'), false);

      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('readRawArchive filters excluded wire bodies for export', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await writeRequest(rec, {
        sessionId: 'sess_f', status: 'error', error: 'boom',
        wire: { ...WIRE, requestBody: '{"q":1}' },
      });
      await rec.recordEvent({
        eventType: 'http-exchange', direction: 'client', phase: 'response',
        exchangeId: 'ex_sess_f', requestId: 'req_sess_f', sessionId: 'sess_f', model: 'auto',
        status: 'ok', turnIndex: 1, isPromptStart: false, turnDecision: 'continuation',
        wire: { ...WIRE, responseBody: '{"r":2}' },
      });
      const date = rec.listDates()[0].date;

      // Default: verbatim, bodies intact.
      const full = rec.readRawArchive(date, 'sess_f.jsonl');
      const fullLines = full!.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(fullLines[0].wire.requestBody, '{"q":1}');
      assert.equal(fullLines[1].wire.responseBody, '{"r":2}');

      // Excluding body classes keeps metadata (ids / status / turn identity).
      const filtered = rec.readRawArchive(date, 'sess_f.jsonl', [
        'request', 'upstreamRequest', 'response',
      ])!;
      const lines = filtered.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].wire.requestBody, '');
      assert.equal(lines[0].status, 'error');
      assert.equal(lines[0].error, 'boom');
      assert.equal(lines[0].turnIndex, 1);
      assert.equal(lines[0].schema, 2);
      assert.equal(lines[1].wire.responseBody, '');
      assert.equal(lines[1].status, 'ok');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('applyConfig hot-toggles recording without a restart', async () => {
    const dir3 = makeTmpDir();
    try {
      const hot = new CaptureRecorder({ enabled: false, dir: dir3, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await writeRequest(hot, { sessionId: 's_cold' });
      assert.equal(hot.listDates().length, 0); // still disabled

      hot.applyConfig({ enabled: true });
      assert.equal(hot.isEnabled(), true);
      await writeRequest(hot, { sessionId: 's_hot' });
      assert.equal(hot.listDates().length, 1);

      hot.applyConfig({ enabled: false });
      assert.equal(hot.isEnabled(), false);
      await writeRequest(hot, { sessionId: 's_after_off' });
      const sessions = hot.listSessions(hot.listDates()[0].date);
      assert.ok(!sessions.some(s => s.file === 's_after_off.jsonl'), 'no writes after hot-disable');
      // Existing archive survives a hot-disable (disable never deletes)
      assert.ok(sessions.some(s => s.file === 's_hot.jsonl'));

      hot.stop();
    } finally {
      rmrf(dir3);
    }
  });

  it('systemone capture collapses into the single master: isEnabled is the only gate', () => {
    const dir5 = makeTmpDir();
    const mk = (enabled?: boolean): CaptureRecorder =>
      new CaptureRecorder({ dir: dir5, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024, enabled });
    try {
      // SINGLE-MASTER PIN (the retired requestCapture.systemone.{enabled,
      // l2DecisionEnabled} two-gate subtree is load-stripped): the capture
      // master alone gates every leg — the /v1/systemone client pair, its
      // upstream pair and the L2 decision-call leg. Absent = default OFF
      // (the privacy opt-in); there is no per-surface override anymore.
      assert.equal(mk(undefined).isEnabled(), false);
      assert.equal(mk(false).isEnabled(), false);
      assert.equal(mk(true).isEnabled(), true);

      // applyConfig hot-swap: ON ↔ OFF both ways, and absent keeps the
      // current value (nullish-merge, like every other field).
      const hot = mk(false);
      hot.applyConfig({ enabled: true });
      assert.equal(hot.isEnabled(), true);
      hot.applyConfig({}); // absent → retains
      assert.equal(hot.isEnabled(), true);
      hot.applyConfig({ enabled: false });
      assert.equal(hot.isEnabled(), false);
      hot.stop();
    } finally {
      rmrf(dir5);
    }
  });

  it('applyConfig picks up a new retention window and sweeps by it', () => {
    const dir4 = makeTmpDir();
    try {
      const old = path.join(dir4, '2026-10-01');
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, 'old.jsonl'), '{"x":1}\n');

      const hot = new CaptureRecorder({ enabled: true, dir: dir4, retentionDays: 365, maxTotalMB: 512, maxBodyBytes: 65536 });
      assert.ok(fs.existsSync(old)); // within the 365d window

      hot.applyConfig({ retentionDays: 1 }); // 2026-10-01 is now out of window
      assert.equal(fs.existsSync(old), false); // applied config swept immediately
      hot.stop();
    } finally {
      rmrf(dir4);
    }
  });

  it('sweep enforces maxTotalBytes by deleting oldest dates first', () => {
    const dir2 = makeTmpDir();
    try {
      fs.mkdirSync(path.join(dir2, '2026-10-06'), { recursive: true });
      fs.writeFileSync(path.join(dir2, '2026-10-06', 'a.jsonl'), '{"x":1}\n');
      fs.mkdirSync(path.join(dir2, '2026-10-07'), { recursive: true });
      fs.writeFileSync(path.join(dir2, '2026-10-07', 'b.jsonl'), '{"x":1}\n');
      // retentionDays 365 keeps both by age; maxTotalMB 0 over-budgets all content.
      const tiny = new CaptureRecorder({ enabled: true, dir: dir2, retentionDays: 365, maxTotalMB: 0 });
      assert.equal(tiny.listDates().length, 0);
      tiny.stop();
    } finally {
      rmrf(dir2);
    }
  });

  it('extractSessionPreview reads the first user message across body shapes', () => {
    const E = CaptureRecorder.extractSessionPreview;
    // OpenAI chat, string content
    assert.equal(E({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '帮我写个爬虫' }] }), '帮我写个爬虫');
    // Text-part array content
    assert.equal(E({ messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }] }), 'part one part two');
    // Responses API input (string + parts array)
    assert.equal(E({ input: 'plain input' }), 'plain input');
    assert.equal(E({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'responses text' }] }] }), 'responses text');
    // Truncated-string body: strip suffix, repair the cut JSON, recover text
    assert.equal(E('{"messages":[{"role":"user","content":"from truncated"}],"more":...[TRUNCATED]'), 'from truncated');
    assert.equal(
      E('{"messages":[{"role":"system","content":"sys"},{"role":"user","content":"帮我修复登录bug"}],"tools":[{"na...[TRUNCATED]'),
      '帮我修复登录bug'
    );
    // Raw non-JSON string body — falls back to the string head
    assert.equal(E('not json at all'), 'not json at all');
    // Newlines flattened, capped with ellipsis
    assert.equal(E({ messages: [{ role: 'user', content: 'line1\n\nline2' }] }), 'line1 line2');
    const long = 'x'.repeat(300);
    const capped = E({ messages: [{ role: 'user', content: long }] })!;
    assert.equal(capped.length, 120);
    assert.ok(capped.endsWith('…'));
    // No previewable text
    assert.equal(E({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }, { role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), undefined);
    assert.equal(E({}), undefined);
    assert.equal(E(undefined), undefined);
  });

  it('extractTurnPrompt reads the last user message across body shapes', () => {
    const E = CaptureRecorder.extractTurnPrompt;
    // OpenAI chat: last user message wins over the opening one
    assert.equal(E({ messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'second' }] }), 'second');
    // Anthropic tool-result continuation tail: text-less user tail is the turn
    // itself — must NOT fall through to the previous turn's user text
    assert.equal(
      E({ messages: [{ role: 'user', content: 'older turn' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }] }),
      undefined
    );
    // Text-part array tail still resolves
    assert.equal(E({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'responses tail' }] }] }), 'responses tail');
    // Newlines flattened, capped with ellipsis
    const long = 'y'.repeat(300);
    const capped = E({ messages: [{ role: 'user', content: long }] })!;
    assert.equal(capped.length, 120);
    assert.ok(capped.endsWith('…'));
    // No user text at all
    assert.equal(E({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }), undefined);
    assert.equal(E({}), undefined);
  });

  it('listSessions surfaces the session preview', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await writeRequest(rec, {
        sessionId: 'sess_p',
        wire: { ...WIRE, requestBody: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '第一条用户消息' }] }) },
      });
      await writeRequest(rec, {
        sessionId: 'sess_p', requestId: 'req_p_2',
        wire: { ...WIRE, requestBody: JSON.stringify({ messages: [{ role: 'user', content: '第二条不覆盖预览' }] }) },
      });
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.preview, '第一条用户消息');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('scopes harness vocabulary and declared prompts from the ARCHIVED headers', async () => {
    // Both the write-time stamp and the read-time preview resolve the harness
    // profile (and any declared prompt) from the request headers stored in the
    // archive, so a replayed session resolves exactly what its live turn saw.
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 65536 });

      // The measured Claude Code opening request (capture session
      // cc_c6a59aae): ONE message mixing `<system-reminder>` with the human
      // prompt, then the SessionStart hook output as the LAST user message —
      // which is what the per-turn stamp reads.
      const opening = JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '<system-reminder>git attribution boilerplate</system-reminder>' },
              { type: 'text', text: '你是谁' },
            ],
          },
          {
            role: 'user',
            content: 'SessionStart:clear hook success: <EXTREMELY_IMPORTANT>runbook</EXTREMELY_IMPORTANT>',
          },
        ],
      });
      await writeRequest(rec, {
        sessionId: 'sess_cc',
        wire: {
          ...WIRE,
          requestHeaders: { 'user-agent': 'claude-cli/2.1.317 (external, cli)' },
          requestBody: opening,
        },
      });
      // Same bytes from an unprofiled client: the hook convention is PLAIN
      // TEXT with no structural signal, so only the profile can blank it.
      await writeRequest(rec, {
        sessionId: 'sess_other',
        wire: {
          ...WIRE,
          requestHeaders: { 'user-agent': 'my-own-client/1.0' },
          requestBody: opening,
        },
      });
      // A self-declared prompt wins outright over any inference.
      await writeRequest(rec, {
        sessionId: 'sess_declared',
        wire: {
          ...WIRE,
          requestHeaders: { 'x-ocr-prompt-hint': '把校验逻辑改一下' },
          requestBody: JSON.stringify({
            messages: [
              { role: 'user', content: '<environment_context><cwd>D:\\r</cwd></environment_context>' },
            ],
          }),
        },
      });

      // Write plane: the stamped promptSummary on the client-request line.
      const stampOf = (sessionId: string): string | undefined => {
        const file = path.join(
          dir,
          CaptureRecorder.localDateDir(new Date()),
          CaptureRecorder.sessionFileName(sessionId)
        );
        for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
          const ev = JSON.parse(line);
          if (ev.direction === 'client' && ev.phase === 'request') return ev.promptSummary;
        }
        return undefined;
      };
      assert.equal(stampOf('sess_cc'), undefined, 'hook output is no prompt for a profiled client');
      assert.ok(
        String(stampOf('sess_other')).includes('SessionStart:clear hook success'),
        'another client sees the same text verbatim'
      );
      assert.equal(stampOf('sess_declared'), '把校验逻辑改一下');

      // Read plane: session previews resolve from the same archived headers.
      // First HUMAN text is structural (rule 4), so both clients agree here.
      const previewOf = (sessionId: string): string | undefined =>
        rec.listSessions(rec.listDates()[0].date).find(s => s.sessionId === sessionId)?.preview;
      assert.equal(previewOf('sess_cc'), '你是谁');
      assert.equal(previewOf('sess_other'), '你是谁');
      assert.equal(previewOf('sess_declared'), '把校验逻辑改一下');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('listSessions tallies event-stream files per REQUEST (not per event line)', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 4096 });
      const wire = { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' };
      // Turn 1 (ok): full 4-event cycle.
      for (const [direction, phase, exchangeId] of [
        ['client', 'request', 's1'], ['upstream', 'request', 's2'],
        ['upstream', 'response', 's2'], ['client', 'response', 's1'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, exchangeId, requestId: 't1',
          sessionId: 'sess_evt', model: 'auto', status: 'ok',
          wire: direction === 'client' && phase === 'request'
            ? { ...wire, requestBody: JSON.stringify({ messages: [{ role: 'user', content: '事件流预览文本' }] }) }
            : wire,
        });
      }
      // Turn 2 (failed): upstream response is an error → ONE failed turn,
      // even though a gateway-response error event also carries the requestId.
      for (const [direction, phase, exchangeId, status] of [
        ['client', 'request', 's3', 'ok'], ['upstream', 'request', 's4', 'ok'],
        ['upstream', 'response', 's4', 'error'], ['client', 'response', 's3', 'error'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, exchangeId, requestId: 't2',
          sessionId: 'sess_evt', model: 'auto', status, wire,
        });
      }
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.requests, 2, '8 event lines = 2 requests');
      assert.equal(row.failed, 1, 'failed counts requests, not error events');
      assert.equal(row.lastStatus, 'error');
      assert.equal(row.preview, '事件流预览文本');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('findBySession matches safe and hashed ids across dates', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 365, maxTotalMB: 512, maxBodyBytes: 1024 });
      await writeRequest(rec, { sessionId: 'sess_find' });
      // Same session id on a previous local day (hand-made extra date dir)
      const today = rec.listDates()[0].date;
      const yesterday = new Date(new Date().getTime() - 86_400_000).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(dir, yesterday), { recursive: true });
      fs.writeFileSync(path.join(dir, yesterday, 'sess_find.jsonl'), '{"status":"ok"}\n');
      // Unsafe id → hashed file name must still match the raw id
      const evil = '{"device_id":"x","session_id":"<uuid>"}';
      await writeRequest(rec, { sessionId: evil });

      const safe = rec.findBySession('sess_find');
      assert.equal(safe.length, 2);
      assert.deepEqual(safe.map(m => m.date).sort(), [today, yesterday].sort());
      assert.ok(safe.every(m => m.file === 'sess_find.jsonl'));

      const hashed = rec.findBySession(evil);
      assert.equal(hashed.length, 1);
      assert.ok(hashed[0].file.startsWith('h_'), `expected hashed archive, got ${hashed[0].file}`);

      assert.deepEqual(rec.findBySession('sess_missing'), []);
      assert.deepEqual(rec.findBySession(''), []);
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });
});

describe('CaptureRecorder HTTP exchange event stream', () => {
  let tmp: string;
  let recorder: CaptureRecorder;
  let turnSeq = 0;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 512,
      maxBodyBytes: 1024,
    });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  const promptBody = (correlationId: string, prompt?: string): string =>
    JSON.stringify({ messages: [{ role: 'user', content: prompt ?? `prompt ${correlationId}` }] });

  // Helper: emit one full REQUEST (4 events) into the recorder. Every event
  // carries the SAME write-time turn identity — the admission gate allocates
  // it once and no reader ever re-derives it.
  async function emitOneRequest(
    correlationId: string,
    sessionId: string,
    model: string,
    opts: {
      inboundStatus?: number;
      outboundStatus?: number;
      outboundError?: string;
      turnIndex?: number | null;
      isPromptStart?: boolean;
      prompt?: string;
    } = {}
  ): Promise<{ wireId: string }> {
    const wireId = `wire_${correlationId}`;
    const turnIndex = opts.turnIndex === undefined ? ++turnSeq : opts.turnIndex;
    const turn = {
      turnIndex,
      isPromptStart: opts.isPromptStart ?? (turnIndex !== null),
      turnDecision: turnIndex === null
        ? 'no_prompt'
        : opts.isPromptStart === false ? 'continuation' : 'new_prompt',
    } as const;
    // 1. Client request — fires synchronously the moment the handler
    //    enters the orchestrator.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      ...turn,
      exchangeId: wireId,
      requestId: correlationId,
      sessionId,
      model,
      status: 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: { 'user-agent': 'omnicell-router/test', authorization: '[REDACTED]' },
        requestBody: promptBody(correlationId, opts.prompt),
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    });
    // 2. Upstream request — fires before the provider fetch.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'upstream',
      phase: 'request',
      ...turn,
      exchangeId: `${wireId}_out`,
      requestId: correlationId,
      sessionId,
      model,
      status: 'ok',
      wire: {
        requestLine: 'POST https://api.example/v1/chat/completions HTTP/1.1',
        requestHeaders: { authorization: '[REDACTED]', 'content-type': 'application/json' },
        requestBody: '{"model":"upstream-model","messages":[]}',
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    });
    // 3. Upstream response — fires after `await res.text()`.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'upstream',
      phase: 'response',
      ...turn,
      exchangeId: `${wireId}_out`,
      requestId: correlationId,
      sessionId,
      model,
      status: opts.outboundError ? 'error' : 'ok',
      wire: {
        requestLine: 'POST https://api.example/v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: '',
        responseLine: `HTTP/1.1 ${opts.outboundStatus ?? 200} OK`,
        status: opts.outboundStatus ?? 200,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"choices":[]}',
      },
      ...(opts.outboundError ? { error: opts.outboundError } : {}),
    });
    // 4. Gateway response — fires in the Fastify onResponse hook.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'response',
      ...turn,
      exchangeId: wireId,
      requestId: correlationId,
      sessionId,
      model,
      status: opts.inboundStatus && opts.inboundStatus >= 400 ? 'error' : 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: '',
        responseLine: `HTTP/1.1 ${opts.inboundStatus ?? 200} OK`,
        status: opts.inboundStatus ?? 200,
        responseHeaders: {},
        responseBody: '',
      },
    });
    return { wireId };
  }

  it('writes exactly 4 events per request (inbound-req/res + outbound-req/res)', async () => {
    const sessionIdA = 'sess_events_aaa';
    const sessionIdB = 'sess_events_bbb';
    await emitOneRequest('corr_aaa', sessionIdA, 'lite');
    await emitOneRequest('corr_bbb', sessionIdB, 'plus');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const contentA = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdA}.jsonl`), 'utf8');
    const linesA = contentA.split('\n').filter(l => l.trim());
    assert.equal(linesA.length, 4, 'turn A writes 4 events into its own session file');
    const contentB = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdB}.jsonl`), 'utf8');
    const linesB = contentB.split('\n').filter(l => l.trim());
    assert.equal(linesB.length, 4, 'turn B writes 4 events into its own session file');
  });

  it('groups events into logical requests by requestId (groupEventsIntoRequests)', () => {
    const requestId = 'trace_grp_1';
    const events = [
      // client req (ts 1000)
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      // upstream req (ts 1005)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w2', id: 'b', ts: 1005, wire: emptyWire() } as any,
      // upstream resp (ts 1500)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w2', id: 'c', ts: 1500, wire: emptyWire() } as any,
      // client resp (ts 1520)
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'd', ts: 1520, wire: emptyWire() } as any,
    ];
    const requests = CaptureRecorder.groupEventsIntoRequests(events);
    assert.equal(requests.length, 1);
    const t = requests[0];
    assert.equal(viewOf(t).clientRequest?.id, 'a');
    assert.equal(viewOf(t).upstreamRequest?.id, 'b');
    assert.equal(viewOf(t).upstreamResponse?.id, 'c');
    assert.equal(viewOf(t).clientResponse?.id, 'd');
    assert.equal(viewOf(t).upstreamLatencyMs, 1500 - 1005);
    assert.equal(viewOf(t).gatewayLatencyMs, 1520 - 1000);
    // No firstByteTs on the events → no TTFT/decode split is synthesized.
    assert.equal(viewOf(t).upstreamTtftMs, undefined);
    assert.equal(viewOf(t).upstreamGenMs, undefined);
    assert.equal(viewOf(t).gatewayTtftMs, undefined);
    assert.equal(viewOf(t).gatewayGenMs, undefined);
  });

  it('keeps two requests apart when the caller reuses ONE clientRequestId (ADR-0021)', () => {
    // Field shape: one client reuses a single traceparent trace-id for a whole
    // conversation. Capture turns key on the gateway requestId, so the two
    // requests stay two turns instead of merging into one.
    const clientRequestId = '570cec004726436b8a6abb220f621bff';
    const mk = (
      requestId: string,
      exchangeId: string,
      id: string,
      ts: number,
      direction: 'client' | 'upstream',
      phase: 'request' | 'response'
    ) =>
      ({ eventType: 'http-exchange', direction, phase, requestId, exchangeId, clientRequestId, sessionId: 's', model: 'auto', status: 'ok', id, ts, wire: emptyWire() } as any);
    const events = [
      mk('req_a', 'a1', 'a-req', 1000, 'client', 'request'),
      mk('req_a', 'a2', 'a-up-req', 1005, 'upstream', 'request'),
      mk('req_a', 'a2', 'a-up-res', 1500, 'upstream', 'response'),
      mk('req_a', 'a1', 'a-res', 1520, 'client', 'response'),
      mk('req_b', 'b1', 'b-req', 2000, 'client', 'request'),
      mk('req_b', 'b2', 'b-up-req', 2005, 'upstream', 'request'),
      mk('req_b', 'b2', 'b-up-res', 2500, 'upstream', 'response'),
      mk('req_b', 'b1', 'b-res', 2520, 'client', 'response'),
    ];
    const requests = CaptureRecorder.groupEventsIntoRequests(events);
    assert.equal(requests.length, 2, 'one turn per request, not per caller correlation value');
    assert.deepEqual(requests.map(t => t.requestId), ['req_a', 'req_b']);
    assert.equal(viewOf(requests[0]).clientResponse?.id, 'a-res');
    assert.equal(viewOf(requests[1]).clientResponse?.id, 'b-res');
    assert.equal(viewOf(requests[0]).upstreamLatencyMs, 1500 - 1005);
    assert.equal(viewOf(requests[1]).upstreamLatencyMs, 2500 - 2005);
    assert.ok(requests.every(t => t.clientRequestId === clientRequestId), 'correlation value carried over');
  });

  it('keeps the l2-decision leg in separate slots (not overwritten by the serving leg)', () => {
    // One routed turn with an L2 decision leg: decision req/resp fire FIRST, then
    // the serving upstream pair. The decision pair must survive in its own
    // decisionRequest/decisionResponse slots — the serving leg's last-write-wins
    // merge must never erase it, and neither pair may pollute the other.
    const requestId = 'trace_grp_decision';
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      // decision req/resp (purpose l2-decision, its own exchangeId)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId, sessionId: 's', model: 'l2-decision-model', status: 'ok', exchangeId: 'w2', id: 'j1', ts: 1005, purpose: 'l2-decision', wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId, sessionId: 's', model: 'l2-decision-model', status: 'ok', exchangeId: 'w2', id: 'j2', ts: 1300, firstByteTs: 1200, purpose: 'l2-decision', wire: emptyWire() } as any,
      // serving upstream req/resp
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w3', id: 'b', ts: 1310, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w3', id: 'c', ts: 1500, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'd', ts: 1520, wire: emptyWire() } as any,
    ];
    const t = CaptureRecorder.groupEventsIntoRequests(events)[0];
    assert.equal(viewOf(t).decisionRequest?.id, 'j1');
    assert.equal(viewOf(t).decisionResponse?.id, 'j2');
    // Serving slots keep the serving leg, not the L2 decision leg.
    assert.equal(viewOf(t).upstreamRequest?.id, 'b');
    assert.equal(viewOf(t).upstreamResponse?.id, 'c');
    assert.equal(viewOf(t).decisionLatencyMs, 1300 - 1005);
    assert.equal(viewOf(t).decisionTtftMs, 1200 - 1005);
    assert.equal(viewOf(t).decisionGenMs, 1300 - 1200);
    assert.equal(viewOf(t).upstreamLatencyMs, 1500 - 1310);
    // Still ONE logical turn — the L2 decision leg must not inflate turn counts.
    assert.equal(CaptureRecorder.groupEventsIntoRequests(events).length, 1);
  });

  it('derives TTFT and decode window from firstByteTs (TTFT/TPS split)', () => {
    const requestId = 'trace_grp_2';
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w2', id: 'b', ts: 1005, wire: emptyWire() } as any,
      // Upstream response: first chunk at 1150, fully received at 1500
      // → upstream TTFT = 145, decode window = 350.
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w2', id: 'c', ts: 1500, firstByteTs: 1150, wire: emptyWire() } as any,
      // Gateway response: first chunk to the client at 1180, finalized 1520
      // → gateway TTFT = 180, decode window = 340.
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId, sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'w1', id: 'd', ts: 1520, firstByteTs: 1180, wire: emptyWire() } as any,
    ];
    const t = CaptureRecorder.groupEventsIntoRequests(events)[0];
    assert.equal(viewOf(t).upstreamTtftMs, 1150 - 1005);
    assert.equal(viewOf(t).upstreamGenMs, 1500 - 1150);
    assert.equal(viewOf(t).gatewayTtftMs, 1180 - 1000);
    assert.equal(viewOf(t).gatewayGenMs, 1520 - 1180);
  });

  it('records request event BEFORE response event (request-event independence)', async () => {
    // The core invariant the user asked for: "if you sent a request,
    // record it; you don't have to wait for the response." We test by
    // checking that the client-request line in the JSONL appears BEFORE
    // the client-response line for the same exchangeId.
    const sessionId = 'sess_indep';
    const wireId = 'wire_indep';
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'request',
      exchangeId: wireId, requestId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST /x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    // Provider throws — emit a failure response. The REQUEST must already
    // be on disk even though the response is a failure.
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      exchangeId: 'w_out', requestId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST https://x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'response',
      exchangeId: 'w_out', requestId: 'c1', sessionId, model: 'auto',
      status: 'error',
      wire: { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: 'HTTP/1.1 503 Service Unavailable', status: 503, responseHeaders: {}, responseBody: '' },
      error: 'upstream 503',
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'response',
      exchangeId: wireId, requestId: 'c1', sessionId, model: 'auto',
      status: 'error',
      wire: { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: 'HTTP/1.1 502 Bad Gateway', status: 502, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    assert.equal(lines.length, 4);
    const req = JSON.parse(lines[0]);
    const res = JSON.parse(lines[3]);
    assert.equal(req.phase, 'request');
    assert.equal(req.direction, 'client');
    assert.equal(res.phase, 'response');
    assert.equal(res.direction, 'client');
    assert.equal(req.exchangeId, res.exchangeId);
    assert.equal(req.requestId, res.requestId);
    // Failure is durable on both sides.
    const outRes = JSON.parse(lines[2]);
    assert.equal(outRes.status, 'error');
    assert.equal(outRes.error, 'upstream 503');
    assert.equal(outRes.direction, 'upstream');
  });

  it('readEvents groups by correlationId and computes per-direction latency', async () => {
    const sessionId = 'sess_read_events';
    // Two turns, sequential — same sessionId so both land in one JSONL.
    await emitOneRequest('corr_read_1', sessionId, 'lite');
    await emitOneRequest('corr_read_2', sessionId, 'plus');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100);
    assert.equal(result.requests.length, 2);
    assert.equal(result.events.length, 8);
    // The header's turn tally must be the grouped count, not raw event
    // lines (4 lines per turn here — labelling totalLines as turns 4x's it).
    assert.equal(result.totalLines, 8);
    assert.equal(result.totalTurns, 2);
    // Each turn has all four events paired.
    for (const t of result.requests) {
      assert.ok(viewOf(t).clientRequest && viewOf(t).clientResponse && viewOf(t).upstreamRequest && viewOf(t).upstreamResponse,
        `turn ${t.requestId} missing event pair`);
      assert.equal(viewOf(t).clientRequest!.exchangeId, viewOf(t).clientResponse!.exchangeId);
      assert.equal(viewOf(t).upstreamRequest!.exchangeId, viewOf(t).upstreamResponse!.exchangeId);
    }
  });

  it('readEvents pages backwards in requests without overlap or gaps', async () => {
    const sessionId = 'sess_read_paging';
    await emitOneRequest('corr_page_1', sessionId, 'lite');
    await emitOneRequest('corr_page_2', sessionId, 'lite');
    await emitOneRequest('corr_page_3', sessionId, 'lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;

    // 3 requests at 1 per page = 3 pages, counted BACK from the newest end.
    const p1 = await recorder.readEvents(dateDir, file, 1, 'none', 1);
    assert.equal(p1.requests.length, 1);
    assert.equal(p1.requests[0].requestId, 'corr_page_3');
    assert.equal(p1.totalTurns, 3, 'the header tally still covers the whole window');
    assert.equal(p1.page, 1);
    assert.equal(p1.requests[0].requestNumber, 3, 'request numbering is chronological over the window');
    assert.equal(p1.totalPages, 3);
    assert.equal(p1.hasOlder, true);
    assert.equal(p1.hasNewer, false);
    // A page carries ALL FOUR legs of its turn — never a sliced turn.
    assert.equal(p1.events.length, 4);

    const p2 = await recorder.readEvents(dateDir, file, 1, 'none', 2);
    assert.equal(p2.requests.length, 1);
    assert.equal(p2.requests[0].requestId, 'corr_page_2');
    assert.equal(p2.hasOlder, true);
    assert.equal(p2.hasNewer, true);

    // Last page reaches the window floor: nothing older.
    const p3 = await recorder.readEvents(dateDir, file, 1, 'none', 3);
    assert.equal(p3.requests.length, 1);
    assert.equal(p3.requests[0].requestId, 'corr_page_1');
    assert.equal(p3.hasOlder, false);
    assert.equal(p3.hasNewer, true);

    // No overlap between pages (each turn appears exactly once).
    const traces = [...p1.requests, ...p2.requests, ...p3.requests].map(t => t.requestId);
    assert.deepEqual(new Set(traces).size, 3);

    // Out-of-range pages clamp to the window instead of answering empty.
    const high = await recorder.readEvents(dateDir, file, 1, 'none', 99);
    assert.equal(high.page, 3);
    assert.equal(high.requests[0].requestId, 'corr_page_1');
    const low = await recorder.readEvents(dateDir, file, 1, 'none', 0);
    assert.equal(low.page, 1);
  });

  it('captureSummary indexes WRITE-TIME turns across the whole file', async () => {
    const sessionId = 'sess_count_requests';
    // Turn 1 = a prompt plus its tool-result continuation; turn 2 = one new
    // prompt; the fourth request has NO prompt and belongs to no turn.
    await emitOneRequest('c1', sessionId, 'lite', { turnIndex: 1, prompt: 'first question' });
    await emitOneRequest('c2', sessionId, 'lite', { turnIndex: 1, isPromptStart: false });
    await emitOneRequest('c3', sessionId, 'lite', { turnIndex: 2, prompt: 'second question' });
    await emitOneRequest('c4', sessionId, 'lite', { turnIndex: null });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const summary = await recorder.captureSummary(dateDir, file);
    assert.equal(summary.requests, 4, 'one client-request line = one request');
    assert.deepEqual(
      summary.turns.map(r => [r.turnIndex, r.firstRequest, r.lastRequest, r.requests, r.prompt]),
      [
        [1, 1, 2, 2, 'first question'],
        [2, 3, 3, 1, 'second question'],
      ]
    );
    const page1 = await recorder.readEvents(dateDir, file, 1, 'none', 1);
    assert.equal(page1.requests.length, 1);
    assert.equal(page1.totalRequests, 4);
    assert.equal(page1.totalTurns, 2, 'distinct write-time turn ordinals, not requests');
    const missing = await recorder.captureSummary(dateDir, 'nope.jsonl');
    assert.equal(missing.requests, 0);
    assert.deepEqual(missing.turns, []);
  });

  it('captureSummary recounts after the archive grows (cache is stat-keyed)', async () => {
    const sessionId = 'sess_count_grows';
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    await emitOneRequest('g1', sessionId, 'lite', { turnIndex: 90 });
    const first = await recorder.captureSummary(dateDir, file);
    assert.equal(first.requests, 1);
    // Appending changes the file stat, so the second scan must not serve the
    // cached tally — a stale cache would freeze the console header forever.
    await emitOneRequest('g2', sessionId, 'lite', { turnIndex: 90, isPromptStart: false });
    const second = await recorder.captureSummary(dateDir, file);
    assert.equal(second.requests, 2);
    assert.deepEqual(
      second.turns.map(r => [r.turnIndex, r.firstRequest, r.lastRequest, r.requests]),
      [[90, 1, 2, 2]],
      'the grown archive is re-indexed, not merged with the cached turn'
    );
  });

  it('read plane copies the WRITE-TIME turn identity; no prompt heuristic', async () => {
    const sessionId = 'sess_prompt_written';
    // Identical bodies, DIFFERENT write-time verdicts. A reader that guessed
    // from text would collapse these into one turn; the archive says two.
    for (const [i, turnIndex, start] of [
      [0, 1, true], [1, 1, false], [2, 2, true],
    ] as const) {
      await recorder.recordEvent({
        eventType: 'http-exchange', direction: 'client', phase: 'request',
        exchangeId: `pw_${i}`, requestId: `pw_req_${i}`, sessionId, model: 'auto', status: 'ok',
        turnIndex, isPromptStart: start,
        turnDecision: start ? 'new_prompt' : 'continuation',
        wire: {
          ...WIRE,
          requestBody: JSON.stringify({ messages: [{ role: 'user', content: 'same resent prompt' }] }),
        },
      });
    }
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100, 'none');
    assert.deepEqual(result.requests.map(r => r.turnIndex), [1, 1, 2]);
    assert.deepEqual(result.requests.map(r => r.isPromptStart), [true, false, true]);
    assert.deepEqual(result.requests.map(r => r.turnDecision), ['new_prompt', 'continuation', 'new_prompt']);
    assert.equal(result.totalTurns, 2);
    assert.equal(result.requests[0].promptSummary, 'same resent prompt');
    assert.equal(result.requests[1].promptSummary, undefined, 'continuation never gets a prompt stamp');
    const summary = await recorder.captureSummary(dateDir, file);
    assert.deepEqual(summary.turns.map(r => [r.turnIndex, r.requests]), [[1, 2], [2, 1]]);
  });

  it('a prompt-less request has turnIndex: null and joins no turn', async () => {
    const sessionId = 'sess_no_prompt';
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'request',
      exchangeId: 'np_1', requestId: 'np_req_1', sessionId, model: 'auto', status: 'ok',
      turnIndex: null, isPromptStart: false, turnDecision: 'no_prompt',
      wire: { ...WIRE, requestBody: '{}' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100, 'none');
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].turnIndex, null);
    assert.equal(result.totalTurns, 0);
    const summary = await recorder.captureSummary(dateDir, file);
    assert.equal(summary.requests, 1);
    assert.deepEqual(summary.turns, []);
  });

  it('rejects archive lines that lack the schema-2 turn identity', async () => {
    // Schema-2 is a hard cutover: the pre-cutover schema-1 archives are
    // upgraded in place by the boot migration pass (see
    // capture/migrate/steps/v1-to-v2.ts). A line that is still schema-1 has
    // not been through it, so the reader rejects it: no field mapping, no
    // derived fallback at read time.
    const sessionId = 'sess_schema1';
    const dateDir = CaptureRecorder.localDateDir(new Date());
    fs.mkdirSync(path.join(tmp, dateDir), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, dateDir, `${sessionId}.jsonl`),
      JSON.stringify({
        id: 'evt_old', ts: Date.now(), eventType: 'http-exchange',
        direction: 'client', phase: 'request', exchangeId: 'old_ex',
        requestId: 'old_req', sessionId, model: 'auto', status: 'ok',
        promptSummary: 'old prompt', wire: WIRE,
      }) + '\n',
      'utf8'
    );
    const result = await recorder.readEvents(dateDir, `${sessionId}.jsonl`, 100, 'none');
    assert.equal(result.totalLines, 0);
    assert.equal(result.requests.length, 0);
  });

  it('groupEventsIntoRequests keeps every failover ATTEMPT as its own exchange', () => {
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId: 'R', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'c1', id: 'c1', ts: 1000, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId: 'R', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'u1', id: 'u1', ts: 1010, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId: 'R', sessionId: 's', model: 'auto', status: 'error', exchangeId: 'u1', id: 'u1r', ts: 1100, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', requestId: 'R', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'u2', id: 'u2', ts: 1110, attempt: 2, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', requestId: 'R', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'u2', id: 'u2r', ts: 1500, attempt: 2, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId: 'R', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'c1', id: 'c1r', ts: 1520, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
    ] as unknown as CaptureEvent[];
    const r = CaptureRecorder.groupEventsIntoRequests(events)[0];
    assert.equal(r.exchanges.length, 3, 'client + two upstream hops');
    assert.deepEqual(r.exchanges.filter(e => e.leg === 'upstream').map(e => e.attempt), [1, 2]);
    assert.equal(primaryExchange(r, 'upstream')?.response?.id, 'u2r', 'last hop serves the client');
    assert.equal(r.turnIndex, 1);
    assert.equal(r.isPromptStart, true);
  });

  it('readEvents bodies=none strips wire bodies, keeps lines/status/headers', async () => {
    const sessionId = 'sess_read_none';
    await emitOneRequest('corr_none_1', sessionId, 'lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100, 'none');
    assert.equal(result.requests.length, 1);
    const t = result.requests[0];
    assert.ok(viewOf(t).clientRequest && viewOf(t).clientResponse && viewOf(t).upstreamRequest && viewOf(t).upstreamResponse);
    // Bodies stripped — metadata-first reads ship KBs, not MBs.
    assert.equal(viewOf(t).clientRequest!.wire.requestBody, undefined);
    assert.equal(viewOf(t).upstreamResponse!.wire.responseBody, undefined);
    // Lines, status and headers survive for metadata rendering.
    assert.equal(viewOf(t).clientRequest!.wire.requestLine, 'POST /v1/chat/completions HTTP/1.1');
    assert.equal(viewOf(t).clientResponse!.wire.status, 200);
    assert.equal(viewOf(t).upstreamRequest!.wire.requestHeaders['content-type'], 'application/json');
    // Full read of the same archive still carries the bodies.
    const full = await recorder.readEvents(dateDir, file, 100, 'full');
    assert.equal(viewOf(full.requests[0]).clientRequest!.wire.requestBody, promptBody('corr_none_1'));
  });

  it('readEvents bodies=chat keeps round-opener requests + response bodies', async () => {
    const sessionId = 'sess_read_chat';
    await emitOneRequest('corr_chat_1', sessionId, 'lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100, 'chat');
    const t = result.requests[0];
    // The first request seeds history and stays; its upstream twin is dropped.
    assert.equal(viewOf(t).clientRequest!.wire.requestBody, promptBody('corr_chat_1'));
    assert.equal(viewOf(t).upstreamRequest!.wire.requestBody, undefined);
    // Response bodies feed the replay's assistant output.
    assert.equal(viewOf(t).upstreamResponse!.wire.responseBody, '{"choices":[]}');
  });

  it('readEvents derives completionTokens from the last usage block', async () => {
    const sessionId = 'sess_read_tokens';
    await emitOneRequest('corr_tok_1', sessionId, 'lite');
    // Streaming-style body: usage repeats per chunk, the LAST occurrence is
    // the cumulative total.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      exchangeId: 'wire_tok_2',
      requestId: 'corr_tok_2',
      sessionId,
      model: 'lite',
      status: 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: '{}',
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    });
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'response',
      exchangeId: 'wire_tok_2',
      requestId: 'corr_tok_2',
      sessionId,
      model: 'lite',
      status: 'ok',
      wire: {
        requestLine: '',
        requestHeaders: {},
        requestBody: '',
        responseLine: 'HTTP/1.1 200 OK',
        status: 200,
        responseHeaders: {},
        responseBody: 'data: {"usage":{"output_tokens":5}}\ndata: {"usage":{"output_tokens":42}}',
      },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100);
    const t = result.requests.find(x => x.requestId === 'corr_tok_2');
    assert.ok(t && viewOf(t).clientResponse);
    assert.equal(viewOf(t!).clientResponse!.completionTokens, 42);
  });

  it('readRequest resolves a request by its event id OR by the requestId; unknown keys answer null', async () => {
    const sessionId = 'sess_read_turn';
    await emitOneRequest('corr_turn_1', sessionId, 'lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const meta = await recorder.readEvents(dateDir, file, 100, 'none');
    const clientReqId = viewOf(meta.requests[0]).clientRequest!.id;
    const res = await recorder.readRequest(dateDir, file, clientReqId);
    assert.ok(res);
    assert.equal(res!.request.requestId, 'corr_turn_1');
    // Full bodies restored — this is the per-turn fetch behind the drawer.
    assert.equal(viewOf(res!.request).clientRequest!.wire.requestBody, promptBody('corr_turn_1'));
    assert.equal(viewOf(res!.request).upstreamResponse!.wire.responseBody, '{"choices":[]}');
    // The console keys the drawer on the TURN id (what the row carries and
    // every React key uses), not on an internal event id — both must resolve.
    const byTurnId = await recorder.readRequest(dateDir, file, meta.requests[0].requestId);
    assert.ok(byTurnId);
    assert.equal(viewOf(byTurnId!.request).clientRequest!.wire.requestBody, promptBody('corr_turn_1'));
    assert.equal(viewOf(byTurnId!.request).clientResponse!.id, viewOf(res!.request).clientResponse!.id);
    assert.equal(await recorder.readRequest(dateDir, file, 'evt_missing'), null);
  });

  it('truncates oversized wire bodies (UTF-8 path)', async () => {
    const sessionId = 'sess_truncate';
    const bigBody = 'x'.repeat(2048); // > maxBodyBytes (1024)
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      exchangeId: 'w_out', requestId: 'corr_t', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST x HTTP/1.1', requestHeaders: {}, requestBody: bigBody, responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const line = content.split('\n').filter(l => l.trim())[0];
    const obj = JSON.parse(line);
    assert.ok(obj.truncated === true, 'truncated flag must be set');
    const stored = obj.wire.requestBody;
    assert.ok(typeof stored === 'string' && stored.length <= 1024 + '...[TRUNCATED]'.length);
    assert.ok(stored.endsWith('...[TRUNCATED]'));
  });

  it('truncates on a BYTE boundary (CJK body never exceeds the byte budget)', async () => {
    const sessionId = 'sess_truncate_cjk';
    // 600 CJK chars = 1800 UTF-8 bytes > 1024 budget. A code-unit slice
    // would store 1024 chars ≈ 3072 bytes (3× over budget).
    const bigBody = '汉'.repeat(600);
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      exchangeId: 'w_cjk', requestId: 'corr_cjk', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST x HTTP/1.1', requestHeaders: {}, requestBody: bigBody, responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const line = content.split('\n').filter(l => l.trim())[0];
    const obj = JSON.parse(line);
    assert.ok(obj.truncated === true);
    const stored = obj.wire.requestBody as string;
    assert.ok(stored.endsWith('...[TRUNCATED]'));
    const bodyPart = stored.slice(0, -'...[TRUNCATED]'.length);
    assert.ok(Buffer.byteLength(bodyPart, 'utf8') <= 1024, `byte budget respected, got ${Buffer.byteLength(bodyPart, 'utf8')}`);
  });
});

describe('CaptureRecorder hardening (code-review findings)', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({ enabled: true, dir: tmp, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
  });
  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('redacts credential header VALUES (incl. vendor -key headers) and query auth, keeps names', async () => {
    const { emitUpstreamRequest } = await import('../src/observability/http-exchange.js');
    const sessionId = 'sess_redact';
    emitUpstreamRequest({
      recorder,
      url: 'https://api.example/v1/chat?key=AIzaSySecretKey&foo=bar',
      method: 'POST',
      requestHeaders: {
        Authorization: 'Bearer sk-real-secret',
        'x-api-key': 'real-api-key',
        'x-goog-api-key': 'real-google-key',
        'Ocp-Apim-Subscription-Key': 'real-azure-key',
        'X-Functions-Key': 'real-func-key',
        'content-type': 'application/json',
      },
      requestBody: '{}',
      sessionId,
      requestId: 'trace_redact',
      model: 'auto',
      proxy: 'http://user:pass@proxy.local:8080',
    });
    await new Promise(r => setTimeout(r, 100));
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const ev = JSON.parse(content.split('\n').filter(l => l.trim())[0]);
    // Proxy recorded as redacted origin — userinfo never persists.
    assert.equal(ev.proxy, 'http://proxy.local:8080');
    assert.ok(!content.includes('user:pass'), 'proxy credentials must never persist');
    const h = ev.wire.requestHeaders;
    // Header NAMES kept, VALUES redacted — "you sent an x-api-key" must
    // remain visible for debugging auth failures.
    assert.deepEqual(h, {
      authorization: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      'x-goog-api-key': '[REDACTED]',
      'ocp-apim-subscription-key': '[REDACTED]',
      'x-functions-key': '[REDACTED]',
      'content-type': 'application/json',
    });
    // Query-string auth redacted; non-auth params preserved.
    assert.ok(!ev.wire.requestLine.includes('AIzaSySecretKey'), 'raw query key must never persist');
    assert.ok(ev.wire.requestLine.includes('foo=bar'));
    // Upstream request line is absolute-form: the provider HOST is visible
    // so the archive shows which endpoint was dialed.
    assert.ok(ev.wire.requestLine.startsWith('POST https://'), ev.wire.requestLine);
    assert.ok(ev.wire.requestLine.includes('api.example'), ev.wire.requestLine);
    // No raw credential anywhere in the whole line.
    assert.ok(!content.includes('sk-real-secret') && !content.includes('real-api-key') && !content.includes('real-azure-key'));
  });

  it('redacts apikey/apiKey/auth/sig query params in BOTH url forms', async () => {
    // F2 (security P2-2): word-boundary matching cannot see through the
    // compound `apikey` (the 'i' before 'key' is a letter) nor the bare
    // `auth`/`sig` params — all four must redact in the request line, on
    // absolute-form (emitUpstreamRequest) AND origin-form (emitClientRequest).
    // `signature` was already covered (longer alternation wins); `monkey`,
    // `keywords`, `foo` must stay byte-identical (no mangling).
    const { emitUpstreamRequest, emitClientRequest } = await import(
      '../src/observability/http-exchange.js'
    );
    const sessionId = 'sess_redact_query';
    emitUpstreamRequest({
      recorder,
      url:
        'https://api.example/v1/chat?apikey=sk-abs-1&apiKey=sk-abs-2&auth=xyzabs&sig=abcabs&' +
        'foo=bar&monkey=see&keywords=seo&signature=sigrabs&token=tkabs&secret=scabs',
      method: 'POST',
      requestHeaders: {},
      requestBody: '{}',
      sessionId,
      requestId: 'trace_redact_query',
      model: 'auto',
    });
    emitClientRequest({
      recorder,
      req: {
        method: 'POST',
        url: '/v1/chat?apikey=sk-rel-1&auth=xyzrel&sig=abcrel&foo=bar',
        headers: {},
      },
      body: { marker: 'origin-form' },
      sessionId,
      requestId: 'trace_redact_query',
      model: 'auto',
    });
    await new Promise((r) => setTimeout(r, 100));
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const content = fs.readFileSync(path.join(tmp, dateDir, `${sessionId}.jsonl`), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const absEv = lines.find((ev) => String(ev.wire.requestLine).startsWith('POST https://api.example'));
    assert.ok(absEv, 'absolute-form upstream request event written');
    const originEv = lines.find((ev) => String(ev.wire.requestLine).startsWith('POST /v1/chat?'));
    assert.ok(originEv, 'origin-form client request event written');
    const absLine = absEv.wire.requestLine;
    const originLine = originEv.wire.requestLine;

    // Absolute form: every credential-shaped param value is gone…
    for (const secret of ['sk-abs-1', 'sk-abs-2', 'xyzabs', 'abcabs', 'sigrabs', 'tkabs', 'scabs']) {
      assert.ok(!absLine.includes(secret), `${secret} must never persist in the absolute-form line`);
    }
    // …while benign params keep their exact bytes.
    assert.ok(absLine.includes('foo=bar') && absLine.includes('monkey=see') && absLine.includes('keywords=seo'),
      'benign query params must not be mangled');
    assert.ok(absLine.includes('apikey=%5BREDACTED%5D') || absLine.includes('apikey=[REDACTED]'),
      'apikey param present but value-redacted (name kept)');

    // Origin form (pathname+query path used by the client-side capture).
    for (const secret of ['sk-rel-1', 'xyzrel', 'abcrel']) {
      assert.ok(!originLine.includes(secret), `${secret} must never persist in the origin-form line`);
    }
    assert.ok(originLine.includes('foo=bar'), 'origin-form benign param preserved');
  });

  it('groupEventsIntoRequests joins on the gateway requestId, not the caller id', () => {
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId: 'CONST', clientRequestId: 'caller-fixed', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'a1', id: '1', ts: 1000, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId: 'CONST', clientRequestId: 'caller-fixed', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'a1', id: '2', ts: 1100, attempt: 1, turnIndex: 1, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'client', phase: 'request', requestId: 'GATEWAY_2', clientRequestId: 'caller-fixed', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'b1', id: '3', ts: 2000, attempt: 1, turnIndex: 2, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
      { eventType: 'http-exchange', direction: 'client', phase: 'response', requestId: 'GATEWAY_2', clientRequestId: 'caller-fixed', sessionId: 's', model: 'auto', status: 'ok', exchangeId: 'b1', id: '4', ts: 2100, attempt: 1, turnIndex: 2, isPromptStart: true, turnDecision: 'new_prompt', wire: emptyWire() },
    ] as unknown as CaptureEvent[];
    const groups = CaptureRecorder.groupEventsIntoRequests(events);
    assert.equal(groups.length, 2, 'the gateway mints a fresh requestId per inbound call');
    assert.equal(viewOf(groups[0]).clientRequest?.id, '1');
    assert.equal(viewOf(groups[0]).clientResponse?.id, '2');
    assert.equal(viewOf(groups[1]).clientRequest?.id, '3');
    assert.equal(viewOf(groups[1]).clientResponse?.id, '4');
    assert.deepEqual(groups.map(g => g.turnIndex), [1, 2]);
    assert.ok(groups.every(g => g.clientRequestId === 'caller-fixed'), 'correlation value is metadata only');
  });

});

function emptyWire(): any {
  return {
    requestLine: '',
    requestHeaders: {},
    requestBody: '',
    responseLine: '',
    status: 0,
    responseHeaders: {},
    responseBody: '',
  };
}

describe('CaptureRecorder per-session seal (maxSessionMB)', () => {
  const SESSION = 'sess_seal_aaa';
  const CAP_BYTES = 1 * 1024 * 1024; // maxSessionMB: 1
  const PAD = 'x'.repeat(300 * 1024); // one fat client-request event ≈ 300 KB
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({
      enabled: true,
      dir: tmp,
      retentionDays: 7,
      maxTotalMB: 512,
      // Above the event size, so truncation never interferes with the seal math.
      maxBodyBytes: 1024 * 1024,
      maxSessionMB: 1,
    });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  const archiveFile = () =>
    path.join(tmp, CaptureRecorder.localDateDir(new Date()), `${SESSION}.jsonl`);

  async function emitBigRequestEvent(i: number): Promise<void> {
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      exchangeId: `w_seal_${i}`,
      requestId: `t_seal_${i}`,
      sessionId: SESSION,
      model: 'lite',
      status: 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: {},
        requestBody: JSON.stringify({ messages: [{ role: 'user', content: PAD }] }),
        responseLine: '',
        status: 0,
        responseHeaders: {},
        responseBody: '',
      },
    } as any);
  }

  function readLines(): any[] {
    const file = archiveFile();
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  }

  // Emit events until the archive crosses the cap, plus one more (the event
  // that observes the crossing is the one that writes the seal marker).
  async function overflowArchive(): Promise<void> {
    let i = 0;
    while (fs.existsSync(archiveFile()) ? fs.statSync(archiveFile()).size < CAP_BYTES : i < 2) {
      await emitBigRequestEvent(i++);
    }
    await emitBigRequestEvent(i++);
  }

  it('stops appending at the cap and writes exactly one terminal marker', async () => {
    await overflowArchive();
    const lines = readLines();
    const seals = lines.filter(l => l.eventType === 'archive-overflow');
    assert.equal(seals.length, 1, 'one archive-overflow marker per seal');
    assert.equal(lines[lines.length - 1].eventType, 'archive-overflow', 'marker is the terminal line');
    assert.ok(lines[lines.length - 1].bytes >= CAP_BYTES, 'marker records the size at seal time');

    // Further events are dropped — nothing grows, and no second marker.
    const before = fs.statSync(archiveFile()).size;
    const eventsBefore = lines.filter(l => l.eventType === 'http-exchange').length;
    await emitBigRequestEvent(900);
    await emitBigRequestEvent(901);
    assert.equal(fs.statSync(archiveFile()).size, before, 'sealed archive never grows again');
    const after = readLines();
    assert.equal(after.filter(l => l.eventType === 'http-exchange').length, eventsBefore, 'events after the seal are dropped');
    assert.equal(after.filter(l => l.eventType === 'archive-overflow').length, 1, 'marker is not repeated');
  });

  it('deleteSession clears seal bookkeeping so a recreated archive records again', async () => {
    // The seal above is still in effect for this session file; deleting it
    // must reset the cached size and the sealed set, otherwise the recreated
    // file would seal at its first event (data loss) or never re-seal.
    const date = CaptureRecorder.localDateDir(new Date());
    assert.ok(recorder.deleteSession(date, `${SESSION}.jsonl`), 'deleteSession removes the sealed file');

    await emitBigRequestEvent(1000);
    const fresh = readLines();
    assert.ok(fresh.length >= 1, 'recreated archive accepts events');
    assert.equal(fresh.filter(l => l.eventType === 'archive-overflow').length, 0, 'no stale seal carried over');
    assert.ok(fs.statSync(archiveFile()).size < CAP_BYTES, 'recreated archive starts from zero bytes');

    // And it can seal on its own merits — proving the marker set was cleared.
    await overflowArchive();
    const resealed = readLines();
    assert.equal(resealed.filter(l => l.eventType === 'archive-overflow').length, 1, 'recreated archive re-seals once');
  });

  it('the terminal marker is metadata, never a request in the console readers', () => {
    // A reader that falls through to the legacy branch shows one phantom turn
    // per sealed session (the same bug class as counting event lines).
    const date = CaptureRecorder.localDateDir(new Date());
    const lines = readLines();
    const events = lines.filter(l => l.eventType === 'http-exchange').length;
    assert.ok(events > 0 && lines.some(l => l.eventType === 'archive-overflow'), 'archive is sealed with events');

    const row = recorder.listSessions(date).find(r => r.file === `${SESSION}.jsonl`);
    assert.ok(row, 'sealed session is listed');
    assert.equal(row!.requests, events, 'session tally counts captured requests only');

    const legacy = recorder.readRecords(date, `${SESSION}.jsonl`, 500);
    assert.equal(
      legacy.records.filter((r: any) => r.eventType === 'archive-overflow').length,
      0,
      'legacy record reader skips the marker'
    );
  });
});
