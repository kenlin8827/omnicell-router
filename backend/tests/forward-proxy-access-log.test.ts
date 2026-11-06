import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAccessTap,
  listProxyAccessEvents,
  readProxyAccessBodyFile,
  setProxyAccessLogPersistDir,
  setProxyAccessLogSettingsReader,
  clearProxyAccessLog,
  proxyAccessLogSettings,
} from '../src/forward-proxy/access-log.js';
import { DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES } from '../src/config/defaults.js';

/**
 * Bounded body capture for the forward-proxy access log.
 *
 * The ledger is fed by a FULL-CAPTURE proxy, so an uncapped body buffer means
 * whole downloads in the heap. These tests pin the three regimes: spill to a
 * raw body file (persisting, nothing lost), truncation at the cap (no disk
 * sink), and the finite default cap when the config omits `bodyBytes`.
 */

const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pa-'));

function tapFor(cap: number | undefined, persist: boolean): NonNullable<ReturnType<typeof createAccessTap>> {
  setProxyAccessLogPersistDir(persistDir);
  setProxyAccessLogSettingsReader(() => ({ enabled: true, bodyBytes: cap, persist, persistDays: 7 }));
  clearProxyAccessLog();
  const tap = createAccessTap({
    host: 'h.test',
    port: 443,
    method: 'GET',
    path: '/body',
    requestHeaders: { host: 'h.test' },
  });
  assert.ok(tap, 'the tap exists while the log is enabled');
  return tap;
}

/** Push `body` in small chunks so the cap boundary lands mid-chunk. */
function pushInChunks(tap: { onResChunk(chunk: Buffer): void }, body: Buffer): void {
  for (let i = 0; i < body.length; i += 7) tap.onResChunk(body.subarray(i, i + 7));
}

describe('forward-proxy access log: bounded body capture', () => {
  it('spills an over-cap body to a raw file — full bytes, nothing dropped, no inline copy', () => {
    const tap = tapFor(16, true);
    const body = Buffer.from('0123456789'.repeat(6)); // 60 bytes, cap 16
    pushInChunks(tap, body);
    tap.finish(200, { 'content-type': 'text/plain' });

    const [ev] = listProxyAccessEvents();
    assert.equal(ev.truncated, false, 'spilling keeps every byte — the row is not truncated');
    assert.equal(ev.respBytes, body.length);
    assert.equal(ev.responseBody, undefined, 'an inline rendering would defeat the cap');
    assert.ok(ev.resBodyFile, 'the whole body lives in a body file');
    const stored = readProxyAccessBodyFile(ev.resBodyFile!);
    assert.ok(stored, 'the body file is readable through the console ref');
    assert.deepEqual(Buffer.from(stored!), body, 'the spill file holds the complete body');
  });

  it('truncates at the cap when there is no disk sink (bounded heap, no file)', () => {
    const tap = tapFor(16, false);
    const body = Buffer.from('0123456789'.repeat(6));
    pushInChunks(tap, body);
    tap.finish(200, { 'content-type': 'text/plain' });

    const [ev] = listProxyAccessEvents();
    assert.equal(ev.truncated, true, 'dropped bytes must be visible on the row');
    assert.equal(ev.resBodyFile, undefined, 'persistence off means no body file');
    assert.equal(ev.respBytes, body.length, 'byte counters still report the real wire size');
    assert.equal(ev.responseBody, '0123456789'.repeat(2).slice(0, 16), 'the in-cap prefix is kept');
  });

  it('falls back to the finite default cap when the config omits bodyBytes', () => {
    const tap = tapFor(undefined, false);
    assert.equal(proxyAccessLogSettings().bodyBytes, DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES);
    const body = Buffer.alloc(DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES + 1, 0x61);
    pushInChunks(tap, body);
    tap.finish(200, { 'content-type': 'text/plain' });

    const [ev] = listProxyAccessEvents();
    assert.equal(ev.truncated, true, 'the default cap is finite — an unbounded buffer is the bug');
    assert.equal(ev.responseBody?.length, DEFAULT_PROXY_ACCESS_LOG_BODY_BYTES);
  });

  it('keeps headers-only capture (bodyBytes 0) free of bodies and truncation', () => {
    const tap = tapFor(0, true);
    pushInChunks(tap, Buffer.from('ignored-body'));
    tap.finish(204, { 'content-type': 'text/plain' });

    const [ev] = listProxyAccessEvents();
    assert.equal(ev.truncated, false, 'headers-only is a deliberate choice, not truncation');
    assert.equal(ev.responseBody, undefined);
    assert.equal(ev.resBodyFile, undefined);
    assert.equal(ev.respBytes, 'ignored-body'.length);
  });
});
