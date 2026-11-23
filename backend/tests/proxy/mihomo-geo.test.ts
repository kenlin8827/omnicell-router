/**
 * Geo database lifecycle (ADR-0022): the files GEOIP / GEOSITE rules are
 * evaluated from are an EXPLICIT download, because the core exits fatally when
 * it has to fetch them itself and the fetch fails.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  downloadMihomoGeoAssets,
  geoAssetsPresent,
  geoReport,
  machineLegProxy,
  MIHOMO_GEO_ASSETS,
  rulesNeedGeo,
} from '../../src/proxy/mihomo-geo.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-geo-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mihomo geo databases', () => {
  test('the asset table names the files mihomo reads and the shared release host', () => {
    expect(MIHOMO_GEO_ASSETS.map((asset) => asset.file)).toEqual(['geoip.metadb', 'GeoSite.dat']);
    for (const asset of MIHOMO_GEO_ASSETS) {
      expect(asset.url.startsWith('https://github.com/MetaCubeX/meta-rules-dat/releases/')).toBe(true);
    }
  });

  test('rulesNeedGeo only fires on GEOIP / GEOSITE rows', () => {
    expect(rulesNeedGeo(undefined)).toBe(false);
    expect(rulesNeedGeo([])).toBe(false);
    expect(rulesNeedGeo([{ type: 'DOMAIN-SUFFIX', payload: 'a.example', target: 'DIRECT' }])).toBe(false);
    expect(rulesNeedGeo([{ type: 'GEOSITE', payload: 'cn', target: 'DIRECT' }])).toBe(true);
    expect(rulesNeedGeo([{ type: 'GEOIP', payload: 'CN', target: 'PROXY' }])).toBe(true);
  });

  test('the report tracks both files and their sizes', () => {
    const dir = tempDir();
    expect(geoReport(dir)).toEqual({
      present: false,
      files: [
        { key: 'geoip', file: 'geoip.metadb', exists: false, size: 0, stale: false },
        { key: 'geosite', file: 'GeoSite.dat', exists: false, size: 0, stale: false },
      ],
    });
    expect(geoAssetsPresent(dir)).toBe(false);

    fs.writeFileSync(path.join(dir, 'geoip.metadb'), 'mmdb');
    // One file is not "present": a half-installed pair still kills the core.
    expect(geoAssetsPresent(dir)).toBe(false);
    expect(geoReport(dir).files.map((file) => [file.key, file.exists, file.size])).toEqual([
      ['geoip', true, 4],
      ['geosite', false, 0],
    ]);

    fs.writeFileSync(path.join(dir, 'GeoSite.dat'), 'dat');
    expect(geoAssetsPresent(dir)).toBe(true);
  });

  test('an installed copy reports its mtime and turns stale past the advisory window', () => {
    const dir = tempDir();
    const file = path.join(dir, 'geoip.metadb');
    fs.writeFileSync(file, 'mmdb');
    const fresh = geoReport(dir).files.find((info) => info.key === 'geoip')!;
    expect(fresh.stale).toBe(false);
    expect(typeof fresh.updatedAt).toBe('number');

    // Older than MIHOMO_GEO_STALE_DAYS must read as stale, never as a reason to
    // block a start — the flag only drives the console's re-sync hint.
    const old = (Date.now() - 31 * 86_400_000) / 1000;
    fs.utimesSync(file, old, old);
    const aged = geoReport(dir).files.find((info) => info.key === 'geoip')!;
    expect(aged.stale).toBe(true);
    expect(aged.exists).toBe(true);
  });

  test('the machine leg dials the OS proxy unless the host is bypassed', () => {
    const endpoint = { server: '127.0.0.1:7897', bypass: ['*.internal', 'github.com'] };
    expect(machineLegProxy(undefined, 'https://github.com/x')).toBeUndefined();
    expect(machineLegProxy(endpoint, 'https://github.com/x')).toBeUndefined();
    expect(machineLegProxy(endpoint, 'https://objects.githubusercontent.com/x')).toBe('http://127.0.0.1:7897');
    expect(machineLegProxy({ server: 'http://proxy.lan:8080', bypass: [] }, 'https://github.com/x'))
      .toBe('http://proxy.lan:8080');
    // An unparseable target is a direct connection, never a proxy guess.
    expect(machineLegProxy(endpoint, 'not a url')).toBeUndefined();
  });

  test('downloads both assets, reports byte progress and skips existing files', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'geoip.metadb'), 'already-here');
    const requested: string[] = [];
    const progress: Array<[string, number, number]> = [];
    const fetchImpl = ((url: string) => {
      requested.push(url);
      const body = new Uint8Array([1, 2, 3, 4, 5]);
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-length': '5' } }));
    }) as unknown as typeof fetch;

    const result = await downloadMihomoGeoAssets(dir, {
      fetchImpl,
      onProgress: (file, downloaded, total) => progress.push([file, downloaded, total]),
    });
    expect(result.ok).toBe(true);
    expect(result.present).toBe(true);
    // Only the missing file was fetched — a retry after a partial failure must
    // not re-download a working copy.
    expect(requested).toEqual([MIHOMO_GEO_ASSETS[1].url]);
    expect(fs.readFileSync(path.join(dir, 'geoip.metadb'), 'utf8')).toBe('already-here');
    expect(fs.readFileSync(path.join(dir, 'GeoSite.dat')).length).toBe(5);
    expect(progress).toContainEqual(['geosite', 5, 5]);
    // The temporary download file never survives the rename.
    expect(fs.existsSync(path.join(dir, 'GeoSite.dat.download'))).toBe(false);
  });

  test('a failed download keeps the files that already exist', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'geoip.metadb'), 'keep-me');
    const fetchImpl = (() => Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    const result = await downloadMihomoGeoAssets(dir, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('geo-download-failed');
    expect(result.present).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'geoip.metadb'), 'utf8')).toBe('keep-me');
    expect(fs.existsSync(path.join(dir, 'GeoSite.dat'))).toBe(false);
  });

  test('refresh replaces existing copies, and a failed refresh keeps them', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'geoip.metadb'), 'old');
    fs.writeFileSync(path.join(dir, 'GeoSite.dat'), 'old');
    const requested: string[] = [];
    const fetchImpl = ((url: string) => {
      requested.push(url);
      return Promise.resolve(new Response('new', { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await downloadMihomoGeoAssets(dir, { fetchImpl, refresh: true });
    expect(result.ok).toBe(true);
    expect(requested).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'geoip.metadb'), 'utf8')).toBe('new');

    // The operator's "sync" must never trade a working copy for a broken one.
    const failing = (() => Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    const failed = await downloadMihomoGeoAssets(dir, { fetchImpl: failing, refresh: true });
    expect(failed.ok).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'geoip.metadb'), 'utf8')).toBe('new');
  });

  test('an empty body is a failure, not a zero-byte database', async () => {
    const dir = tempDir();
    const fetchImpl = (() => Promise.resolve(new Response(new Uint8Array(0), { status: 200 }))) as unknown as typeof fetch;
    const result = await downloadMihomoGeoAssets(dir, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('geo-download-failed');
    expect(fs.existsSync(path.join(dir, 'geoip.metadb'))).toBe(false);
  });

  test('a body past the 64MB cap is refused instead of buffered', async () => {
    const dir = tempDir();
    const oversize = new Uint8Array(64 * 1024 * 1024 + 1);
    const fetchImpl = (() => Promise.resolve(new Response(oversize, { status: 200 }))) as unknown as typeof fetch;
    const result = await downloadMihomoGeoAssets(dir, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('geo-download-too-large');
    expect(fs.existsSync(path.join(dir, 'geoip.metadb'))).toBe(false);
  });
});