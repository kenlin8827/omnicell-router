import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync } from 'fflate';
import { findOnPath, installMihomoBinary, mihomoAssetName, resolveMihomoBinary } from '../../src/proxy/mihomo-binary.js';

describe('mihomo binary lookup', () => {
  test('asset names follow the MetaCubeX release spelling', () => {
    expect(mihomoAssetName('linux', 'x64', 'v1.19.15')).toEqual({ name: 'mihomo-linux-amd64-v1.19.15.gz', gzip: true });
    expect(mihomoAssetName('darwin', 'arm64', 'v1.19.15')).toEqual({ name: 'mihomo-darwin-arm64-v1.19.15.gz', gzip: true });
    expect(mihomoAssetName('win32', 'x64', 'v1.19.15')).toEqual({ name: 'mihomo-windows-amd64-v1.19.15.zip', gzip: false });
    expect(mihomoAssetName('linux', 'mips', 'v1.19.15')).toBeNull();
  });

  test('a configured path that is missing does not fall through to PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-bin-'));
    const decoy = path.join(dir, 'mihomo');
    fs.writeFileSync(decoy, 'x');
    fs.chmodSync(decoy, 0o755);
    const missed = resolveMihomoBinary(path.join(dir, 'missing'), dir);
    expect(missed.path).toBeNull();
    const found = resolveMihomoBinary(decoy);
    expect(found.path).toBe(decoy);
    expect(found.source).toBe('configured');
    expect(findOnPath('mihomo', dir)).toBe(decoy);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('install unpacks the matching release asset and does not log the url token', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-inst-'));
    const dest = path.join(dir, 'mihomo');
    const payload = zlib.gzipSync(Buffer.from('#!/bin/sh\necho ok\n'));
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('linux', 'x64', tag)!;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/releases/')) {
        return new Response(JSON.stringify({
          tag_name: tag,
          assets: [{ name: asset.name, browser_download_url: 'https://example.test/mihomo.gz?token=hide-me' }],
        }), { status: 200 });
      }
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
    const result = await installMihomoBinary({
      destPath: dest,
      version: tag,
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(tag);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo ok');
    expect(JSON.stringify(result)).not.toContain('hide-me');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('install unpacks a windows zip', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-zip-'));
    const dest = path.join(dir, 'mihomo.exe');
    const zipped = zipSync({ 'mihomo.exe': Buffer.from('MZ-fake') });
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('win32', 'arm64', tag)!;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/releases/')) {
        return new Response(JSON.stringify({
          tag_name: tag,
          assets: [{ name: asset.name, browser_download_url: 'https://example.test/mihomo.zip' }],
        }), { status: 200 });
      }
      return new Response(zipped, { status: 200 });
    }) as typeof fetch;
    const result = await installMihomoBinary({
      destPath: dest,
      version: '9.9.9',
      platform: 'win32',
      arch: 'arm64',
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toBe('MZ-fake');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a rate-limited API falls back to the release-page tag (403)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-403-'));
    const dest = path.join(dir, 'mihomo');
    const tag = 'v1.19.15';
    const payload = zlib.gzipSync(Buffer.from('#!/bin/sh\necho fallback\n'));
    const fetchImpl = (async (url: string) => {
      const href = String(url);
      if (href.includes('api.github.com')) return new Response('{"message":"rate limit"}', { status: 403 });
      if (href.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://github.com/MetaCubeX/mihomo/releases/tag/${tag}` },
        });
      }
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
    const result = await installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(tag);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo fallback');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a rate-limited API with no fallback tag reports the 403 and the token hint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-403x-'));
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('api.github.com')) return new Response('nope', { status: 403 });
      return new Response('nope', { status: 403 });
    }) as typeof fetch;
    const result = await installMihomoBinary({
      destPath: path.join(dir, 'mihomo'),
      platform: 'linux',
      arch: 'x64',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('release-lookup-failed');
    expect(result.error).toContain('403');
    expect(result.error).toContain('GITHUB_TOKEN');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a published asset digest is verified, and a mismatch destroys the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-sum-'));
    const dest = path.join(dir, 'mihomo');
    const payload = zlib.gzipSync(Buffer.from('#!/bin/sh\necho verified\n'));
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('linux', 'x64', tag)!;
    const fake = (body: Uint8Array, withDigest: boolean) => ((url: string) => {
      if (String(url).includes('api.github.com')) {
        return Promise.resolve(new Response(JSON.stringify({
          tag_name: tag,
          assets: [{
            name: asset.name,
            browser_download_url: 'https://example.test/mihomo.gz',
            ...(withDigest ? { digest: `sha256:${digest}` } : {}),
          }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    const good = await installMihomoBinary({
      destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: fake(payload, true),
    });
    expect(good.ok).toBe(true);
    expect(good.verified).toBe(true);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo verified');
    expect(fs.existsSync(`${dest}.part`)).toBe(false);

    // Upstream served bytes that are not the release file: refuse them, and
    // leave no part behind for the next attempt to resume from.
    fs.rmSync(dest, { force: true });
    const tampered = zlib.gzipSync(Buffer.from('#!/bin/sh\necho trojan\n'));
    const bad = await installMihomoBinary({
      destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: fake(tampered, true),
    });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('checksum-failed');
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an interrupted install continues at its offset and reuses the prefix', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-rs-'));
    const dest = path.join(dir, 'mihomo');
    const payload = zlib.gzipSync(Buffer.from('#!/bin/sh\necho resumed\n'));
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('linux', 'x64', tag)!;
    const half = Math.floor(payload.length / 2);
    const seen: Array<string | undefined> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('api.github.com')) {
        return new Response(JSON.stringify({
          tag_name: tag,
          assets: [{
            name: asset.name,
            browser_download_url: 'https://example.test/mihomo.gz',
            digest: `sha256:${digest}`,
          }],
        }), { status: 200 });
      }
      const range = init?.headers ? new Headers(init.headers).get('range') : null;
      seen.push(range ?? undefined);
      if (range) {
        const from = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
        return new Response(payload.subarray(from), {
          status: 206,
          headers: {
            'content-range': `bytes ${from}-${payload.length - 1}/${payload.length}`,
            'content-length': String(payload.length - from),
            etag: '"asset-etag"',
          },
        });
      }
      // First attempt: the host announces the whole asset and then closes the
      // stream halfway — the reported 503/connection-reset shape.
      return new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(payload.subarray(0, half));
          c.close();
        },
      }), {
        status: 200,
        headers: { 'content-length': String(payload.length), etag: '"asset-etag"' },
      });
    }) as typeof fetch;

    // First attempt: the host closes the stream early (the reported 503 case).
    const interrupted = await installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl });
    expect(interrupted.ok).toBe(false);
    expect(interrupted.code).toBe('download-incomplete');
    expect(fs.readFileSync(`${dest}.part`).length).toBe(half);

    // Second attempt: asks for the tail only — the prefix is never refetched.
    const resumed = await installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl });
    expect(resumed.ok).toBe(true);
    expect(resumed.resumedFrom).toBe(half);
    expect(resumed.verified).toBe(true);
    expect(seen).toEqual([undefined, `bytes=${half}-`]);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo resumed');
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('closing the console tab cancels the transfer instead of downloading on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-ab-'));
    const dest = path.join(dir, 'mihomo');
    const payload = zlib.gzipSync(Buffer.from('#!/bin/sh\necho cancelled\n'));
    const digest = crypto.createHash('sha256').update(payload).digest('hex');
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('linux', 'x64', tag)!;
    const controller = new AbortController();
    const releaseJson = () => new Response(JSON.stringify({
      tag_name: tag,
      assets: [{ name: asset.name, browser_download_url: 'https://example.test/mihomo.gz', digest: `sha256:${digest}` }],
    }), { status: 200 });

    let pulls = 0;
    const cancelThenStall = (async (url: string) => {
      if (String(url).includes('api.github.com')) return releaseJson();
      // The body stalls the moment the operator leaves the page: an unthreaded
      // signal would keep this stream open and keep writing the part file.
      return new Response(new ReadableStream<Uint8Array>({
        pull(c) {
          pulls += 1;
          c.enqueue(payload.subarray(0, Math.floor(payload.length / 2)));
          controller.abort();
        },
      }), { status: 200, headers: { 'content-length': String(payload.length), etag: '"asset-etag"' } });
    }) as typeof fetch;

    const first = await installMihomoBinary({
      destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: cancelThenStall, signal: controller.signal,
    });
    expect(first.ok).toBe(false);
    expect(first.code).toBe('download-aborted');
    expect(pulls).toBe(1);
    // Never a half-installed binary: the destination is untouched and the
    // staging file is either a usable prefix or, when nothing flushed, gone.
    expect(fs.existsSync(dest)).toBe(false);
    if (fs.existsSync(`${dest}.part`)) {
      const sidecar = JSON.parse(fs.readFileSync(`${dest}.part.json`, 'utf8')) as { etag?: string; url?: string };
      expect(sidecar.etag).toBe('"asset-etag"');
    } else {
      expect(fs.existsSync(`${dest}.part.json`)).toBe(false);
    }

    // The next click finishes the job, resuming or refetching as the prefix says.
    const seen: Array<string | null> = [];
    const finisher = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('api.github.com')) return releaseJson();
      const range = new Headers(init?.headers).get('range');
      seen.push(range);
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      if (from > 0) {
        return new Response(payload.subarray(from), {
          status: 206,
          headers: {
            'content-range': `bytes ${from}-${payload.length - 1}/${payload.length}`,
            'content-length': String(payload.length - from),
            etag: '"asset-etag"',
          },
        });
      }
      return new Response(payload, { status: 200, headers: { etag: '"asset-etag"' } });
    }) as typeof fetch;

    const second = await installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: finisher });
    expect(second.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo cancelled');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('two concurrent installs share one destination instead of tearing it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-mihomo-race-'));
    const dest = path.join(dir, 'mihomo');
    const tag = 'v9.9.9';
    const asset = mihomoAssetName('linux', 'x64', tag)!;
    let overlap = 0;
    let maxOverlap = 0;
    const make = (text: string) => (async (url: string) => {
      if (String(url).includes('api.github.com')) {
        return new Response(JSON.stringify({
          tag_name: tag,
          assets: [{ name: asset.name, browser_download_url: 'https://example.test/mihomo.gz' }],
        }), { status: 200 });
      }
      overlap += 1;
      maxOverlap = Math.max(maxOverlap, overlap);
      // Yield twice so an unserialised second call would interleave here.
      await Promise.resolve();
      await Promise.resolve();
      overlap -= 1;
      return new Response(zlib.gzipSync(Buffer.from(text)), { status: 200 });
    }) as typeof fetch;

    const [a, b] = await Promise.all([
      installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: make('echo first\n') }),
      installMihomoBinary({ destPath: dest, platform: 'linux', arch: 'x64', fetchImpl: make('echo second\n') }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(maxOverlap).toBe(1);
    expect(fs.readFileSync(dest, 'utf8')).toContain('echo second');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
