/**
 * An engine UPGRADE, end to end against a fake release host: the installer must
 * report the directory it supersedes, and the record must move to the new
 * version instead of accumulating a second row.
 *
 * This pins the contract the route relies on — `installEngine` never decides
 * whether the old directory may be deleted (that is run knowledge, held by the
 * route), it only states which directory the new record just orphaned.
 */
import '../helpers/sandbox-home.js';
import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  engineById,
  engineInstallRoot,
  readInstalledEngines,
  registerEngine,
  unregisterEngine,
} from '../../src/local/engines.js';
import { installEngine } from '../../src/local/install.js';

const ENGINE_ID = 'prune-upgrade-engine';
const BIN = 'prune-upgrade-server';
const BLOCK = 512;

function tarHeader(name: string, size: number, type: string, mode = 0o755): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarEntry(name: string, data: Buffer): Buffer {
  const padded = data.length + ((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([tarHeader(name, data.length, '0'), data, Buffer.alloc(padded - data.length)]);
}

/** One single-binary release archive, as the fake host serves it. */
function releaseAsset(version: string): Buffer {
  const tar = Buffer.concat([
    tarEntry(`bin/${BIN}`, Buffer.from(`#!/bin/sh\necho ${version}\n`)),
    Buffer.alloc(BLOCK * 2),
  ]);
  return gzipSync(tar);
}

const ARCHIVE_BY_TAG = new Map<string, Buffer>();
const realFetch = globalThis.fetch;

/** Serves `releases/latest` and the tag-addressed asset of the fake engine. */
function installFakeFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/releases/latest')) {
      const tag = [...ARCHIVE_BY_TAG.keys()].at(-1)!;
      return new Response(JSON.stringify({
        tag_name: tag,
        assets: [{ name: `prune-engine-${tag}.tar.gz` }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const match = /prune-engine-(.+)\.tar\.gz$/.exec(url);
    const archive = match ? ARCHIVE_BY_TAG.get(decodeURIComponent(match[1])) : undefined;
    if (!archive) return new Response('not found', { status: 404 });
    // A body with no validators keeps the download on the simple path.
    return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
  }) as typeof fetch;
}

function registerFakeEngine(): void {
  registerEngine({
    id: ENGINE_ID,
    name: 'Prune Upgrade Engine',
    repo: 'example/prune-upgrade',
    description: 'test double',
    binaryNames: [BIN],
    targets: () => [{ id: 'cpu', backend: 'cpu', label: 'CPU', requires: ['cpu'], approxBytes: 0 }],
    matchAssets: ({ tag }) => ({ assets: [`prune-engine-${tag}.tar.gz`], version: tag }),
    resolveRelease: async () => {
      const tag = [...ARCHIVE_BY_TAG.keys()].at(-1)!;
      return { tag, assets: [`prune-engine-${tag}.tar.gz`] };
    },
  });
}

afterAll(() => {
  globalThis.fetch = realFetch;
  unregisterEngine(ENGINE_ID);
});

describe('installEngine on an upgrade', () => {
  test('reports the superseded directory and moves the record to the new version', async () => {
    registerFakeEngine();
    installFakeFetch();

    ARCHIVE_BY_TAG.set('b1000', releaseAsset('b1000'));
    const first = await installEngine({ engineId: ENGINE_ID, target: 'cpu' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.supersededDir).toBeUndefined();
    const oldDir = first.installed.installDir;
    expect(fs.existsSync(path.join(oldDir, 'bin', BIN))).toBe(true);

    // The upgrade: a newer tag, same target → same state key.
    ARCHIVE_BY_TAG.set('b2000', releaseAsset('b2000'));
    const second = await installEngine({ engineId: ENGINE_ID, target: 'cpu' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // The installer names what it orphaned so the route can sweep it — and
    // leaves the directory alone (whether it may go is run knowledge).
    expect(second.supersededDir).toBe(oldDir);
    expect(fs.existsSync(oldDir)).toBe(true);

    // One row per target, pointing at the new build: an upgrade never stacks.
    const state = readInstalledEngines();
    const rows = Object.values(state).filter((row) => row.engine === ENGINE_ID);
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe('b2000');
    expect(path.resolve(rows[0].installDir).startsWith(path.resolve(engineInstallRoot()))).toBe(true);
  }, 60_000);

  test('a same-version reinstall supersedes nothing', async () => {
    registerFakeEngine();
    installFakeFetch();

    ARCHIVE_BY_TAG.set('b3000', releaseAsset('b3000'));
    const first = await installEngine({ engineId: ENGINE_ID, target: 'cpu' });
    expect(first.ok).toBe(true);
    // Reinstalling the SAME tag unpacks into the same directory, so there is no
    // orphan to report — the sweep must never be handed its own destination.
    const again = await installEngine({ engineId: ENGINE_ID, target: 'cpu' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.supersededDir).toBeUndefined();
    expect(engineById(ENGINE_ID)).not.toBeNull();
  }, 60_000);
});