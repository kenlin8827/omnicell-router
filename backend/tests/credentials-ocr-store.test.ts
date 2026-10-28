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

describe('OcrStore.setWeight', () => {
  it('stores the weight, bumps timeUpdated, rides the chain and the masked meta', async () => {
    const p = sandboxPaths();
    const store = new OcrStore({ paths: p, now: (() => { let t = 100; return () => (t += 1); })() });
    const a = await store.connectKey('anthropic', 'sk-w-a');
    await store.connectKey('anthropic', 'sk-w-b');
    const updated = await store.setWeight(a.id, 3);
    expect(updated.weight).toBe(3);
    const rows = readFile(p).providers.anthropic;
    expect(rows.find((r: { credentialId: string }) => r.credentialId === a.id).weight).toBe(3);
    expect(rows.find((r: { credentialId: string }) => r.credentialId === a.id).timeUpdated).toBeGreaterThan(
      rows.find((r: { credentialId: string }) => r.credentialId === a.id).timeCreated
    );
    expect(rows.find((r: { credentialId: string }) => r.credentialId !== a.id).weight).toBeUndefined();
    // the raw chain (boot/refresh input) carries the weight; meta exposes it masked-only
    expect(store.resolveKeyChain('anthropic').find((c) => c.credentialId === a.id)?.weight).toBe(3);
    expect(store.listCredentials('anthropic').find((m) => m.id === a.id)?.weight).toBe(3);
    expect(store.listCredentials('anthropic').find((m) => m.id !== a.id)?.weight).toBeUndefined();
  });

  it('clamps out-of-range values and refuses unknown ids', async () => {
    const p = sandboxPaths();
    const store = new OcrStore({ paths: p });
    const a = await store.connectKey('anthropic', 'sk-w-clamp');
    expect((await store.setWeight(a.id, 0)).weight).toBe(1); // degenerate → floor
    expect((await store.setWeight(a.id, 10_000)).weight).toBe(100); // ceiling
    expect((await store.setWeight(a.id, 2.9)).weight).toBe(2); // integers only
    await expect(store.setWeight('nope', 2)).rejects.toBeInstanceOf(CredentialNotFoundError);
  });

  it('read-path sanitize: a hand-edited illegal weight degrades to ABSENT (= 1), never reaches the chain', async () => {
    const p = sandboxPaths();
    writeFile(p, {
      version: 2,
      providers: {
        anthropic: [
          { credentialId: 'c-a', key: 'sk-w-hand-a', timeCreated: 1, timeUpdated: 1, active: true, weight: 0 },
          { credentialId: 'c-b', key: 'sk-w-hand-b', timeCreated: 1, timeUpdated: 2, active: false, weight: 500 },
          { credentialId: 'c-c', key: 'sk-w-hand-c', timeCreated: 1, timeUpdated: 3, active: false, weight: 'x' },
          { credentialId: 'c-d', key: 'sk-w-hand-d', timeCreated: 1, timeUpdated: 4, active: false, weight: 2.5 },
        ],
      },
    });
    const store = new OcrStore({ paths: p });
    const metas = store.listCredentials('anthropic');
    expect(metas.find((m) => m.id === 'c-a')?.weight).toBeUndefined();
    expect(metas.find((m) => m.id === 'c-b')?.weight).toBe(100); // over-ceiling clamps to the max
    expect(metas.find((m) => m.id === 'c-c')?.weight).toBeUndefined(); // non-numeric degrades
    expect(metas.find((m) => m.id === 'c-d')?.weight).toBe(2); // fractional floors
    // chain view agrees
    const chain = store.resolveKeyChain('anthropic');
    expect(chain.find((c) => c.credentialId === 'c-b')?.weight).toBe(100);
    expect(chain.find((c) => c.credentialId === 'c-c')?.weight).toBeUndefined();
  });
});
