/**
 * Capture event-stream shape for the Fastify leg (contract step 3c, R-1
 * machine spec — written and green BEFORE the transport flip, kept green
 * after it with zero edits).
 *
 * inject (light-my-request) is fine for these NON-abort paths — the abort
 * matrix lives in capture-abort.test.ts on a real listener. The pins here:
 *   • EXACTLY 2 client events per turn (request + response), no more.
 *   • responseBody STASHED EXACTLY ONCE — the regression guard for the flip:
 *     if a leftover onSend stash coexisted with an adapter stash, the body
 *     would double (JSON.parse trips on trailing garbage / the DONE
 *     sentinel count grows).
 *   • requestLine non-empty, requestHeaders carry the client user-agent.
 *   • responseHeaders carry the X-OCR map (non-stream also content-type;
 *     stream captures stay content-type-free per contract §4 — that pin is
 *     asserted in capture-abort.test.ts against the real socket shape).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

const TEST_KEY = 'sk-ocr-capture-http-test';
const UA = 'capture-http-test/9.9';
// Same runtime branch as capture-abort.test.ts: the stream capture's raw-map
// visibility is runtime-dependent (Bun exposes writeHead'd headers, Node
// hides them — contract §4's "stream capture has no content-type").
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun === 'object';

interface ClientEvent {
  status: string;
  phase: string;
  spanId: string;
  wire: {
    requestLine: string;
    requestHeaders: Record<string, string>;
    requestBody: string;
    responseLine: string;
    responseHeaders: Record<string, string>;
    responseBody: string;
    status: number;
  };
}

let tmp: string;
let app: FastifyInstance;

function readClientEvents(): ClientEvent[] {
  const dir = path.join(tmp, CaptureRecorder.localDateDir(new Date()));
  if (!fs.existsSync(dir)) return [];
  const out: ClientEvent[] = [];
  for (const f of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      const ev = JSON.parse(line);
      if (ev.eventType === 'http-exchange' && ev.direction === 'client') out.push(ev);
    }
  }
  return out;
}

function eventsFor(marker: string): ClientEvent[] {
  return readClientEvents().filter((e) => e.wire.requestBody.includes(marker));
}

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`capture events did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function settle(marker: string): Promise<ClientEvent[]> {
  await waitUntil(() => eventsFor(marker).length >= 2);
  // Small settle window so a hypothetical THIRD (double) event cannot land
  // after the assertion instead of before it.
  await new Promise((r) => setTimeout(r, 150));
  return eventsFor(marker);
}

describe('capture-http (Fastify leg event shape, inject)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-http-'));
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.apiKeys = [
      {
        id: 'key-capture-http',
        name: 'capture-http fixture',
        key: TEST_KEY,
        role: 'user',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    config.requestCapture = { enabled: true, dir: tmp, retentionDays: 7, maxTotalMB: 64, maxBodyBytes: 65536 };
    app = createServer(config, true).app; // mockMode
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('chat non-stream: exactly request+response, single-stashed JSON body', async () => {
    const marker = `HTTP-JSON-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TEST_KEY}`, 'user-agent': UA },
      payload: { model: 'auto', messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(res.statusCode, 200);

    const events = await settle(marker);
    assert.equal(events.length, 2, 'exactly TWO client events: request + response');
    const req = events.find((e) => e.phase === 'request')!;
    const resp = events.find((e) => e.phase === 'response')!;
    assert.ok(req && resp, 'both phases present');
    assert.equal(req.spanId, resp.spanId, 'request and response events pair on spanId');

    // Request-side shape.
    assert.equal(req.wire.requestLine, 'POST /v1/chat/completions HTTP/1.1', 'requestLine non-empty origin-form');
    assert.equal(req.wire.requestHeaders['user-agent'], UA, 'user-agent captured (sanitizer keeps non-credential names)');

    // Response-side shape + the double-stash regression guard.
    assert.equal(resp.wire.status, 200);
    assert.equal(resp.status, 'ok');
    // A stash-twice body would be `{...}{...}` — JSON.parse rejects the
    // trailing document; exact byte round-trip pins "exactly once".
    const parsed = JSON.parse(resp.wire.responseBody) as { choices?: unknown[] };
    assert.ok(Array.isArray(parsed.choices), 'captured responseBody is one complete chat.completion document');
    assert.equal(
      resp.wire.responseBody,
      JSON.stringify(JSON.parse(resp.wire.responseBody)),
      'responseBody stashed exactly once (no concatenation artifacts)'
    );
    assert.ok(String(resp.wire.responseHeaders['content-type'] ?? '').includes('application/json'));
    assert.ok(resp.wire.responseHeaders['x-ocr-tier'], 'X-OCR map present on the response capture');
    assert.ok(resp.wire.responseHeaders['x-ocr-model'], 'X-OCR-Model present on the response capture');
    assert.equal(resp.wire.requestLine, req.wire.requestLine, 'response event carries the paired request line');
  });

  it('chat stream: exactly request+response, single-stashed SSE text', async () => {
    const marker = `HTTP-STREAM-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TEST_KEY}`, 'user-agent': UA },
      payload: { model: 'auto', stream: true, messages: [{ role: 'user', content: marker }] },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('data: [DONE]'));

    const events = await settle(marker);
    assert.equal(events.length, 2, 'exactly TWO client events: request + response');
    const req = events.find((e) => e.phase === 'request')!;
    const resp = events.find((e) => e.phase === 'response')!;

    assert.ok(req.wire.requestLine.startsWith('POST /v1/chat/completions HTTP/1.1'), 'requestLine non-empty');
    assert.equal(req.wire.requestHeaders['user-agent'], UA, 'user-agent captured');

    assert.equal(resp.wire.status, 200);
    const body = resp.wire.responseBody;
    // Single-stash guard for the stream path: the [DONE] sentinel and the
    // FIRST chunk frame must each occur exactly once.
    assert.equal(body.split('data: [DONE]').length - 1, 1, 'exactly one DONE sentinel — responseBody stashed once');
    const firstFrame = body.slice(0, body.indexOf('\n\n') + 2);
    assert.ok(firstFrame.startsWith('data: '), 'stream body starts with a data frame');
    assert.equal(body.indexOf(firstFrame), body.lastIndexOf(firstFrame), 'first chunk frame appears exactly once (no double-stash)');
    // Observed stream capture shape (probed on current code): reply.getHeaders()
    // merges the writeHead'd raw map, so content-type + CORS + the staged
    // X-OCR mirror are all present. The flip must preserve this exactly.
    assert.ok(resp.wire.responseHeaders['x-ocr-tier'], 'staged X-OCR map reached the capture');
    // RUNTIME-DEPENDENT raw-map visibility (same pin as capture-abort.test.ts
    // §4): Bun keeps the writeHead'd headers in the capture, Node hides them.
    if (IS_BUN) {
      assert.equal(
        resp.wire.responseHeaders['content-type'],
        'text/event-stream; charset=utf-8',
        'stream capture carries the wire content-type (Bun raw-map)'
      );
    } else {
      assert.equal(
        resp.wire.responseHeaders['content-type'],
        undefined,
        'Node stream capture has no content-type (§4, pinned as-is)'
      );
    }
  });
});
