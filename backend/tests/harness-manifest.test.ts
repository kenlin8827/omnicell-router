import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  manifestPath,
  readClaims,
  readManifest,
  retargetProjectRoot,
  writeClaims,
  writeManifest,
} from '../src/harness/host/manifest.js';

/**
 * Manifest read posture (ADR-0015 §D4): the manifest is the truth for what the gateway installed,
 * and every writer rewrites it whole. A read that cannot produce the real records must therefore
 * never answer "empty" silently — that answer would be written back and destroy the ledger.
 */

describe('readManifest', () => {
  it('answers an empty manifest when the file has never been written', () => {
    const file = manifestPath();
    if (fs.existsSync(file)) fs.rmSync(file);
    expect(readManifest()).toEqual({ version: 2, artifacts: [] });
  });

  it('sets unparsable bytes aside instead of returning an empty baseline over them', () => {
    const file = manifestPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');

    expect(readManifest()).toEqual({ version: 2, artifacts: [] });

    const aside = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(`${path.basename(file)}.corrupt-`));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]!), 'utf8')).toBe('{ not json');
  });

  it('sets a recognised-but-wrong shape aside too, and leaves no manifest behind', () => {
    const file = manifestPath();
    fs.writeFileSync(file, JSON.stringify({ version: 99, artifacts: [] }), 'utf8');

    expect(readManifest()).toEqual({ version: 2, artifacts: [] });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('retargetProjectRoot', () => {
  it('moves project copies and their claims when the registered path changes', () => {
    const oldRoot = path.join(os.tmpdir(), 'ocr-retarget-old');
    const newRoot = path.join(os.tmpdir(), 'ocr-retarget-new');
    const inside = path.join(oldRoot, '.agents', 'skills', 'demo');
    // An external copy's path is an identity token, not a location.
    const token = `${inside}#claude`;
    const now = new Date().toISOString();
    writeManifest({
      version: 2,
      artifacts: [
        {
          id: 'skill:manual:demo',
          canonicalKey: 'manual:demo',
          kind: 'skill',
          name: 'demo',
          sourceId: 'manual',
          pin: { adopted: true },
          contentHash: 'h',
          listedOn: ['manual'],
          trust: 'manual',
          copies: [
            {
              scope: 'project',
              host: 'universal',
              rootId: 'default',
              path: inside,
              projectRoot: oldRoot,
              contentHash: 'h',
              placement: 'materialized',
              installedAt: now,
            },
            {
              scope: 'project',
              host: 'claude',
              rootId: 'default',
              path: token,
              projectRoot: oldRoot,
              external: true,
              contentHash: 'h',
              placement: 'verified',
              installedAt: now,
            },
            {
              scope: 'global',
              host: 'claude',
              rootId: 'default',
              path: path.join(os.tmpdir(), 'ocr-global-skill'),
              contentHash: 'h',
              placement: 'materialized',
              installedAt: now,
            },
          ],
        },
      ],
    });
    writeClaims({ version: 1, claims: { [inside]: { env: 'itest', artifactId: 'skill:manual:demo' } } });

    retargetProjectRoot(oldRoot, newRoot);

    const copies = readManifest().artifacts[0]!.copies;
    expect(copies[0]!.path).toBe(path.join(newRoot, '.agents', 'skills', 'demo'));
    expect(copies[0]!.projectRoot).toBe(newRoot);
    expect(copies[1]!.path).toBe(token);
    expect(copies[1]!.projectRoot).toBe(newRoot);
    expect(copies[2]!.path).toBe(path.join(os.tmpdir(), 'ocr-global-skill'));
    expect(copies[2]!.projectRoot).toBeUndefined();

    const claims = readClaims().claims;
    expect(claims[path.join(newRoot, '.agents', 'skills', 'demo')]).toBeDefined();
    expect(claims[inside]).toBeUndefined();
  });
});
