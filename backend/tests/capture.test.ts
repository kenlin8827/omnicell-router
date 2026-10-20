import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureRecorder } from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
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
    await off.record({ sessionId: 's1', status: 'ok', model: 'auto', request: { a: 1 } });
    assert.equal(fs.readdirSync(off.getDir()).length, 0);
    off.stop();
    rmrf(off.getDir());
  });

  it('archives by local date directory + session id and reads back', async () => {
    await recorder.record({
      sessionId: 'sess_demo_1',
      status: 'ok',
      model: 'auto',
      request: { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
      response: { id: 'chatcmpl-1', choices: [{ message: { content: 'hi' } }] },
      routing: { tierUsed: 'lite', modelUsed: 'm1', provider: 'p1' },
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      latencyMs: 42,
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
    assert.equal(records[0].status, 'ok');
    assert.equal(records[0].latencyMs, 42);
    assert.match(records[0].id, /^cap_/);
    assert.equal((records[0].response as any).choices[0].message.content, 'hi');
    assert.equal(records[0].truncated, undefined);
  });

  it('appends multiple turns into the same session file', async () => {
    await recorder.record({ sessionId: 'sess_demo_1', status: 'ok', model: 'auto', request: { n: 2 } });
    await recorder.record({ sessionId: 'sess_demo_1', status: 'error', model: 'auto', request: { n: 3 }, error: 'boom' });

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

    await recorder.record({ sessionId: evil, status: 'ok', model: 'auto', request: {} });
    const date = recorder.listDates()[0].date;
    const sessions = recorder.listSessions(date);
    assert.ok(sessions.some(s => s.file === file));
    // Nothing escaped the date dir
    assert.equal(fs.existsSync(path.join(tmp, '..', 'etc')), false);
  });

  it('truncates oversized bodies and marks the record', async () => {
    const big = 'x'.repeat(5000); // > maxBodyBytes 1024 once serialized
    await recorder.record({
      sessionId: 'sess_big',
      status: 'ok',
      model: 'auto',
      request: { messages: [{ role: 'user', content: big }] },
      response: { text: big },
    });

    const date = recorder.listDates()[0].date;
    const { records } = recorder.readRecords(date, 'sess_big.jsonl');
    assert.equal(records[0].truncated, true);
    assert.equal(typeof records[0].request, 'string');
    assert.ok(String(records[0].request).endsWith('...[TRUNCATED]'));
    assert.equal(typeof records[0].response, 'string');
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
      await rec.record({ sessionId: 'sess_a', status: 'ok', model: 'auto', request: {} });
      await rec.record({ sessionId: 'sess_b', status: 'ok', model: 'auto', request: {} });
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

  it('readRawArchive filters excluded body fields for export', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({
        sessionId: 'sess_f',
        status: 'error',
        model: 'auto',
        request: { q: 1 },
        upstreamRequest: { u: 1 },
        upstreamError: { e: 1 },
        error: 'boom',
      });
      await rec.record({
        sessionId: 'sess_f',
        status: 'ok',
        model: 'auto',
        request: { q: 2 },
        upstreamRequest: { u: 2 },
        response: { r: 2 },
      });
      const date = rec.listDates()[0].date;

      // Default: verbatim, bodies intact
      const full = rec.readRawArchive(date, 'sess_f.jsonl');
      assert.ok(full!.includes('"request":{"q":1}'));
      assert.ok(full!.includes('"response":{"r":2}'));

      // Excluding all body fields keeps metadata only
      const filtered = rec.readRawArchive(date, 'sess_f.jsonl', [
        'request',
        'upstreamRequest',
        'response',
        'upstreamError',
      ])!;
      const lines = filtered.trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines.length, 2);
      assert.equal(lines[0].request, undefined);
      assert.equal(lines[0].upstreamRequest, undefined);
      assert.equal(lines[0].upstreamError, undefined);
      assert.equal(lines[0].status, 'error');
      assert.equal(lines[0].error, 'boom'); // error message is metadata, kept
      assert.equal(lines[1].response, undefined);
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
      await hot.record({ sessionId: 's_cold', status: 'ok', model: 'auto', request: {} });
      assert.equal(hot.listDates().length, 0); // still disabled

      hot.applyConfig({ enabled: true });
      assert.equal(hot.isEnabled(), true);
      await hot.record({ sessionId: 's_hot', status: 'ok', model: 'auto', request: {} });
      assert.equal(hot.listDates().length, 1);

      hot.applyConfig({ enabled: false });
      assert.equal(hot.isEnabled(), false);
      await hot.record({ sessionId: 's_after_off', status: 'ok', model: 'auto', request: {} });
      const sessions = hot.listSessions(hot.listDates()[0].date);
      assert.ok(!sessions.some(s => s.file === 's_after_off.jsonl'), 'no writes after hot-disable');
      // Existing archive survives a hot-disable (disable never deletes)
      assert.ok(sessions.some(s => s.file === 's_hot.jsonl'));

      hot.stop();
    } finally {
      rmrf(dir3);
    }
  });

  it('isSystemoneEnabled / isSystemoneJudgeCaptureEnabled: master/sub truth tables', () => {
    const dir5 = makeTmpDir();
    type Sys = { enabled?: boolean; l2DecisionEnabled?: boolean };
    const mk = (enabled?: boolean, systemone?: Sys): CaptureRecorder =>
      new CaptureRecorder({ dir: dir5, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024, enabled, systemone });
    try {
      // CLIENT-leg truth table — 4-combo over (requestCapture.enabled ×
      // systemone.enabled). Neither flag alone turns capture on (the privacy
      // master wins); under capture-master=true an ABSENT surface master
      // defaults ON (master/sub contract: the privacy posture is held by
      // requestCapture.enabled alone).
      const clientCases: Array<[boolean | undefined, boolean | undefined, boolean]> = [
        [undefined, undefined, false], // capture master absent → OFF
        [false, true, false], // capture master OFF silences the surface too
        [true, undefined, true], // absent surface master = default ON
        [true, false, false], // surface master explicitly OFF
      ];
      // JUDGE-leg truth table — full 8-combo over (requestCapture.enabled ×
      // systemone.enabled × systemone.l2DecisionEnabled). THE MASTER-SEMANTICS
      // PIN: systemone.enabled=false silences the judge leg even when
      // l2DecisionEnabled=true — the sub-switch only ever ADDS beneath the
      // surface master, it can never override it.
      const judgeCases: Array<[boolean, boolean, boolean, boolean]> = [
        [true, true, true, true], // the only ON cell
        [true, true, false, false], // sub OFF exempts the judge leg only
        [true, false, true, false], // surface master OFF → judge SILENCED despite sub=true
        [true, false, false, false],
        [false, true, true, false], // capture master OFF wins everywhere
        [false, true, false, false],
        [false, false, true, false],
        [false, false, false, false],
      ];
      for (const [enabled, sysEnabled, expected] of clientCases) {
        const r = mk(enabled, sysEnabled === undefined ? undefined : { enabled: sysEnabled });
        assert.equal(r.isSystemoneEnabled(), expected, `client: enabled=${String(enabled)} sysEnabled=${String(sysEnabled)}`);
        r.stop();
      }
      for (const [enabled, sysEnabled, sub, expected] of judgeCases) {
        const r = mk(enabled, { enabled: sysEnabled, l2DecisionEnabled: sub });
        assert.equal(r.isSystemoneJudgeCaptureEnabled(), expected, `judge: enabled=${String(enabled)} sysEnabled=${String(sysEnabled)} sub=${String(sub)}`);
        r.stop();
      }

      // applyConfig hot-swap: ON ↔ OFF both ways, and absent keeps the
      // current value (nullish-merge, like every other field — a partial
      // systemone node must not stomp the sibling flag).
      const hot = mk(true);
      assert.equal(hot.isSystemoneEnabled(), true); // surface master default ON under the capture master
      assert.equal(hot.isSystemoneJudgeCaptureEnabled(), true); // sub default ON too
      hot.applyConfig({ systemone: { enabled: false } });
      assert.equal(hot.isSystemoneEnabled(), false);
      assert.equal(hot.isSystemoneJudgeCaptureEnabled(), false); // master OFF silences BOTH legs, hot
      hot.applyConfig({}); // absent → retains
      assert.equal(hot.isSystemoneEnabled(), false);
      hot.applyConfig({ systemone: { enabled: true } });
      assert.equal(hot.isSystemoneEnabled(), true);
      assert.equal(hot.isSystemoneJudgeCaptureEnabled(), true);
      hot.applyConfig({ systemone: { l2DecisionEnabled: false } }); // sub exempt; client leg untouched
      assert.equal(hot.isSystemoneEnabled(), true);
      assert.equal(hot.isSystemoneJudgeCaptureEnabled(), false);
      hot.applyConfig({ enabled: false }); // capture master off wins
      assert.equal(hot.isSystemoneEnabled(), false);
      assert.equal(hot.isSystemoneJudgeCaptureEnabled(), false);
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

  it('listSessions surfaces the session preview', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 1024 });
      await rec.record({ sessionId: 'sess_p', status: 'ok', model: 'auto', request: { model: 'auto', messages: [{ role: 'user', content: '第一条用户消息' }] } });
      await rec.record({ sessionId: 'sess_p', status: 'ok', model: 'auto', request: { messages: [{ role: 'user', content: '第二条不覆盖预览' }] } });
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.preview, '第一条用户消息');
      rec.stop();
    } finally {
      rmrf(dir);
    }
  });

  it('listSessions tallies event-stream files per TURN (not per event line)', async () => {
    const dir = makeTmpDir();
    try {
      const rec = new CaptureRecorder({ enabled: true, dir, retentionDays: 7, maxTotalMB: 512, maxBodyBytes: 4096 });
      const wire = { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' };
      // Turn 1 (ok): full 4-event cycle.
      for (const [direction, phase, spanId] of [
        ['client', 'request', 's1'], ['upstream', 'request', 's2'],
        ['upstream', 'response', 's2'], ['client', 'response', 's1'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, spanId, traceId: 't1',
          sessionId: 'sess_evt', model: 'auto', status: 'ok',
          wire: direction === 'client' && phase === 'request'
            ? { ...wire, requestBody: JSON.stringify({ messages: [{ role: 'user', content: '事件流预览文本' }] }) }
            : wire,
        });
      }
      // Turn 2 (failed): upstream response is an error → ONE failed turn,
      // even though a gateway-response error event also carries the traceId.
      for (const [direction, phase, spanId, status] of [
        ['client', 'request', 's3', 'ok'], ['upstream', 'request', 's4', 'ok'],
        ['upstream', 'response', 's4', 'error'], ['client', 'response', 's3', 'error'],
      ] as const) {
        await rec.recordEvent({
          eventType: 'http-exchange', direction, phase, spanId, traceId: 't2',
          sessionId: 'sess_evt', model: 'auto', status, wire,
        });
      }
      const row = rec.listSessions(rec.listDates()[0].date)[0];
      assert.equal(row.turns, 2, '8 event lines = 2 turns');
      assert.equal(row.failed, 1, 'failed counts turns, not error events');
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
      await rec.record({ sessionId: 'sess_find', status: 'ok', model: 'auto', request: {} });
      // Same session id on a previous local day (hand-made extra date dir)
      const today = rec.listDates()[0].date;
      const yesterday = new Date(new Date().getTime() - 86_400_000).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(dir, yesterday), { recursive: true });
      fs.writeFileSync(path.join(dir, yesterday, 'sess_find.jsonl'), '{"status":"ok"}\n');
      // Unsafe id → hashed file name must still match the raw id
      const evil = '{"device_id":"x","session_id":"<uuid>"}';
      await rec.record({ sessionId: evil, status: 'ok', model: 'auto', request: {} });

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

  // Helper: emit one full inference turn (4 events) into the recorder
  // with the given correlationId. Wire bodies use minimal valid shapes so
  // the recorder's truncate pass is exercised.
  async function emitOneTurn(
    correlationId: string,
    sessionId: string,
    model: string,
    opts: { inboundStatus?: number; outboundStatus?: number; outboundError?: string } = {}
  ): Promise<{ wireId: string }> {
    const wireId = `wire_${correlationId}`;
    // 1. Client request — fires synchronously the moment the handler
    //    enters the orchestrator.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      spanId: wireId,
      traceId: correlationId,
      sessionId,
      model,
      status: 'ok',
      wire: {
        requestLine: 'POST /v1/chat/completions HTTP/1.1',
        requestHeaders: { 'user-agent': 'onecast-router/test', authorization: '[REDACTED]' },
        requestBody: '{"messages":[]}',
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
      spanId: `${wireId}_out`,
      traceId: correlationId,
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
      spanId: `${wireId}_out`,
      traceId: correlationId,
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
      spanId: wireId,
      traceId: correlationId,
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

  it('writes exactly 4 events per inference turn (inbound-req/res + outbound-req/res)', async () => {
    const sessionIdA = 'sess_events_aaa';
    const sessionIdB = 'sess_events_bbb';
    await emitOneTurn('corr_aaa', sessionIdA, 'auto-lite');
    await emitOneTurn('corr_bbb', sessionIdB, 'auto-plus');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const contentA = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdA}.jsonl`), 'utf8');
    const linesA = contentA.split('\n').filter(l => l.trim());
    assert.equal(linesA.length, 4, 'turn A writes 4 events into its own session file');
    const contentB = fs.readFileSync(path.join(tmp, dateDir, `${sessionIdB}.jsonl`), 'utf8');
    const linesB = contentB.split('\n').filter(l => l.trim());
    assert.equal(linesB.length, 4, 'turn B writes 4 events into its own session file');
  });

  it('groups events into logical turns by traceId (groupEventsIntoTurns)', () => {
    const traceId = 'trace_grp_1';
    const events = [
      // client req (ts 1000)
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      // upstream req (ts 1005)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'b', ts: 1005, wire: emptyWire() } as any,
      // upstream resp (ts 1500)
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'c', ts: 1500, wire: emptyWire() } as any,
      // client resp (ts 1520)
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'd', ts: 1520, wire: emptyWire() } as any,
    ];
    const turns = CaptureRecorder.groupEventsIntoTurns(events);
    assert.equal(turns.length, 1);
    const t = turns[0];
    assert.equal(t.clientRequest?.id, 'a');
    assert.equal(t.upstreamRequest?.id, 'b');
    assert.equal(t.upstreamResponse?.id, 'c');
    assert.equal(t.gatewayResponse?.id, 'd');
    assert.equal(t.upstreamLatencyMs, 1500 - 1005);
    assert.equal(t.gatewayLatencyMs, 1520 - 1000);
    // No firstByteTs on the events → no TTFT/decode split is synthesized.
    assert.equal(t.upstreamTtftMs, undefined);
    assert.equal(t.upstreamGenMs, undefined);
    assert.equal(t.gatewayTtftMs, undefined);
    assert.equal(t.gatewayGenMs, undefined);
  });

  it('derives TTFT and decode window from firstByteTs (TTFT/TPS split)', () => {
    const traceId = 'trace_grp_2';
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'a', ts: 1000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'upstream', phase: 'request', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'b', ts: 1005, wire: emptyWire() } as any,
      // Upstream response: first chunk at 1150, fully received at 1500
      // → upstream TTFT = 145, decode window = 350.
      { eventType: 'http-exchange', direction: 'upstream', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w2', id: 'c', ts: 1500, firstByteTs: 1150, wire: emptyWire() } as any,
      // Gateway response: first chunk to the client at 1180, finalized 1520
      // → gateway TTFT = 180, decode window = 340.
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId, sessionId: 's', model: 'auto', status: 'ok', spanId: 'w1', id: 'd', ts: 1520, firstByteTs: 1180, wire: emptyWire() } as any,
    ];
    const t = CaptureRecorder.groupEventsIntoTurns(events)[0];
    assert.equal(t.upstreamTtftMs, 1150 - 1005);
    assert.equal(t.upstreamGenMs, 1500 - 1150);
    assert.equal(t.gatewayTtftMs, 1180 - 1000);
    assert.equal(t.gatewayGenMs, 1520 - 1180);
  });

  it('records request event BEFORE response event (request-event independence)', async () => {
    // The core invariant the user asked for: "if you sent a request,
    // record it; you don't have to wait for the response." We test by
    // checking that the client-request line in the JSONL appears BEFORE
    // the client-response line for the same spanId.
    const sessionId = 'sess_indep';
    const wireId = 'wire_indep';
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'request',
      spanId: wireId, traceId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST /x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    // Provider throws — emit a failure response. The REQUEST must already
    // be on disk even though the response is a failure.
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      spanId: 'w_out', traceId: 'c1', sessionId, model: 'auto',
      status: 'ok',
      wire: { requestLine: 'POST https://x HTTP/1.1', requestHeaders: {}, requestBody: '{}', responseLine: '', status: 0, responseHeaders: {}, responseBody: '' },
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'response',
      spanId: 'w_out', traceId: 'c1', sessionId, model: 'auto',
      status: 'error',
      wire: { requestLine: '', requestHeaders: {}, requestBody: '', responseLine: 'HTTP/1.1 503 Service Unavailable', status: 503, responseHeaders: {}, responseBody: '' },
      error: 'upstream 503',
    });
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'client', phase: 'response',
      spanId: wireId, traceId: 'c1', sessionId, model: 'auto',
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
    assert.equal(req.spanId, res.spanId);
    assert.equal(req.traceId, res.traceId);
    // Failure is durable on both sides.
    const outRes = JSON.parse(lines[2]);
    assert.equal(outRes.status, 'error');
    assert.equal(outRes.error, 'upstream 503');
    assert.equal(outRes.direction, 'upstream');
  });

  it('readEvents groups by correlationId and computes per-direction latency', async () => {
    const sessionId = 'sess_read_events';
    // Two turns, sequential — same sessionId so both land in one JSONL.
    await emitOneTurn('corr_read_1', sessionId, 'auto-lite');
    await emitOneTurn('corr_read_2', sessionId, 'auto-plus');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100);
    assert.equal(result.turns.length, 2);
    assert.equal(result.events.length, 8);
    // The header's turn tally must be the grouped count, not raw event
    // lines (4 lines per turn here — labelling totalLines as turns 4x's it).
    assert.equal(result.totalLines, 8);
    assert.equal(result.totalTurns, 2);
    // Each turn has all four events paired.
    for (const t of result.turns) {
      assert.ok(t.clientRequest && t.gatewayResponse && t.upstreamRequest && t.upstreamResponse,
        `turn ${t.traceId} missing event pair`);
      assert.equal(t.clientRequest!.spanId, t.gatewayResponse!.spanId);
      assert.equal(t.upstreamRequest!.spanId, t.upstreamResponse!.spanId);
    }
  });

  it('readEvents bodies=none strips wire bodies, keeps lines/status/headers', async () => {
    const sessionId = 'sess_read_none';
    await emitOneTurn('corr_none_1', sessionId, 'auto-lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const result = await recorder.readEvents(dateDir, file, 100, 'none');
    assert.equal(result.turns.length, 1);
    const t = result.turns[0];
    assert.ok(t.clientRequest && t.gatewayResponse && t.upstreamRequest && t.upstreamResponse);
    // Bodies stripped — metadata-first reads ship KBs, not MBs.
    assert.equal(t.clientRequest!.wire.requestBody, undefined);
    assert.equal(t.upstreamResponse!.wire.responseBody, undefined);
    // Lines, status and headers survive for metadata rendering.
    assert.equal(t.clientRequest!.wire.requestLine, 'POST /v1/chat/completions HTTP/1.1');
    assert.equal(t.gatewayResponse!.wire.status, 200);
    assert.equal(t.upstreamRequest!.wire.requestHeaders['content-type'], 'application/json');
    // Full read of the same archive still carries the bodies.
    const full = await recorder.readEvents(dateDir, file, 100, 'full');
    assert.equal(full.turns[0].clientRequest!.wire.requestBody, '{"messages":[]}');
  });

  it('readEvents derives completionTokens from the last usage block', async () => {
    const sessionId = 'sess_read_tokens';
    await emitOneTurn('corr_tok_1', sessionId, 'auto-lite');
    // Streaming-style body: usage repeats per chunk, the LAST occurrence is
    // the cumulative total.
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      spanId: 'wire_tok_2',
      traceId: 'corr_tok_2',
      sessionId,
      model: 'auto-lite',
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
      spanId: 'wire_tok_2',
      traceId: 'corr_tok_2',
      sessionId,
      model: 'auto-lite',
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
    const t = result.turns.find(x => x.traceId === 'corr_tok_2');
    assert.ok(t?.gatewayResponse);
    assert.equal(t.gatewayResponse!.completionTokens, 42);
  });

  it('readTurn returns the full turn by client-request id; unknown ids answer null', async () => {
    const sessionId = 'sess_read_turn';
    await emitOneTurn('corr_turn_1', sessionId, 'auto-lite');
    const dateDir = CaptureRecorder.localDateDir(new Date());
    const file = `${sessionId}.jsonl`;
    const meta = await recorder.readEvents(dateDir, file, 100, 'none');
    const clientReqId = meta.turns[0].clientRequest!.id;
    const res = await recorder.readTurn(dateDir, file, clientReqId);
    assert.ok(res);
    assert.equal(res!.turn.traceId, 'corr_turn_1');
    // Full bodies restored — this is the per-turn fetch behind the drawer.
    assert.equal(res!.turn.clientRequest!.wire.requestBody, '{"messages":[]}');
    assert.equal(res!.turn.upstreamResponse!.wire.responseBody, '{"choices":[]}');
    assert.equal(await recorder.readTurn(dateDir, file, 'evt_missing'), null);
  });

  it('truncates oversized wire bodies (UTF-8 path)', async () => {
    const sessionId = 'sess_truncate';
    const bigBody = 'x'.repeat(2048); // > maxBodyBytes (1024)
    await recorder.recordEvent({
      eventType: 'http-exchange', direction: 'upstream', phase: 'request',
      spanId: 'w_out', traceId: 'corr_t', sessionId, model: 'auto',
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
      spanId: 'w_cjk', traceId: 'corr_cjk', sessionId, model: 'auto',
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
      traceId: 'trace_redact',
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
      traceId: 'trace_redact_query',
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
      traceId: 'trace_redact_query',
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

  it('groupEventsIntoTurns keeps turns separate when a client reuses one traceId', () => {
    const events = [
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'a1', id: '1', ts: 1000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'a1', id: '2', ts: 1100, wire: emptyWire() } as any,
      // Same constant traceId, NEW turn (client sends fixed x-request-id).
      { eventType: 'http-exchange', direction: 'client', phase: 'request', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'b1', id: '3', ts: 2000, wire: emptyWire() } as any,
      { eventType: 'http-exchange', direction: 'client', phase: 'response', traceId: 'CONST', sessionId: 's', model: 'auto', status: 'ok', spanId: 'b1', id: '4', ts: 2100, wire: emptyWire() } as any,
    ];
    const turns = CaptureRecorder.groupEventsIntoTurns(events);
    assert.equal(turns.length, 2, 'constant traceId must not collapse turns');
    assert.equal(turns[0].clientRequest?.id, '1');
    assert.equal(turns[0].gatewayResponse?.id, '2');
    assert.equal(turns[1].clientRequest?.id, '3');
    assert.equal(turns[1].gatewayResponse?.id, '4');
    assert.equal(turns[0].gatewayLatencyMs, 100);
    assert.equal(turns[1].gatewayLatencyMs, 100);
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
      spanId: `w_seal_${i}`,
      traceId: `t_seal_${i}`,
      sessionId: SESSION,
      model: 'auto-lite',
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

  it('the terminal marker is metadata, never a turn in the console readers', () => {
    // A reader that falls through to the legacy branch shows one phantom turn
    // per sealed session (the same bug class as counting event lines).
    const date = CaptureRecorder.localDateDir(new Date());
    const lines = readLines();
    const events = lines.filter(l => l.eventType === 'http-exchange').length;
    assert.ok(events > 0 && lines.some(l => l.eventType === 'archive-overflow'), 'archive is sealed with events');

    const row = recorder.listSessions(date).find(r => r.file === `${SESSION}.jsonl`);
    assert.ok(row, 'sealed session is listed');
    assert.equal(row!.turns, events, 'session tally counts exchange turns only');

    const legacy = recorder.readRecords(date, `${SESSION}.jsonl`, 500);
    assert.equal(
      legacy.records.filter((r: any) => r.eventType === 'archive-overflow').length,
      0,
      'legacy record reader skips the marker'
    );
  });
});
