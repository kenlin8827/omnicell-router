/**
 * Capture media offload (requestCapture.storeMedia) — recorder scrub +
 * content-addressed storage + the console read route.
 *
 * Pins:
 *  - OpenAI image_url data URLs and Anthropic image/document base64 sources
 *    become `[MEDIA …sha256=… file=media/<64hex>.<ext>]` placeholders; the
 *    decoded bytes land under <dir>/<date>/media/ exactly once (dedup).
 *  - storeMedia=false → placeholder WITHOUT file=, nothing on disk.
 *  - Scrub runs BEFORE the maxBodyBytes cut (a huge image no longer truncates
 *    the body).
 *  - Non-JSON / hex / image-free bodies pass through byte-identical.
 *  - getMediaFile + the route reject traversal-shaped date/hash (400) and
 *    serve stored files with a per-plugin Content-Type (200) / 404 miss.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { CaptureRecorder } from '../src/capture/recorder.js';
import type { WireBody } from '../src/capture/recorder.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-capture-media-'));
}

/** rm with the Windows EBUSY retry this repo's sandbox dirs need. */
function rmrf(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (i === 4) throw new Error(`cleanup failed for ${dir}`);
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}

/** Deterministic pseudo-random bytes (never valid UTF-8 text shapes). */
function bytes(n: number, seed: number): Buffer {
  const buf = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function b64(data: Buffer): string {
  return data.toString('base64');
}

function wireWith(requestBody: WireBody): any {
  return {
    requestLine: 'POST /v1/chat/completions HTTP/1.1',
    requestHeaders: {},
    requestBody,
    responseLine: '',
    status: 0,
    responseHeaders: {},
    responseBody: '',
  };
}

let counter = 0;
async function recordRequest(recorder: CaptureRecorder, requestBody: WireBody): Promise<string> {
  const sessionId = `media-test-${++counter}`;
  await recorder.recordEvent({
    eventType: 'http-exchange',
    direction: 'client',
    phase: 'request',
    traceId: `tr-${sessionId}`,
    spanId: `sp-${sessionId}`,
    sessionId,
    model: 'auto',
    status: 'ok',
    wire: wireWith(requestBody),
  } as any);
  return sessionId;
}

function readEvent(recorder: CaptureRecorder, sessionId: string): any {
  const dir = path.join(recorder.getDir(), CaptureRecorder.localDateDir(new Date()));
  const file = path.join(dir, CaptureRecorder.sessionFileName(sessionId));
  const line = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .pop();
  return JSON.parse(line!);
}

function mediaDirOf(recorder: CaptureRecorder): string {
  return path.join(recorder.getDir(), CaptureRecorder.localDateDir(new Date()), 'media');
}

/** Extract the first [MEDIA …] token from a string. */
function firstToken(s: string): RegExpMatchArray | null {
  return s.match(/\[MEDIA (.+?) sha256=([0-9a-f]{16})(?: file=([^\]]+))?\]/);
}

describe('capture media scrub (recorder)', () => {
  let tmp: string;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    recorder = new CaptureRecorder({ enabled: true, dir: tmp });
  });

  after(() => {
    recorder.stop();
    rmrf(tmp);
  });

  it('scrubs an OpenAI image_url data URL and stores the bytes once', async () => {
    const png = bytes(2048, 0xc0ffee);
    const dataUrl = `data:image/png;base64,${b64(png)}`;
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const sessionId = await recordRequest(recorder, JSON.stringify({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }));
    const ev = readEvent(recorder, sessionId);
    const body: string = ev.wire.requestBody;
    assert.ok(!body.includes('base64,'), 'payload must be gone from the archive line');
    const tok = firstToken(body);
    assert.ok(tok, 'placeholder present');
    assert.match(tok![1], /^image\/png /, 'media type + human size');
    assert.equal(tok![2], sha.slice(0, 16), 'sha256 prefix');
    assert.equal(tok![3], `media/${sha}.png`, 'file pointer');
    const stored = path.join(mediaDirOf(recorder), `${sha}.png`);
    assert.ok(fs.existsSync(stored), 'file landed on disk');
    assert.deepEqual(fs.readFileSync(stored), png, 'stored bytes are the decoded payload');
    // Dedupe: a second event carrying the SAME image must not rewrite the
    // file (sentinel check: mutate on disk, re-record, sentinel survives).
    fs.writeFileSync(stored, 'sentinel');
    await recordRequest(recorder, JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
    }));
    assert.equal(fs.readFileSync(stored, 'utf8'), 'sentinel', 'existing file is never rewritten');
  });

  it('scrubs Anthropic image and document base64 sources (jpg / pdf exts)', async () => {
    const jpg = bytes(1600, 7);
    const pdf = bytes(1200, 9);
    const sessionId = await recordRequest(recorder, JSON.stringify({
      model: 'claude',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(jpg) } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(pdf) } },
          ],
        },
      ],
    }));
    const body: string = readEvent(recorder, sessionId).wire.requestBody;
    const toks = [...body.matchAll(/\[MEDIA (.+?) sha256=([0-9a-f]{16}) file=media\/([0-9a-f]{64}\.[a-z]+)\]/g)];
    assert.equal(toks.length, 2);
    assert.match(toks[0][1], /^image\/jpeg /);
    assert.ok(toks[0][3].endsWith('.jpg'));
    assert.match(toks[1][1], /^application\/pdf /);
    assert.ok(toks[1][3].endsWith('.pdf'));
    assert.ok(fs.existsSync(path.join(mediaDirOf(recorder), toks[0][3])));
    assert.ok(fs.existsSync(path.join(mediaDirOf(recorder), toks[1][3])));
  });

  it('generic fallback scrubs any long base64 string value (keyword-guarded)', async () => {
    const blob = bytes(600, 42);
    const sessionId = await recordRequest(recorder, JSON.stringify({ audio: { type: 'base64', data: b64(blob) } }));
    const body: string = readEvent(recorder, sessionId).wire.requestBody;
    const tok = firstToken(body);
    assert.ok(tok, 'placeholder present');
    assert.match(tok![1], /^unknown /, 'mime unknown for bare base64');
    assert.ok(tok![3]!.endsWith('.bin'));
  });

  it('scrubs BEFORE truncation: a >maxBodyBytes image body archives untruncated', async () => {
    const tmp2 = makeTmpDir();
    const r2 = new CaptureRecorder({ enabled: true, dir: tmp2, maxBodyBytes: 4096 });
    try {
      const png = bytes(100_000, 5);
      const sessionId = `media-test-trunc-${counter + 1}`;
      const body = JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } }] }],
      });
      assert.ok(body.length > 4096, 'fixture must exceed the body cap');
      await r2.recordEvent({
        eventType: 'http-exchange',
        direction: 'client',
        phase: 'request',
        traceId: `tr-${sessionId}`,
        spanId: `sp-${sessionId}`,
        sessionId,
        model: 'auto',
        status: 'ok',
        wire: wireWith(body),
      } as any);
      const ev = readEvent(r2, sessionId);
      assert.notEqual(ev.truncated, true, 'scrubbed placeholder must fit the cap');
      assert.ok(!String(ev.wire.requestBody).endsWith('...[TRUNCATED]'));
      assert.ok(firstToken(String(ev.wire.requestBody)), 'placeholder survived');
    } finally {
      r2.stop();
      rmrf(tmp2);
    }
  });

  it('storeMedia=false → placeholder without file=, nothing written', async () => {
    const tmp3 = makeTmpDir();
    const r3 = new CaptureRecorder({ enabled: true, dir: tmp3, storeMedia: false });
    try {
      const png = bytes(1024, 11);
      const sessionId = `media-test-off-${counter + 1}`;
      await r3.recordEvent({
        eventType: 'http-exchange',
        direction: 'client',
        phase: 'request',
        traceId: `tr-${sessionId}`,
        spanId: `sp-${sessionId}`,
        sessionId,
        model: 'auto',
        status: 'ok',
        wire: wireWith(JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } }] }],
        })),
      } as any);
      const body: string = readEvent(r3, sessionId).wire.requestBody;
      const tok = firstToken(body);
      assert.ok(tok, 'placeholder still replaces the payload');
      assert.equal(tok![3], undefined, 'no file= segment when storage is off');
      assert.ok(!fs.existsSync(path.join(tmp3, CaptureRecorder.localDateDir(new Date()), 'media')));
    } finally {
      r3.stop();
      rmrf(tmp3);
    }
  });

  it('hot-applies storeMedia via applyConfig', async () => {
    const tmp4 = makeTmpDir();
    const r4 = new CaptureRecorder({ enabled: true, dir: tmp4 });
    try {
      r4.applyConfig({ storeMedia: false });
      assert.equal(r4.getStatus().storeMedia, false);
      r4.applyConfig({ storeMedia: true });
      assert.equal(r4.getStatus().storeMedia, true);
    } finally {
      r4.stop();
      rmrf(tmp4);
    }
  });

  it('passes through: hex bodies, non-JSON text, and image-free bodies', async () => {
    const hexBody: WireBody = { hex: b64(Buffer.from('data:image/png;base64,AAAA')).toString('hex') };
    const s1 = await recordRequest(recorder, hexBody);
    assert.deepEqual(readEvent(recorder, s1).wire.requestBody, hexBody);

    const notJson = 'plain text mentioning base64 and data:image, but not JSON at all';
    const s2 = await recordRequest(recorder, notJson);
    assert.equal(readEvent(recorder, s2).wire.requestBody, notJson);

    const clean = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] });
    const s3 = await recordRequest(recorder, clean);
    assert.equal(readEvent(recorder, s3).wire.requestBody, clean);
  });

  it('getMediaFile rejects traversal-shaped date/hash and serves real files', async () => {
    const png = bytes(512, 77);
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const sessionId = await recordRequest(recorder, JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } }] }],
    }));
    const date = CaptureRecorder.localDateDir(new Date());
    // Guards first: bad date shapes and non-hex / short / injected hashes.
    for (const [d, h] of [
      ['2026-1-1', sha],
      ['../etc', sha],
      [date, 'ZZZZZZZZZZZZZZZZ'],
      [date, sha.slice(0, 15)],
      [date, 'f'.repeat(65)],
      [date, '../../passwd'],
    ] as const) {
      assert.equal(recorder.getMediaFile(d, h), null, `must reject ${d}/${h}`);
    }
    assert.equal(recorder.getMediaFile(date, 'a'.repeat(64)), null, 'unknown hash → null');
    const hit = recorder.getMediaFile(date, sha.slice(0, 16));
    assert.ok(hit, '16-hex prefix resolves the content-addressed file');
    assert.equal(hit!.contentType, 'image/png');
    assert.deepEqual(hit!.data, png);
  });
});

describe('capture media route (console read surface)', () => {
  let tmp: string;
  let app: FastifyInstance;
  let recorder: CaptureRecorder;

  before(() => {
    tmp = makeTmpDir();
    const config = loadConfig();
    config.host = '127.0.0.1';
    config.webAuth = { enabled: false };
    config.requestCapture = { enabled: true, dir: tmp, retentionDays: 7, storeMedia: true };
    const booted = createServer(config, true);
    app = booted.app;
    recorder = booted.orchestrator.getCaptureRecorder();
  });

  after(async () => {
    await app.close();
    recorder.stop();
    rmrf(tmp);
  });

  it('serves stored media with 200 + content-type; 400 on bad params; 404 on miss', async () => {
    const png = bytes(800, 31);
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const sessionId = `media-route-${++counter}`;
    await recorder.recordEvent({
      eventType: 'http-exchange',
      direction: 'client',
      phase: 'request',
      traceId: `tr-${sessionId}`,
      spanId: `sp-${sessionId}`,
      sessionId,
      model: 'auto',
      status: 'ok',
      wire: wireWith(JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64(png)}` } }] }],
      })),
    } as any);
    const date = CaptureRecorder.localDateDir(new Date());

    let res = await app.inject({ method: 'GET', url: `/api/admin/capture/2026-1-1/media/${sha}` });
    assert.equal(res.statusCode, 400, 'bad date shape');

    res = await app.inject({ method: 'GET', url: `/api/admin/capture/${date}/media/DEADBEEF` });
    assert.equal(res.statusCode, 400, 'non-hex hash');

    res = await app.inject({ method: 'GET', url: `/api/admin/capture/${date}/media/..%2Fpasswd` });
    assert.equal(res.statusCode, 400, 'traversal-shaped hash');

    res = await app.inject({ method: 'GET', url: `/api/admin/capture/${date}/media/${'e'.repeat(64)}` });
    assert.equal(res.statusCode, 404, 'valid shape, no such file');

    res = await app.inject({ method: 'GET', url: `/api/admin/capture/${date}/media/${sha}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.deepEqual(Buffer.from(res.rawPayload), png);
    assert.match(String(res.headers['cache-control']), /immutable/);
  });
});
