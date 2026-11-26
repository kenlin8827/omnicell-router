/**
 * Operator-chosen model names (ADR-0038 §7): `setModelName` validates the
 * token shape, enforces case-insensitive uniqueness across the registry, and
 * persists (or clears) the name without touching the registry key.
 */
import '../helpers/sandbox-home.js';
import { describe, expect, test, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  MODEL_NAME_RE,
  modelsRoot,
  readInstalledModels,
  setModelName,
} from '../../src/local/model-store.js';

const FIRST_ID = 'local-import/first.gguf';
const SECOND_ID = 'local-import/second.gguf';

beforeAll(() => {
  const dir = modelsRoot();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'first.gguf'), '');
  fs.writeFileSync(path.join(dir, 'second.gguf'), '');
  const state: Record<string, unknown> = {};
  for (const [id, file] of [
    [FIRST_ID, 'first.gguf'],
    [SECOND_ID, 'second.gguf'],
  ] as const) {
    state[id] = {
      id,
      repo: 'local-import',
      filename: file,
      filePath: path.join(dir, file),
      size: 0,
      downloadedAt: Date.now(),
    };
  }
  fs.writeFileSync(path.join(dir, 'installed.json'), `${JSON.stringify(state, null, 2)}\n`);
});

describe('MODEL_NAME_RE', () => {
  test('accepts URL- and config-safe tokens', () => {
    for (const ok of ['qwen3', 'My_Model', 'a.b-c', '0', 'x'.repeat(64)]) {
      expect(MODEL_NAME_RE.test(ok)).toBe(true);
    }
  });

  test('rejects slashes, whitespace, punctuation and overlong names', () => {
    for (const bad of ['', 'a/b', 'a b', '-lead', '.dot', '_under', 'naïve', '名字', 'x'.repeat(65)]) {
      expect(MODEL_NAME_RE.test(bad)).toBe(false);
    }
  });
});

describe('setModelName', () => {
  test('sets a valid name and persists it', () => {
    const result = setModelName(FIRST_ID, 'tiny');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.name).toBe('tiny');
    expect(readInstalledModels()[FIRST_ID]?.name).toBe('tiny');
  });

  test('the registry key never moves with a rename', () => {
    const result = setModelName(FIRST_ID, 'tiny-2');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.previousName).toBe('tiny');
    const state = readInstalledModels();
    expect(state[FIRST_ID]?.name).toBe('tiny-2');
    expect(state['tiny-2']).toBeUndefined();
  });

  test('surrounding whitespace is trimmed before validation', () => {
    const result = setModelName(FIRST_ID, '  padded  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.name).toBe('padded');
  });

  test('an invalid token is refused without touching the record', () => {
    const result = setModelName(FIRST_ID, 'bad name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid-name');
    expect(readInstalledModels()[FIRST_ID]?.name).toBe('padded');
  });

  test('name uniqueness is case-insensitive across records', () => {
    const result = setModelName(SECOND_ID, 'PADDED');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('name-taken');
    expect(readInstalledModels()[SECOND_ID]?.name).toBeUndefined();
  });

  test('re-setting the identical name is a no-op success', () => {
    const result = setModelName(FIRST_ID, 'padded');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model.name).toBe('padded');
  });

  test('an empty value clears the name', () => {
    const result = setModelName(FIRST_ID, '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model.name).toBeUndefined();
      expect(result.previousName).toBe('padded');
    }
    expect(readInstalledModels()[FIRST_ID]?.name).toBeUndefined();
  });

  test('clearing an unnamed record is a no-op success', () => {
    const result = setModelName(FIRST_ID, null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.previousName).toBeUndefined();
  });

  test('a missing model is reported, never created', () => {
    const result = setModelName('local-import/ghost.gguf', 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('model-missing');
  });
});
