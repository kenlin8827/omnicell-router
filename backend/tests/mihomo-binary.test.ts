import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipSync } from 'fflate';
import { findOnPath, installMihomoBinary, mihomoAssetName, resolveMihomoBinary } from '../src/proxy/mihomo-binary.js';

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
});
