import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialPaths, ocrCredentialsFile } from '../src/opencode/credentials/paths.js';
import { OcrStore } from '../src/opencode/credentials/ocr-store.js';
import { CredentialNotFoundError } from '../src/opencode/credentials/types.js';

/**
 * OcrStore reorder — the operator chain-order primitive on the OCR file
 * (schema v2: row-array order IS the chain order, `active` follows position 0).
 * Also pins the v1→v2 read normalization (legacy derived order, no write-back)
 * and the version 2 stamp on the first mutation.
 */

function sandboxPaths(): CredentialPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-store-'));
  const paths: CredentialPaths = {
    configDir: path.join(dir, 'config', 'opencode'),
    dataDir: path.join(dir, 'data', 'opencode'),
    authJsonPath: path.join(dir, 'data', 'opencode', 'auth.json'),
    opencodeDbPath: path.join(dir, 'data', 'opencode', 'opencode.db'),
    installedVersionPath: path.join(dir, 'config', 'opencode', 'installed.version'),
    ocrHome: path.join(dir, 'ocr-home'),
    serviceJsonCandidates: [path.join(dir, 'config', 'opencode', 'service.json')],
  };
  fs.mkdirSync(paths.ocrHome, { recursive: true });
  return paths;
}

function readFile(p: CredentialPaths): any {
  return JSON.parse(fs.readFileSync(ocrCredentialsFile(p), 'utf8'));
}

function writeFile(p: CredentialPaths, body: unknown): void {
  fs.writeFileSync(ocrCredentialsFile(p), JSON.stringify(body));
}

describe('OcrStore.reorder', () => {
  it('reorders the array, flips the head (active follows position 0), bumps the head timeUpdated, saves as v2', async () => {
    const p = sandboxPaths();
    const store = new OcrStore({ paths: p, now: (() => { let t = 100; return () => (t += 1); })() });
    await store.connectKey('anthropic', 'sk-ord-a', undefined);
    await store.connectKey('anthropic', 'sk-ord-b', undefined);
    const ids = store.listCredentials('anthropic').map((m) => m.id);
    expect(ids).toHaveLength(2);

    const out = await store.reorder('anthropic', [ids[1]!, ids[0]!]);
    expect(out.map((m) => m.id)).toEqual([ids[1], ids[0]]);
    expect(out[0]!.active).toBe(true);
    expect(out[1]!.active).toBe(false);

    const file = readFile(p);
    expect(file.version).toBe(2);
    expect(file.providers.anthropic.map((r: { credentialId: string }) => r.credentialId)).toEqual([ids[1], ids[0]]);
    expect(file.providers.anthropic[0].active).toBe(true);
    expect(file.providers.anthropic[0].timeUpdated).toBeGreaterThan(file.providers.anthropic[1].timeUpdated);

    // the chain reads in the new array order
    expect(store.resolveKeyChain('anthropic').map((c) => c.credentialId)).toEqual([ids[1], ids[0]]);
    expect(store.resolveKey('anthropic')!.credential.id).toBe(ids[1]);
  });

  it('permutation validation: unknown id → CredentialNotFoundError; duplicates / length mismatch → Error; no write', async () => {
    const p = sandboxPaths();
    const store = new OcrStore({ paths: p });
    await store.connectKey('anthropic', 'sk-val-a');
    await store.connectKey('anthropic', 'sk-val-b');
    const ids = store.listCredentials('anthropic').map((m) => m.id);
    const before = readFile(p);

    await expect(store.reorder('anthropic', [ids[0]!, 'nope'])).rejects.toBeInstanceOf(CredentialNotFoundError);
    await expect(store.reorder('anthropic', [ids[0]!, ids[0]!])).rejects.toThrow(/duplicate/);
    await expect(store.reorder('anthropic', [ids[0]!])).rejects.toThrow(/expected 2 credential ids/);

    // no mutation slipped through
    expect(readFile(p)).toEqual(before);
  });

  it('a version 1 file is normalized to the legacy derived order on read (no write-back) and stamped v2 on the first mutation', async () => {
    const p = sandboxPaths();
    // v1 shape: inactive-newest standby FIRST in the array (legacy derivation
    // puts the active row first) — the file order is NOT the chain order yet.
    writeFile(p, {
      version: 1,
      providers: {
        anthropic: [
          { credentialId: 'c-b', key: 'sk-v1-b', timeCreated: 1, timeUpdated: 50, active: false },
          { credentialId: 'c-a', key: 'sk-v1-a', timeCreated: 1, timeUpdated: 10, active: true },
          { credentialId: 'c-c', key: 'sk-v1-c', timeCreated: 1, timeUpdated: 30, active: false },
        ],
      },
    });
    const store = new OcrStore({ paths: p });
    // normalized: active first, then standbys newest timeUpdated first
    expect(store.listCredentials('anthropic').map((m) => m.id)).toEqual(['c-a', 'c-b', 'c-c']);
    expect(store.resolveKeyChain('anthropic').map((c) => c.credentialId)).toEqual(['c-a', 'c-b', 'c-c']);
    // reading never writes: still v1 on disk
    expect(readFile(p).version).toBe(1);

    // first mutation stamps version 2 with array order authoritative
    await store.reorder('anthropic', ['c-c', 'c-a', 'c-b']);
    const file = readFile(p);
    expect(file.version).toBe(2);
    expect(file.providers.anthropic.map((r: { credentialId: string; active: boolean }) => `${r.credentialId}:${r.active}`)).toEqual([
      'c-c:true',
      'c-a:false',
      'c-b:false',
    ]);
  });
});
