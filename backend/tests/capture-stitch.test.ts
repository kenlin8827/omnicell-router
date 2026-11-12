import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureRecorder, type HttpExchangeEvent } from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-stitch-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal valid http-exchange event line. */
function ev(overrides: Partial<HttpExchangeEvent>): HttpExchangeEvent {
  return {
    id: `evt_${Math.random().toString(16).slice(2, 10)}`,
    ts: Date.now(),
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    exchangeId: 'w1',
    requestId: 'trace_x',
    sessionId: 'sess_span',
    conversationKey: 'conv_A',
    model: 'auto',
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
    ...overrides,
  } as HttpExchangeEvent;
}

/** Append events to an explicit date shard (bypassing write-time dating). */
function shard(tmp: string, date: string, file: string, events: HttpExchangeEvent[]): void {
  const dir = path.join(tmp, date);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, file),
    events.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

describe('CaptureRecorder cross-midnight stitching', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  // Fixed shards: DAY1 23:59:58 request, DAY2 00:00:03 response — one turn
  // physically split across two date directories.
  const DAY1 = '2026-06-01';
  const DAY2 = '2026-06-02';
  const FILE = 'sess_span.jsonl';
  const REQ = ev({ id: 'evt_req', ts: Date.parse(`${DAY1}T23:59:58`), requestId: 't1', exchangeId: 'w1', phase: 'request', direction: 'client' });
  const RESP = ev({ id: 'evt_resp', ts: Date.parse(`${DAY2}T00:00:03`), requestId: 't1', exchangeId: 'w1', phase: 'response', direction: 'client' });

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({ enabled: true, dir: tmp, retentionDays: 7 });
    shard(tmp, DAY1, FILE, [REQ]);
    shard(tmp, DAY2, FILE, [RESP]);
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('listSessionsWithSpans marks archives that span >1 date', () => {
    for (const date of [DAY1, DAY2]) {
      const rows = recorder.listSessionsWithSpans(date);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].spanDates, [DAY2, DAY1]); // newest first
    }
  });

  it('readEventsStitched reassembles a turn split across midnight', async () => {
    const result = await recorder.readEventsStitched(DAY2, FILE, 100);
    // Both fragments merged, chronological, no duplicates.
    assert.equal(result.totalLines, 2);
    assert.deepEqual(result.fragments.map(f => f.date), [DAY2, DAY1]);
    // Per-file tally: each shard alone holds an orphan half, and an orphan
    // (request-only or response-only) still groups as a window-local turn.
    assert.deepEqual(result.fragments.map(f => f.turns), [1, 1]);
    // The split turn is ONE logical turn again, with both halves paired.
    assert.equal(result.totalTurns, 1);
    assert.equal(result.turns.length, 1);
    assert.ok(result.turns[0].clientRequest && result.turns[0].gatewayResponse);
    assert.equal(result.turns[0].gatewayLatencyMs, RESP.ts - REQ.ts);
    // Entering from EITHER date yields the identical stitched timeline.
    const fromDay1 = await recorder.readEventsStitched(DAY1, FILE, 100);
    assert.equal(fromDay1.totalTurns, 1);
    assert.deepEqual(fromDay1.events.map(e => e.id), result.events.map(e => e.id));
  });

  it('conversationKey joins sibling archives whose session id churned', async () => {
    // Same conversation, minted a fresh session id the next day.
    const SIBLING = 'sess_span_minted.jsonl';
    shard(tmp, DAY2, SIBLING, [
      ev({ id: 'evt_sib', ts: Date.parse(`${DAY2}T08:00:00`), requestId: 't2', exchangeId: 'w2', phase: 'request', direction: 'client', conversationKey: 'conv_A' }),
    ]);
    const result = await recorder.readEventsStitched(DAY1, FILE, 100);
    assert.equal(result.totalLines, 3);
    assert.equal(result.totalTurns, 2);
    assert.ok(result.fragments.some(f => f.file === SIBLING));
  });

  it('readTurnStitched resolves a turn archived in another fragment', async () => {
    // The request event lives in DAY1's shard; ask from DAY2's view.
    const result = await recorder.readTurnStitched(DAY2, FILE, 'evt_req');
    assert.ok(result);
    assert.equal(result!.turn.requestId, 't1');
  });

  it('readEvents (non-stitched) keeps showing only the local shard', async () => {
    const result = await recorder.readEvents(DAY2, FILE, 100);
    assert.equal(result.totalLines, 1);
    // The orphan response forms its own window-local "turn" — exactly the
    // pre-stitch behavior the stitched path exists to fix.
    assert.equal(result.totalTurns, 1);
  });

  it('reads a pre-ADR-0021 archive: legacy keys normalize, one turn per trace', async () => {
    // Archive written before request identity existed: `spanId` / `traceId`,
    // no `requestId`. The reader maps it once (exchangeId / clientRequestId)
    // and keys turns by the old trace id — the best identity those files have.
    const DATE = '2026-05-20';
    const LEGACY = 'sess_legacy.jsonl';
    const legacyWire = {
      requestLine: 'POST /v1/chat/completions HTTP/1.1',
      requestHeaders: {},
      requestBody: '{}',
      responseLine: '',
      status: 0,
      responseHeaders: {},
      responseBody: '',
    };
    const legacy = (id: string, spanId: string, phase: 'request' | 'response', ts: number) =>
      JSON.stringify({
        id,
        ts,
        eventType: 'http-exchange',
        direction: 'client',
        phase,
        spanId,
        traceId: 'legacy_trace',
        sessionId: 'sess_legacy',
        model: 'auto',
        status: 'ok',
        wire: legacyWire,
      });
    shard(tmp, DATE, LEGACY, []);
    const file = path.join(tmp, DATE, LEGACY);
    fs.appendFileSync(
      file,
      [legacy('lg_req', 'w1', 'request', 1000), legacy('lg_res', 'w1', 'response', 1050)].join('\n') + '\n',
      'utf8'
    );

    const result = await recorder.readEvents(DATE, LEGACY, 10);
    assert.equal(result.totalLines, 2);
    assert.equal(result.totalTurns, 1);
    assert.equal(result.turns[0].requestId, 'legacy_trace', 'joined on the only id the file has');
    assert.equal(result.turns[0].clientRequestId, 'legacy_trace');
    assert.equal(result.events[0].exchangeId, 'w1', 'spanId mapped at the boundary');
    assert.equal(result.events[1].id, 'lg_res', 'request/response pairing survives');
  });
});
