/**
 * extractTarGz regression: the Strata CUDA install wedged because a regular
 * file's whole payload had to sit in memory before its writer was created —
 * an O(n²) re-copy per gunzip chunk that slowed a 472 MiB unpack to a crawl
 * and idled the event loop with the install pending. These tests pin the
 * streaming behaviour: large files extract with content intact, and the
 * promise always settles.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractTarGz } from '../../src/local/tar.js';

const BLOCK = 512;

function tarHeader(name: string, size: number, type: string, mode = 0o644): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function tarEntry(name: string, data: Buffer, type = '0'): Buffer {
  const padded = data.length + ((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([tarHeader(name, data.length, type), data, Buffer.alloc(padded - data.length)]);
}

function makeArchive(entries: Buffer[]): string {
  const tar = Buffer.concat([...entries, Buffer.alloc(BLOCK * 2)]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tar-')), 'archive.tar.gz');
  fs.writeFileSync(file, gzipSync(tar));
  return file;
}

describe('extractTarGz', () => {
  test('streams a large file with content intact and settles', async () => {
    // 24 MiB of non-repeating bytes: big enough that whole-payload buffering
    // would show up as multi-second runtimes, patterned so corruption shows.
    const big = Buffer.alloc(24 << 20);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8)) & 0xff;
    const archive = makeArchive([
      tarEntry('BUILD.json', Buffer.from('{"ok":true}')),
      tarEntry('bin/big.dll', big),
      tarEntry('bin/tool.exe', Buffer.from('MZ-tool')),
    ]);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tar-out-'));
    const result = await extractTarGz(archive, dest);
    expect(result.files).toBe(3);
    const extracted = fs.readFileSync(path.join(dest, 'bin/big.dll'));
    expect(extracted.length).toBe(big.length);
    expect(createHash('sha256').update(extracted).digest('hex'))
      .toBe(createHash('sha256').update(big).digest('hex'));
    expect(fs.readFileSync(path.join(dest, 'BUILD.json'), 'utf8')).toBe('{"ok":true}');
  });

  test('reports archive-read progress up to the archive size', async () => {
    const data = Buffer.alloc(4 << 20, 7);
    const archive = makeArchive([tarEntry('blob.bin', data)]);
    const total = fs.statSync(archive).size;
    const seen: number[] = [];
    await extractTarGz(archive, fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tar-out-')), (read) => seen.push(read));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(total);
  });

  test('rejects a path-traversal entry instead of writing outside', async () => {
    const archive = makeArchive([tarEntry('../escape.txt', Buffer.from('nope'))]);
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tar-out-'));
    await expect(extractTarGz(archive, dest)).rejects.toThrow(/unsafe|escapes/);
    expect(fs.existsSync(path.join(dest, '..', 'escape.txt'))).toBe(false);
  });
});
