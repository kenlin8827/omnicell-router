import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureRecorder, type CaptureEvent } from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-stitch-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Minimal valid http-exchange event line. */
function ev(overrides: Partial<CaptureEvent>): CaptureEvent {
  return {
    id: `evt_${Math.random().toString(16).slice(2, 10)}`,
    ts: Date.now(),
    eventType: 'http-exchange',
    schema: 2,
    direction: 'client',
    phase: 'request',
    turnIndex: 1,
    isPromptStart: true,
    turnDecision: 'new_prompt',
    attempt: 1,
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
  } as CaptureEvent;
}

/** Append events to an explicit date shard (bypassing write-time dating). */
function shard(tmp: string, date: string, file: string, events: CaptureEvent[]): void {
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

  it('readEventsStitched reassembles a request split across midnight', async () => {
    const result = await recorder.readEventsStitched(DAY2, FILE, 100);
    // Both fragments merged, chronological, no duplicates.
    assert.equal(result.totalLines, 2);
    assert.deepEqual(result.fragments.map(f => f.date), [DAY2, DAY1]);
    // Per-shard tally: each file holds one REQUEST, even though its single
    // event is only one half of an exchange.
    assert.deepEqual(result.fragments.map(f => f.requests), [1, 1]);
    // Stitching reassembles ONE request with both exchange halves.
    assert.equal(result.totalRequests, 1);
    assert.equal(result.totalTurns, 1);
    assert.equal(result.requests.length, 1);
    const clientExchange = result.requests[0].exchanges.find(e => e.leg === 'client');
    assert.ok(clientExchange?.request && clientExchange.response);
    assert.equal(clientExchange.latencyMs, RESP.ts - REQ.ts);
    // Entering from EITHER date yields the identical stitched timeline.
    const fromDay1 = await recorder.readEventsStitched(DAY1, FILE, 100);
    assert.equal(fromDay1.totalTurns, 1);
    assert.deepEqual(fromDay1.events.map(e => e.id), result.events.map(e => e.id));
  });

  it('conversationKey joins sibling archives whose session id churned', async () => {
    // Same conversation, minted a fresh session id the next day.
    const SIBLING = 'sess_span_minted.jsonl';
    shard(tmp, DAY2, SIBLING, [
      ev({ id: 'evt_sib', ts: Date.parse(`${DAY2}T08:00:00`), requestId: 't2', exchangeId: 'w2', phase: 'request', direction: 'client', conversationKey: 'conv_A', turnIndex: 2 }),
    ]);
    const result = await recorder.readEventsStitched(DAY1, FILE, 100);
    assert.equal(result.totalLines, 3);
    assert.equal(result.totalTurns, 2);
    assert.ok(result.fragments.some(f => f.file === SIBLING));
  });

  it('readRequestStitched resolves a request archived in another fragment', async () => {
    // The request event lives in DAY1's shard; ask from DAY2's view.
    const result = await recorder.readRequestStitched(DAY2, FILE, 'evt_req');
    assert.ok(result);
    assert.equal(result!.request.requestId, 't1');
  });

  it('readEvents (non-stitched) keeps showing only the local shard', async () => {
    const result = await recorder.readEvents(DAY2, FILE, 100);
    assert.equal(result.totalLines, 1);
    // The orphan response still joins its requestId; only the stitched read
    // sees both shards. Turn identity comes from the archive, not the reader.
    assert.equal(result.requests.length, 1);
    assert.equal(result.totalTurns, 1);
  });

  it('rejects pre-schema-2 lines instead of silently normalizing them', async () => {
    // ADR-0024 strict cutover: the boot migration pass upgrades schema-1
    // archives in place, and ONLY the migrated shape is readable. A line
    // still without schema/turn identity has not been through that pass, so
    // it is NOT a request and must never enter the read plane.
    const DATE = '2026-05-20';
    const LEGACY = 'sess_legacy.jsonl';
    shard(tmp, DATE, LEGACY, []);
    fs.appendFileSync(
      path.join(tmp, DATE, LEGACY),
      JSON.stringify({
        id: 'lg_req', ts: 1000, eventType: 'http-exchange',
        direction: 'client', phase: 'request', spanId: 'w1',
        traceId: 'legacy_trace', sessionId: 'sess_legacy',
        model: 'auto', status: 'ok',
        wire: { requestBody: '{}', responseBody: '' },
      }) + '\n',
      'utf8'
    );
    const result = await recorder.readEvents(DATE, LEGACY, 10);
    assert.equal(result.totalLines, 0);
    assert.equal(result.requests.length, 0);
    assert.equal(result.events.length, 0);
  });

});
