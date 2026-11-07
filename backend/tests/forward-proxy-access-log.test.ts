import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAccessTap,
  listProxyAccessEvents,
  readProxyAccessHistory,
  readProxyAccessBodyFile,
  setProxyAccessLogPersistDir,
  setProxyAccessLogSettingsReader,
  clearProxyAccessLog,
  deleteProxyAccessEvents,
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

describe('row-scoped deletion (the filter-scoped clear)', () => {
  /** A tap that does NOT reset the ledger — these tests need several rows. */
  const nextTap = (): NonNullable<ReturnType<typeof createAccessTap>> => {
    setProxyAccessLogPersistDir(persistDir);
    setProxyAccessLogSettingsReader(() => ({ enabled: true, bodyBytes: 1024, persist: true, persistDays: 7 }));
    const tap = createAccessTap({ host: 'h.test', port: 443, method: 'GET', path: '/row', requestHeaders: { host: 'h.test' } });
    assert.ok(tap);
    return tap;
  };

  it('removes exactly the named rows: ring, day file and body sidecars', () => {
    clearProxyAccessLog();
    const keep = nextTap();
    // Past the cap so the bytes really live in a sidecar (that is what gets deleted).
    keep.onResChunk(Buffer.alloc(2048, 0x4b));
    keep.finish(200, {});
    const drop = nextTap();
    drop.onResChunk(Buffer.alloc(2048, 0x44));
    drop.finish(200, {});

    const [dropEv, keepEv] = listProxyAccessEvents();
    assert.ok(dropEv && keepEv);
    const dropped = deleteProxyAccessEvents([dropEv.id]);
    assert.equal(dropped, 1, 'one row matched the key');

    const left = listProxyAccessEvents().map((e) => e.id);
    assert.deepEqual(left, [keepEv.id], 'only the named row is gone from the ring');
    // Its sidecar went with it; the survivor's bytes are untouched.
    assert.ok(dropEv.resBodyFile, 'the dropped row had a sidecar');
    assert.equal(readProxyAccessBodyFile(dropEv.resBodyFile!), null);
    assert.ok(readProxyAccessBodyFile(keepEv.resBodyFile!), 'neighbour bodies survive');

    // The persisted day file no longer resurrects it on reload.
    const dayFiles = fs.readdirSync(persistDir).filter((f) => f.endsWith('.jsonl'));
    const persisted = dayFiles
      .flatMap((f) => fs.readFileSync(path.join(persistDir, f), 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l) as { id: string });
    assert.deepEqual(persisted.map((r) => r.id), [keepEv.id]);
  });
});

describe('persisted history: filtered newest-first scan', () => {
  it('materializes the full day-JSONL history for the federated merge', () => {
    setProxyAccessLogPersistDir(persistDir);
    setProxyAccessLogSettingsReader(() => ({ enabled: true, bodyBytes: 64, persist: true, persistDays: 7 }));
    clearProxyAccessLog();
    // One tap per exchange — finish() retires it; each row gets a distinct status.
    // (tapFor clears the ledger, so this suite drives createAccessTap directly.)
    for (let i = 0; i < 5; i++) {
      const t = createAccessTap({
        host: 'h.test',
        port: 443,
        method: 'GET',
        path: '/body',
        requestHeaders: { host: 'h.test' },
      });
      assert.ok(t, 'the tap exists while the log is enabled');
      t.onResChunk(Buffer.from(`resp-${i}`));
      t.finish(200 + i, { 'content-type': 'text/plain' });
    }

    const all = readProxyAccessHistory();
    assert.equal(all.length, 5);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].ts >= all[i].ts, 'newest first');
    }

    // Server-side filters prune rows the same way the live view does.
    const f = readProxyAccessHistory({ status: '204' });
    assert.equal(f.length, 1);
    assert.equal(f[0].status, 204);
    const none = readProxyAccessHistory({ host: 'nope.invalid' });
    assert.equal(none.length, 0);
  });
});
