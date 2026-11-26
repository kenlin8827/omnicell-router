/**
 * The core-owned `local` provider (ADR-0038 §1–3, §7): ids are
 * `local/<name ?? installedId>` and carry more than one slash, the endpoint
 * resolves from the LIVE run rather than a config `baseUrl`, and a stopped run
 * is a 503 STATE that must never be recorded as an upstream failure.
 */
import '../helpers/sandbox-home.js';
import { describe, expect, test, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { modelsRoot, type InstalledModel } from '../../src/local/model-store.js';
import {
  LOCAL_BASE_SENTINEL,
  LOCAL_PROVIDER_ID,
  LocalDialProvider,
  LocalRunInactiveError,
  installedIdFromLocal,
  localBaseFor,
  localModelId,
  localModelRegistrations,
} from '../../src/local/local-provider.js';
import type { ModelRegistration } from '../../src/config/types.js';

const INSTALLED_ID = 'local-import/tiny-llama.gguf';
const REGISTRY_ID = `local/${INSTALLED_ID}`;
const NAMED_ID = 'local-import/named-llama.gguf';
const NAMED_NAME = 'my-llama';
const NAMED_REGISTRY_ID = `local/${NAMED_NAME}`;

/** Minimal registry record for the id helpers — only the fields they read. */
function recordOf(over: Partial<InstalledModel> & { id: string }): InstalledModel {
  return {
    repo: 'local-import',
    filename: over.id.split('/').pop() ?? over.id,
    filePath: path.join(modelsRoot(), over.filename ?? 'model.gguf'),
    size: 0,
    downloadedAt: 0,
    ...over,
  } as InstalledModel;
}

beforeAll(() => {
  const dir = modelsRoot();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'tiny-llama.gguf');
  const namedFilePath = path.join(dir, 'named-llama.gguf');
  fs.writeFileSync(filePath, '');
  fs.writeFileSync(namedFilePath, '');
  fs.writeFileSync(path.join(dir, 'installed.json'), `${JSON.stringify({
    [INSTALLED_ID]: {
      id: INSTALLED_ID,
      repo: 'local-import',
      filename: 'tiny-llama.gguf',
      filePath,
      size: 0,
      downloadedAt: Date.now(),
    },
    [NAMED_ID]: {
      id: NAMED_ID,
      repo: 'local-import',
      filename: 'named-llama.gguf',
      filePath: namedFilePath,
      size: 0,
      downloadedAt: Date.now(),
      name: NAMED_NAME,
    },
  }, null, 2)}\n`);
});

describe('local model ids', () => {
  test('an unnamed record registers under its installed id, slashes and all', () => {
    expect(localModelId(recordOf({ id: INSTALLED_ID }))).toBe(REGISTRY_ID);
    expect(installedIdFromLocal(REGISTRY_ID)).toBe(INSTALLED_ID);
  });

  test('a named record registers under local/<name> and resolves back (ADR-0038 §7)', () => {
    expect(localModelId(recordOf({ id: NAMED_ID, name: NAMED_NAME }))).toBe(NAMED_REGISTRY_ID);
    // Reverse resolution prefers the operator name over the literal slice.
    expect(installedIdFromLocal(NAMED_REGISTRY_ID)).toBe(NAMED_ID);
  });

  test('a name that is only whitespace behaves as unnamed', () => {
    expect(localModelId(recordOf({ id: INSTALLED_ID, name: '   ' }))).toBe(REGISTRY_ID);
  });

  test('a foreign id is not a local id', () => {
    expect(installedIdFromLocal('openai/gpt-4o')).toBe(null);
  });
});

describe('localModelRegistrations', () => {
  test('every installed model is registered under the one local provider', () => {
    const models = localModelRegistrations();
    const row = models.find((m) => m.id === REGISTRY_ID);
    expect(row).toBeDefined();
    const registration = row as ModelRegistration;
    expect(registration.provider).toBe(LOCAL_PROVIDER_ID);
    expect(registration.upstreamModel).toBe('tiny-llama');
    // Membership is opt-in: a local model never auto-enters a tier pool.
    expect(registration.tier).toBeUndefined();
    // Declared zero, not derived zero (ADR-0038 §2 / ADR-0035).
    expect(registration.pricing).toEqual({ input: 0, output: 0, cacheRead: 0 });
    expect(registration.wire).toBe('openai-chat');
  });

  test('a named record registers as local/<name> and serves under that name', () => {
    const models = localModelRegistrations();
    const row = models.find((m) => m.id === NAMED_REGISTRY_ID);
    expect(row).toBeDefined();
    expect(row?.provider).toBe(LOCAL_PROVIDER_ID);
    // The upstream alias is the operator name (ADR-0038 §7), not the file stem.
    expect(row?.upstreamModel).toBe(NAMED_NAME);
    // The named record never ALSO registers under its registry id.
    expect(models.find((m) => m.id === `local/${NAMED_ID}`)).toBeUndefined();
  });
});

describe('LocalDialProvider', () => {
  const model = { id: REGISTRY_ID, provider: LOCAL_PROVIDER_ID } as ModelRegistration;

  test('a stopped run resolves to nothing — no sentinel is ever dialed', () => {
    expect(localBaseFor(INSTALLED_ID)).toBe(null);
    const provider = new LocalDialProvider();
    // Egress reporting must stay non-throwing for an unserved model.
    expect(provider.dialBaseFor(model)).toBeUndefined();
    expect(LOCAL_BASE_SENTINEL).toContain(':0/');
  });

  test('the stopped state is a 503 breaker-exempt error, not a connection fault', async () => {
    const provider = new LocalDialProvider();
    let caught: unknown;
    try {
      await provider.createCompletion({} as never, model);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalRunInactiveError);
    const err = caught as LocalRunInactiveError;
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('local_run_inactive');
    expect(err.breakerExempt).toBe(true);
    expect(err.message).toContain('/local-run');
  });

  test('a non-local id is a caller bug and says so', async () => {
    const provider = new LocalDialProvider();
    let caught: unknown;
    try {
      await provider.createCompletion({} as never, { id: 'openai/gpt-4o', provider: 'openai' } as ModelRegistration);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('not a local model id');
  });
});
