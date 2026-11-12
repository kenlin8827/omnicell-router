import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import { stageGateway, commitGateways, removeGateway } from '../src/plugins/gateways.js';
import type { ClientGatewayPlugin, TrafficExchange } from '../src/plugins/types.js';
import {
  clearProxyAccessLog,
  createAccessTap,
  listProxyAccessEvents,
  setProxyAccessLogPersistDir,
  setProxyAccessLogSettingsReader,
} from '../src/forward-proxy/access-log.js';

/**
 * Generic plugin-traffic console routes (ADR-0017, Wireshark dissector model).
 *
 * The contract under test is the CAPTURE/DISPLAY split: capture is full
 * fidelity on disk (sidecar bodies, never a memory buffer, never truncated),
 * while the console read path is bounded — it hands the dissector a fixed
 * WINDOW and offers the whole file as a download. A regression here is the one
 * that hurts: a multi-megabyte body pushed into the browser's DOM.
 */

const baseConfig = loadConfig();
baseConfig.host = '127.0.0.1';
baseConfig.webAuth = { enabled: false };
const { app } = createServer(baseConfig, true);

const DECODER = 'testgw';
/** The dissector sees whatever bytes the route read — recorded for assertions. */
let seen: TrafficExchange[] = [];

const fakeGateway: ClientGatewayPlugin = {
  hosts: ['api.test.sh'],
  match: () => true,
  handle: async () => undefined,
  dissect: (ex) => {
    seen.push(ex);
    const bytes = ex.reqBody ? Buffer.from(ex.reqBody, 'base64') : Buffer.alloc(0);
    return { decoder: DECODER, layers: [{ name: 'window', frames: [{ bytes: bytes.length }] }] };
  },
};

let tmpHome = '';
let oldHome: string | undefined;

const feedDir = (): string => path.join(tmpHome, 'plugins', 'traffic', DECODER);

function writeFeed(rows: unknown[]): void {
  fs.mkdirSync(feedDir(), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(feedDir(), `${day}.jsonl`), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

function writeBody(ref: string, bytes: Buffer): void {
  const abs = path.join(feedDir(), 'bodies', ref);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-plugin-traffic-'));
  oldHome = process.env.OCR_HOME;
  process.env.OCR_HOME = tmpHome;
  seen = [];
  stageGateway(DECODER, fakeGateway);
  commitGateways();
});

afterEach(() => {
  removeGateway(DECODER);
  commitGateways();
  if (oldHome === undefined) delete process.env.OCR_HOME;
  else process.env.OCR_HOME = oldHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('plugin-traffic routes', () => {
  it('registers a decoder per gateway that declares dissect()', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/plugin-traffic' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { decoders: { id: string; label: string }[] };
    expect(body.decoders.map((d) => d.id)).toContain(DECODER);
    // The label is the claimed host set — the console's hint, not an identity.
    expect(body.decoders.find((d) => d.id === DECODER)?.label).toBe('api.test.sh');
  });

  it('reads a WINDOW of a full-fidelity sidecar body, never the whole payload', async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    // 4 MiB captured body — far past any display window.
    writeBody(`${day}/cx-1-req.bin`, Buffer.alloc(4 * 1024 * 1024, 0x41));
    writeFeed([
      { ts: '2026-11-06T00:00:00.000Z', authority: 'api.test.sh', method: 'POST', path: '/rpc', reqBodyFile: `${day}/cx-1-req.bin`, reqBodyBytes: 4 * 1024 * 1024 },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/admin/plugin-traffic/${DECODER}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Record<string, unknown>[] };
    const row = body.events[0]!;

    // Full byte count survives; the preview is bounded; no payload crosses.
    expect(row.reqBodyBytes).toBe(4 * 1024 * 1024);
    expect(row.reqBodyFile).toBe(`${day}/cx-1-req.bin`);
    expect(row.reqBody).toBeUndefined();
    expect((row.reqHex as string).length).toBe(1024 * 2); // 1 KiB hex preview
    // The dissector was handed the WINDOW (32 KiB), not the 4 MiB body.
    expect(Buffer.from(seen[0]!.reqBody ?? '', 'base64').length).toBe(32 * 1024);
  });

  it('streams the whole captured body through the NEUTRAL token route', async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const payload = Buffer.from('full-fidelity-capture');
    const ref = `${day}/cx-2-res.bin`;
    writeBody(ref, payload);
    writeFeed([{ ts: '2026-11-06T00:00:00.000Z', authority: 'api.test.sh', method: 'POST', path: '/rpc', resBodyFile: ref, resBodyBytes: payload.length }]);

    const feed = await app.inject({ method: 'GET', url: `/api/admin/plugin-traffic/${DECODER}` });
    const token = (feed.json() as { events: Record<string, unknown>[] }).events[0]!.resBodyToken as string;
    // The URL names no plugin and no storage subsystem — just an opaque token.
    expect(token).toBeString();
    expect(token).not.toContain(DECODER);

    const res = await app.inject({ method: 'GET', url: `/api/admin/traffic-body/${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(res.rawPayload).equals(payload)).toBe(true);
  });

  it('rejects a forged token instead of serving an arbitrary file', async () => {
    // A token is not a capability: the ref inside it is validated exactly like
    // an unauthenticated one, so traversal never reaches the filesystem.
    const forged = Buffer.from(JSON.stringify({ k: 'g', r: '../../../../etc/passwd', d: DECODER }), 'utf8').toString('base64url');
    const res = await app.inject({ method: 'GET', url: `/api/admin/traffic-body/${encodeURIComponent(forged)}` });
    expect(res.statusCode).toBe(404);

    // An unknown decoder in the token is refused as well.
    const wrongDecoder = Buffer.from(JSON.stringify({ k: 'g', r: 'x.bin', d: 'nope' }), 'utf8').toString('base64url');
    const res2 = await app.inject({ method: 'GET', url: `/api/admin/traffic-body/${encodeURIComponent(wrongDecoder)}` });
    expect(res2.statusCode).toBe(404);
  });

  it('still decodes a legacy row that carries an inline base64 body', async () => {
    writeFeed([
      { ts: '2026-11-06T00:00:00.000Z', authority: 'api.test.sh', method: 'POST', path: '/rpc', reqBody: Buffer.from('legacy').toString('base64') },
    ]);
    const res = await app.inject({ method: 'GET', url: `/api/admin/plugin-traffic/${DECODER}` });
    const row = (res.json() as { events: Record<string, unknown>[] }).events[0]!;
    expect(row.reqHex).toBe(Buffer.from('legacy').toString('hex'));
    expect(Buffer.from(seen[0]!.reqBody ?? '', 'base64').toString()).toBe('legacy');
  });
});

describe('live-scope clear (traffic-live-clear)', () => {
  const day = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const tsOf = (iso: string): number => Date.parse(iso);
  const liveRows = async (): Promise<Record<string, unknown>[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy-log?scope=live' });
    return (res.json() as { rows: { source: string; ex: Record<string, unknown> }[] }).rows
      .filter((r) => r.source === DECODER)
      .map((r) => r.ex);
  };
  const historyRows = async (): Promise<Record<string, unknown>[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/proxy-log?scope=history&kind=http&page=1&limit=50' });
    return (res.json() as { rows: { source: string; ex: Record<string, unknown> }[] }).rows
      .filter((r) => r.source === DECODER)
      .map((r) => r.ex);
  };

  it('hides only the named rows from the live view, never the feed', async () => {
    const d = day();
    writeBody(`${d}/cx-keep-req.bin`, Buffer.from('keep'));
    writeBody(`${d}/cx-drop-req.bin`, Buffer.from('drop'));
    writeFeed([
      { id: 'cx-keep', ts: '2026-11-06T00:00:00.000Z', path: '/keep', reqBodyFile: `${d}/cx-keep-req.bin` },
      { id: 'cx-drop', ts: '2026-11-06T00:00:01.000Z', path: '/drop', reqBodyFile: `${d}/cx-drop-req.bin` },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/traffic-live-clear',
      payload: { plugins: { [DECODER]: [{ key: 'cx-drop', ts: tsOf('2026-11-06T00:00:01.000Z') }] } },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { hidden: { plugins: Record<string, number> } }).hidden.plugins[DECODER]).toBe(1);

    expect((await liveRows()).map((e) => e.path)).toEqual(['/keep']);
    // The split: the feed (history scope) and the bytes are untouched.
    expect((await historyRows()).map((e) => e.path)).toEqual(['/drop', '/keep']);
    expect(fs.existsSync(path.join(feedDir(), 'bodies', `${d}/cx-drop-req.bin`))).toBe(true);
    expect(fs.existsSync(path.join(feedDir(), 'bodies', `${d}/cx-keep-req.bin`))).toBe(true);
  });

  it('falls back to `ts` for rows written before ids existed', async () => {
    writeFeed([{ ts: '2026-11-06T00:00:02.000Z', path: '/legacy-row' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/traffic-live-clear',
      payload: { plugins: { [DECODER]: [{ key: '2026-11-06T00:00:02.000Z', ts: tsOf('2026-11-06T00:00:02.000Z') }] } },
    });
    expect((res.json() as { hidden: { plugins: Record<string, number> } }).hidden.plugins[DECODER]).toBe(1);
    expect(await liveRows()).toHaveLength(0);
    expect(await historyRows()).toHaveLength(1);
  });

  it('ignores keys that match nothing instead of wiping the feed', async () => {
    writeFeed([{ id: 'cx-a', ts: '2026-11-06T00:00:03.000Z', path: '/a' }]);
    await app.inject({
      method: 'POST',
      url: '/api/admin/traffic-live-clear',
      payload: { plugins: { [DECODER]: [{ key: 'cx-nope', ts: tsOf('2026-11-06T00:00:03.000Z') }] } },
    });
    expect((await liveRows()).map((e) => e.path)).toEqual(['/a']);
    expect((await historyRows()).map((e) => e.path)).toEqual(['/a']);
  });
  it('hides a ring row from the live view without touching its day file', async () => {
    const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-pa-live-'));
    setProxyAccessLogPersistDir(persistDir);
    clearProxyAccessLog();
    setProxyAccessLogSettingsReader(() => ({ enabled: true, persist: true, persistDays: 7 }));
    const tap = createAccessTap({ host: 'p.test', port: 80, method: 'GET', path: '/ring', requestHeaders: { host: 'p.test' } });
    expect(tap).toBeDefined();
    tap!.finish(200, {});
    const row = listProxyAccessEvents()[0]!;
    const persisted = (): string[] =>
      fs.readdirSync(persistDir)
        .filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => fs.readFileSync(path.join(persistDir, f), 'utf8').split('\n').filter(Boolean))
        .map((l) => (JSON.parse(l) as { id: string }).id);
    expect(persisted()).toContain(row.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/traffic-live-clear',
      payload: { proxy: [{ key: row.id, ts: row.ts }] },
    });
    expect((res.json() as { hidden: { proxy: number } }).hidden.proxy).toBe(1);

    const live = await app.inject({ method: 'GET', url: '/api/admin/proxy-log?scope=live' });
    const ids = (live.json() as { rows: { source: string; ev: { id: string } }[] }).rows
      .filter((r) => r.source === 'proxy')
      .map((r) => r.ev.id);
    expect(ids).not.toContain(row.id);
    expect(listProxyAccessEvents().map((e) => e.id)).not.toContain(row.id);
    // The live action is ring-only: the persisted scope still owns the row, and
    // the history read ignores the live tombstone.
    expect(persisted()).toContain(row.id);
    const hist = await app.inject({ method: 'GET', url: '/api/admin/proxy-log?scope=history&kind=http&page=1&limit=50' });
    const histIds = (hist.json() as { rows: { source: string; ev: { id: string } }[] }).rows
      .filter((r) => r.source === 'proxy')
      .map((r) => r.ev.id);
    expect(histIds).toContain(row.id);

    clearProxyAccessLog();
    fs.rmSync(persistDir, { recursive: true, force: true });
  });

});

describe('history clear (proxy-log/history/delete)', () => {
  const day = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, '');

  it('deletes plugin rows under the default http kind filter', async () => {
    const d = day();
    writeBody(`${d}/cx-hist-req.bin`, Buffer.from('body'));
    writeFeed([
      { id: 'cx-hist', ts: '2026-11-06T00:00:04.000Z', authority: 'api.test.sh', method: 'GET', path: '/h', status: 200, reqBodyFile: `${d}/cx-hist-req.bin` },
    ]);

    // The history read shows plugin rows as HTTP; the delete must match them.
    const hist = await app.inject({ method: 'GET', url: '/api/admin/proxy-log?scope=history&kind=http&page=1&limit=50' });
    expect((hist.json() as { total: number }).total).toBe(1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy-log/history/delete',
      payload: { kind: 'http' },
    });
    expect((res.json() as { deleted: { plugins: Record<string, number> } }).deleted.plugins[DECODER]).toBe(1);
    expect(fs.existsSync(path.join(feedDir(), 'bodies', `${d}/cx-hist-req.bin`))).toBe(false);
    const feed = await app.inject({ method: 'GET', url: `/api/admin/plugin-traffic/${DECODER}` });
    expect((feed.json() as { events: unknown[] }).events).toHaveLength(0);
  });

  it('leaves plugin rows alone for a connect-scoped clear', async () => {
    writeFeed([
      { id: 'cx-keep-kind', ts: '2026-11-06T00:00:05.000Z', authority: 'api.test.sh', method: 'GET', path: '/k' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/proxy-log/history/delete',
      payload: { kind: 'connect' },
    });
    expect((res.json() as { deleted: { plugins: Record<string, number> } }).deleted.plugins[DECODER]).toBeUndefined();
    const feed = await app.inject({ method: 'GET', url: `/api/admin/plugin-traffic/${DECODER}` });
    expect((feed.json() as { events: unknown[] }).events).toHaveLength(1);
  });
});
