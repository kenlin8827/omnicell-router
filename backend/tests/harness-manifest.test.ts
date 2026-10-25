import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { manifestPath, readManifest } from '../src/harness/manifest.js';

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
