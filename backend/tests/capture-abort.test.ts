/**
 * Capture semantics on a REAL listener socket (contract step 3c, R-1 machine
 * spec). Written BEFORE the transport flip and kept green across it with
 * ZERO edits — that red/green discipline is the acceptance proof.
 * `app.inject` (light-my-request) is deliberately NOT used for the abort
 * cells: per repo memory bun inject is unreliable on post-401/abort paths,
 * and an abort is inherently a socket-level event.
 *
 * Runtime × mechanism matrix (probed 2026-10-12 against BOTH implementations;
 * forward-proxy.test.ts:360 is the governing note — R-8 "Bun abort-mode
 * fidelity"):
 *
 *   M1 client-destroy (socket.destroy() on the CLIENT side):
 *     • Node: `reply.raw` fires 'close' with writableEnded=false → the
 *       close listener synthesizes EXACTLY ONE 499 on both implementations.
 *     • Bun:  the abort is UNDETECTABLE (verified: res 'close' never fires,
 *       reply.raw.socket.destroyed stays false). Pre-flip produced ZERO
 *       response events (dangling request record). Post-flip the terminal
 *       send still finalizes — the transport's isClientGone() is false
 *       because Bun hides the state, so the pairing record is the real
 *       200. A 499 on this leg under Bun would be a FALSE POSITIVE and is
 *       asserted away.
 *   M2 server-destroy (socket.destroy() on the SERVER-side socket — the
 *   sanctioned simulation of "the state Node's runtime produces on abort",
 *   same technique as the MITM 499 case):
 *     • Node: exactly one 499 on both implementations.
 *     • Bun:  pre-flip ZERO events (close hook dead); post-flip exactly
 *       one 499 — `socket.destroyed` IS observable at send time, so the
 *       terminal gone-check synthesizes it (the flip's pairing fix for the
 *       Fastify leg).
 *
 * Zero-edit invariants pinned across both implementations: the client
 * REQUEST event is always exactly one; client RESPONSE events are AT MOST
 * one (never a double emit), never a 499+200 pair, and every present 499
 * record is the exact nginx-convention shape. Strict counts are asserted
 * wherever BOTH implementations agree (Node always; server-destroy left
 * lenient on Bun because pre-flip is provably silent there).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CaptureRecorder } from '../src/capture/recorder.js';

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun === 'object';

const TEST_KEY = 'sk-ocr-capture-abort-test';

interface ClientEvent {
  status: string;
  phase: string;
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
let port: number;
let lastServerSocket: net.Socket | undefined;

/** One-shot mid-flight hold: the NEXT process() call parks after entry. */
let holdGate: { promise: Promise<void>; release: () => void } | null = null;
function armHold(): () => void {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => (release = r));
  holdGate = { promise, release };
  return release;
}

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

/** Client events for one turn, matched by the unique marker echoed in the
 *  captured requestBody (present on BOTH the request and the response event). */
function eventsFor(marker: string, phase: string): ClientEvent[] {
  return readClientEvents().filter((e) => e.phase === phase && e.wire.requestBody.includes(marker));
}

/** Poll until the predicate holds (recorder appends asynchronously). */
async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`capture events did not settle within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Raw HTTP/1.1 POST over a live socket the test can destroy mid-flight. */
function rawPost(urlPath: string, bodyJson: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        [
          `POST ${urlPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Content-Type: application/json',
          `Authorization: Bearer ${TEST_KEY}`,
          `Content-Length: ${Buffer.byteLength(bodyJson)}`,
          '',
          bodyJson,
        ].join('\r\n')
      );
      resolve(sock);
    });
    sock.on('error', reject);
  });
}

/** The exact nginx-convention synthesis shape (499 object literal contract). */
function assertAbortRecord(ev: ClientEvent, urlPath: string): void {
  assert.equal(ev.wire.status, 499, `${urlPath}: abort response record is the nginx-convention 499`);
  assert.equal(ev.wire.responseLine, 'HTTP/1.1 499 Client Closed Request');
  assert.equal(ev.status, 'error');
  // The origin-form inbound line survives on the 499 record.
  assert.equal(ev.wire.requestLine, `POST ${urlPath} HTTP/1.1`);
}

/**
 * Abort matrix cell: kill the socket while the orchestrator call is
 * mid-flight (the exchange ctx is already attached at that point), then
 * release the handler so its send lands on a dead connection.
 */
async function abortCase(urlPath: string, bodyObj: Record<string, unknown>, mechanism: 'client-destroy' | 'server-destroy'): Promise<void> {
  const marker = `ABORT-${mechanism}-${urlPath}-${Date.now()}`;
  const release = armHold();
  const sock = await rawPost(
    urlPath,
    JSON.stringify({ ...bodyObj, messages: [{ role: 'user', content: marker }] })
  );
  // Request event on disk ⇒ process() entered ⇒ exchange ctx attached.
  await waitUntil(() => eventsFor(marker, 'request').length === 1);

  if (mechanism === 'client-destroy') sock.destroy();
  else lastServerSocket?.destroy(); // the state Node produces on an abort
  await new Promise((r) => setTimeout(r, 150));
  release(); // handler resumes and sends into the dead socket
  if (!IS_BUN) {
    // Node delivers a paired record on both mechanisms and both impls.
    await waitUntil(() => eventsFor(marker, 'response').length === 1);
  } else {
    await new Promise((r) => setTimeout(r, 500)); // settle window for any emit
  }

  const reqEvents = eventsFor(marker, 'request');
  const resEvents = eventsFor(marker, 'response');
  const statuses = resEvents.map((e) => e.wire.status);
  assert.equal(reqEvents.length, 1, `${urlPath}/${mechanism}: exactly one client REQUEST event`);
  assert.ok(resEvents.length <= 1, `${urlPath}/${mechanism}: at most one client RESPONSE event (never a double emit)`);
  assert.ok(
    !(statuses.includes(200) && statuses.includes(499)),
    `${urlPath}/${mechanism}: never a 499+200 pair for one exchange`
  );

  if (mechanism === 'server-destroy') {
    assert.equal(statuses.filter((s) => s === 200).length, 0, `${urlPath}: known-dead socket must NEVER capture a 200`);
    for (const ev of resEvents) assertAbortRecord(ev, urlPath);
    if (!IS_BUN) {
      assert.equal(resEvents.length, 1, `${urlPath}: Node must pair the request with the 499 record`);
    }
  } else if (!IS_BUN) {
    // client-destroy on Node is a real abort the transports observe.
    assert.equal(resEvents.length, 1, `${urlPath}: Node must pair the request with the 499 record`);
    assertAbortRecord(resEvents[0]!, urlPath);
  } else {
    // Bun is documented-blind to client-side destroys (header matrix M1):
    // pre-flip emits nothing, post-flip blind-pairs the real 200. A 499
    // here would be a false positive from broken gone-detection.
    for (const ev of resEvents) {
      assert.equal(ev.wire.status, 200, `${urlPath}: Bun-hidden abort can only blind-pair the real status (never 499)`);
    }
  }
  sock.destroy();
}

describe('capture-abort (real listener, Fastify leg)', () => {
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-abort-'));
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.apiKeys = [
      {
        id: 'key-capture-abort',
        name: 'capture-abort fixture',
        key: TEST_KEY,
        role: 'user',
        enabled: true,
        createdAt: new Date().toISOString(),
      },
    ];
    config.requestCapture = { enabled: true, dir: tmp, retentionDays: 7, maxTotalMB: 64, maxBodyBytes: 65536 };

    const created = createServer(config, true); // mockMode
    app = created.app;
    app.server.on('connection', (s) => (lastServerSocket = s));
    const realProcess = created.orchestrator.process.bind(created.orchestrator);
    created.orchestrator.process = async (request, context) => {
      // The capture branch (emitClientRequest + setClientExchangeContext)
      // runs SYNCHRONOUSLY before process's first await, so calling
      // realProcess() once and then parking guarantees "aborted mid-flight,
      // exchange ctx already attached" — no src test hooks needed.
      const inflight = realProcess(request, context);
      const hold = holdGate;
      if (hold) {
        holdGate = null;
        await hold.promise;
      }
      return inflight;
    };
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as net.AddressInfo).port;
  });

  after(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('chat client-destroy mid-flight: request paired, never a double emit, Node-only 499', async () => {
    await abortCase('/v1/chat/completions', { model: 'auto' }, 'client-destroy');
  });

  it('anthropic wire client-destroy mid-flight: same discipline on /v1/messages', async () => {
    await abortCase('/v1/messages', { model: 'auto', max_tokens: 64 }, 'client-destroy');
  });

  it('chat server-destroy mid-flight (Node-abort state): dead socket never yields 200', async () => {
    await abortCase('/v1/chat/completions', { model: 'auto' }, 'server-destroy');
  });

  it('anthropic wire server-destroy mid-flight: /v1/messages 499-only record', async () => {
    await abortCase('/v1/messages', { model: 'auto', max_tokens: 64 }, 'server-destroy');
  });

  it('normal completion: exactly one 200 response event, no 499', async () => {
    const marker = `NORMAL-${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: marker }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    await waitUntil(() => eventsFor(marker, 'response').length === 1);

    const reqEvents = eventsFor(marker, 'request');
    const resEvents = eventsFor(marker, 'response');
    assert.equal(reqEvents.length, 1);
    assert.equal(resEvents.length, 1, 'exactly one response event on normal completion');
    const ev = resEvents[0]!;
    assert.equal(ev.wire.status, 200);
    assert.equal(ev.status, 'ok');
    assert.equal(ev.wire.responseLine, 'HTTP/1.1 200 OK');
    // Single-stash guard: the captured body must be one complete JSON doc
    // (a double stash would break JSON.parse with trailing garbage).
    const parsed = JSON.parse(ev.wire.responseBody);
    assert.ok(parsed.choices, 'responseBody is one complete chat.completion JSON');
    assert.ok(ev.wire.responseHeaders['x-ocr-tier'], 'staged X-OCR headers reach the capture map');
    assert.ok(String(ev.wire.responseHeaders['content-type'] ?? '').includes('application/json'));
    assert.equal(resEvents.some((e) => e.wire.status === 499), false, 'no 499 on a live socket');
  });

  it('SSE normal completion: one 200 event; capture map = full beginSse wire shape', async () => {
    const marker = `STREAM-${Date.now()}`;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: marker }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('data: [DONE]'), 'stream completed on the wire');

    await waitUntil(() => eventsFor(marker, 'response').length === 1);
    const reqEvents = eventsFor(marker, 'request');
    const resEvents = eventsFor(marker, 'response');
    assert.equal(reqEvents.length, 1);
    assert.equal(resEvents.length, 1, 'exactly one response event on normal stream completion');
    const ev = resEvents[0]!;
    assert.equal(ev.wire.status, 200);
    // OBSERVED today-shape (probed 2026-10-12, both runtimes): the capture
    // map is reply.getHeaders() = staged mirror map (X-OCR) merged over the
    // raw response map — and whether writeHead()'d headers stay visible in
    // the raw map is RUNTIME-DEPENDENT: Node hides them (contract §4's
    // "stream capture has no content-type" — the Node-canonical truth),
    // Bun exposes them. Pre- and post-flip read the SAME source, so this
    // whole per-runtime shape is the preserved invariant — a shape change
    // post-flip is a flip bug, never a test edit.
    if (IS_BUN) {
      assert.equal(ev.wire.responseHeaders['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(ev.wire.responseHeaders['connection'], 'keep-alive');
      assert.equal(ev.wire.responseHeaders['access-control-allow-origin'], '*');
    } else {
      assert.equal(ev.wire.responseHeaders['content-type'], undefined, 'Node stream capture has no content-type (§4, pinned as-is)');
      assert.equal(ev.wire.responseHeaders['connection'], undefined);
      assert.equal(ev.wire.responseHeaders['access-control-allow-origin'], undefined);
    }
    // Staged X-OCR mirror reaches the capture too (beginSse parity).
    assert.ok(ev.wire.responseHeaders['x-ocr-tier'], 'staged X-OCR-Tier captured');
    assert.ok(ev.wire.responseHeaders['x-ocr-model'], 'staged X-OCR-Model captured');
    assert.ok(ev.wire.responseHeaders['x-ocr-trace-id'], 'staged X-OCR-Trace-ID captured');
    // Single-stash guard for the SSE path: exactly one DONE sentinel.
    assert.equal(ev.wire.responseBody.split('data: [DONE]').length - 1, 1, 'responseBody stashed exactly once');
    assert.equal(resEvents.some((e) => e.wire.status === 499), false, 'no 499 on a live socket');
  });
});
