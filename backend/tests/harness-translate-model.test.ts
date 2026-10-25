import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import { loadConfig } from '../src/config/index.js';
import {
  PROBE_TEXT,
  getCachedTranslation,
  probeTranslationChain,
  translateDescription,
  translationChain,
} from '../src/harness/translation.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * The translation model chain is an operator cost decision (ADR-0015): `defaultModels.translation`
 * names the primary, the `lite` alias is the tail, and `auto` never appears unsolicited — an
 * internal, non-critical call must not have unbounded spend. The chain resolves through
 * loadConfig per call, so the tests rewrite the sandbox config.yaml between cases exactly as an
 * operator edit would.
 */

// Same isolation idiom as decision-capture.test.ts: this file owns its OCR_HOME.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-translate-model-'));
process.env.OCR_HOME = path.join(sandbox, 'home');
// This file owns its home → declare its book-set name too (the runner injects `itest`).
process.env.OCR_ENV = 'default';
const ENV_DIR = path.join(process.env.OCR_HOME, 'envs', 'default');
fs.mkdirSync(ENV_DIR, { recursive: true });
const BASE_CONFIG =
  'port: 3000\nhost: 127.0.0.1\nmodels: []\n' +
  'apiKeys:\n  - id: key-test\n    name: test\n    key: sk-ocr-internal-test\n    enabled: true\n    createdAt: "2026-01-01T00:00:00.000Z"\n';

function writeDefaultsConfig(translationModel?: string): void {
  const section = translationModel === undefined ? '' : `defaultModels:\n  translation: ${translationModel}\n`;
  fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), BASE_CONFIG + section, 'utf8');
}

function writeRawConfig(yaml: string): void {
  fs.writeFileSync(path.join(ENV_DIR, 'config.yaml'), yaml, 'utf8');
}

describe('translationChain', () => {
  it('is the lite alias alone when nothing is configured', () => {
    writeDefaultsConfig(undefined);
    expect(loadConfig().defaultModels).toBeUndefined();
    expect(translationChain()).toEqual(['lite']);
  });

  it('puts the configured modelRef first and keeps the lite tail', () => {
    writeDefaultsConfig('my-cheap-model');
    expect(translationChain()).toEqual(['my-cheap-model', 'lite']);
  });

  it('collapses a configured lite (or whitespace) back to the single tail', () => {
    writeDefaultsConfig('lite');
    expect(translationChain()).toEqual(['lite']);
    writeDefaultsConfig('"  "');
    expect(translationChain()).toEqual(['lite']);
  });

  it('contains no auto unless the operator explicitly wrote it', () => {
    for (const value of [undefined, 'my-cheap-model', 'lite']) {
      writeDefaultsConfig(value);
      expect(translationChain().includes('auto')).toBe(false);
    }
    // An explicit `auto` is the operator's own cost decision — honored verbatim.
    writeDefaultsConfig('auto');
    expect(translationChain()).toEqual(['auto', 'lite']);
  });
});

describe('translateDescription model chain', () => {
  it('spends the configured model first and records what served', async () => {
    writeDefaultsConfig('my-cheap-model');
    const askedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      askedModels.push(body.model);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '译文' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const result = await translateDescription('a description that has never been translated', 'zh');
      expect('code' in result).toBe(false);
      if ('code' in result) throw new Error(`expected a translation, got ${result.code}`);
      expect(askedModels).toEqual(['my-cheap-model']);
      expect(result.model).toBe('my-cheap-model');
      expect(result.cached).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('degrades a failing configured model to the lite tail, then errors honestly', async () => {
    writeDefaultsConfig('my-cheap-model');
    const askedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      askedModels.push(body.model);
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;
    try {
      const result = await translateDescription('another never-translated description', 'zh');
      expect('code' in result && result.code).toBe('upstream');
      expect(askedModels).toEqual(['my-cheap-model', 'lite']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('probeTranslationChain', () => {
  it('fires the real chain, reports the serving model, and never writes the cache', async () => {
    writeDefaultsConfig('my-cheap-model');
    const askedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      askedModels.push(body.model);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const probe = await probeTranslationChain();
      expect(probe.ok).toBe(true);
      expect(probe.model).toBe('my-cheap-model');
      expect(probe.chain).toEqual(['my-cheap-model', 'lite']);
      expect(askedModels).toEqual(['my-cheap-model']);
      // A probe is a diagnostic, not a translation — the derived store must stay empty.
      expect(getCachedTranslation(PROBE_TEXT, 'en')).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports every failing leg with its error when the whole chain fails', async () => {
    writeDefaultsConfig('my-cheap-model');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('tier pool is empty', { status: 503 })) as unknown as typeof fetch;
    try {
      const probe = await probeTranslationChain();
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('upstream');
      expect(probe.attempts.map(a => a.model)).toEqual(['my-cheap-model', 'lite']);
      for (const attempt of probe.attempts) {
        expect(attempt.ok).toBe(false);
        expect(attempt.error).toContain('503');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('answers no_api_key before spending a call', async () => {
    writeRawConfig('port: 3000\nhost: 127.0.0.1\nmodels: []\napiKeys: []\n');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('no key means no call');
    }) as unknown as typeof fetch;
    try {
      const probe = await probeTranslationChain();
      expect(probe.ok).toBe(false);
      expect(probe.code).toBe('no_api_key');
      expect(probe.attempts).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      writeDefaultsConfig(undefined);
    }
  });
  it('tests the pending picker value before any save (override wins over the saved config)', async () => {
    writeDefaultsConfig('saved-model');
    const askedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      askedModels.push(body.model);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const probe = await probeTranslationChain('en', 'pending-model');
      expect(probe.ok).toBe(true);
      expect(probe.chain).toEqual(['pending-model', 'lite']);
      expect(askedModels).toEqual(['pending-model']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('treats a cleared picker (empty override) as the plain lite tail', async () => {
    writeDefaultsConfig('saved-model');
    const askedModels: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      askedModels.push(body.model);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const probe = await probeTranslationChain('en', '');
      expect(probe.chain).toEqual(['lite']);
      expect(askedModels).toEqual(['lite']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('translation probe route', () => {
  it('returns the probe verdict over /translations/probe', async () => {
    writeDefaultsConfig('my-cheap-model');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/admin/harness/translations/probe', payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; model?: string; chain: string[] };
      expect(body.ok).toBe(true);
      expect(body.model).toBe('my-cheap-model');
      expect(body.chain).toEqual(['my-cheap-model', 'lite']);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
