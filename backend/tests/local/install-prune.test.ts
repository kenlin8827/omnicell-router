/**
 * The second half of an engine upgrade: the version directory the new build
 * replaced must not survive as an unreachable orphan, and must survive while a
 * run still pins a binary inside it.
 *
 * `pruneSupersededInstall` is the whole rule, so the boundaries pinned here are
 * the containment check (only inside the engines root), the usage veto, and the
 * "already gone" case an interrupted sweep leaves behind.
 */
import '../helpers/sandbox-home.js';
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { engineInstallRoot } from '../../src/local/engines.js';
import { pruneSupersededInstall } from '../../src/local/install.js';

/** A throwaway version directory under the REAL engines root, so the
 *  containment check sees the same shape production produces. */
function makeVersionDir(name: string): string {
  const dir = path.join(engineInstallRoot(), 'prune-test', name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'server'), 'stub');
  return dir;
}

describe('pruneSupersededInstall', () => {
  test('deletes the superseded version directory', () => {
    const dir = makeVersionDir('b9000-cpu');
    expect(pruneSupersededInstall(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('keeps the directory while a run pins a binary inside it', () => {
    const dir = makeVersionDir('b9001-cpu');
    try {
      const deleted = pruneSupersededInstall(dir, (candidate) =>
        path.resolve(candidate) === path.resolve(dir));
      expect(deleted).toBe(false);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to delete outside the engines root', () => {
    // A corrupt record must never aim the sweep at an arbitrary folder.
    const outside = fs.mkdtempSync(path.join(engineInstallRoot(), '..', 'prune-outside-'));
    try {
      expect(pruneSupersededInstall(outside)).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('refuses to delete the engines root itself', () => {
    const root = engineInstallRoot();
    expect(pruneSupersededInstall(root)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  test('a missing directory is a no-op, not a throw', () => {
    // An interrupted sweep (crash between the record write and the delete)
    // leaves no directory to remove; the next upgrade must not trip over it.
    const dir = path.join(engineInstallRoot(), 'prune-test', 'already-gone');
    expect(pruneSupersededInstall(dir)).toBe(false);
    expect(pruneSupersededInstall(undefined)).toBe(false);
  });
});