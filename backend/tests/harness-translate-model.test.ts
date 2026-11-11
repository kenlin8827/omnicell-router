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
  readCachedTranslations,
  translateDescription,
  translateMarkdown,
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
  'schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n' +
  '  apiKeys:\n    - id: key-test\n      name: test\n      key: sk-ocr-internal-test\n      enabled: true\n      createdAt: "2026-01-01T00:00:00.000Z"\n';

function writeDefaultsConfig(translationModel?: string): void {
  const section = translationModel === undefined ? '' : `ops:\n  defaultModels:\n    translation: ${translationModel}\n`;
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
    writeRawConfig('schemaVersion: 1\nclient:\n  port: 3000\n  host: 127.0.0.1\n  apiKeys: []\n');
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

describe('README re-translate', () => {
  it('bypasses the cached rendering on refresh and keeps the newest one', async () => {
    writeDefaultsConfig('my-cheap-model');
    const doc = 'Release notes prose that a second run may want to replace';
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      calls += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: `译文${calls}` } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    const translate = (refresh?: boolean) =>
      app.inject({
        method: 'POST',
        url: '/api/admin/harness/translate',
        payload: { text: doc, lang: 'zh', format: 'markdown', ...(refresh ? { refresh } : {}) },
      });
    try {
      const first = (await translate()).json() as { text: string; cached: boolean };
      expect(first.cached).toBe(false);
      expect(first.text).toBe('译文1');

      // The plain path answers from the cache: an operator reading the dialog again spends nothing.
      const reused = (await translate()).json() as { text: string; cached: boolean };
      expect(reused.cached).toBe(true);
      expect(reused.text).toBe('译文1');
      expect(calls).toBe(1);

      // `refresh` is the re-translate: a new call, and the replacement lands in the store.
      const fresh = (await translate(true)).json() as { text: string; cached: boolean };
      expect(fresh.cached).toBe(false);
      expect(fresh.text).toBe('译文2');
      expect(calls).toBe(2);
      expect(readCachedTranslations([doc], 'zh', 'readme')[doc]?.text).toBe('译文2');
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});

describe('translateMarkdown full coverage', () => {
  it('translates every prose segment of a long README, keeps code verbatim, and caches the result', async () => {
    writeDefaultsConfig('my-cheap-model');
    // 5 paragraphs × ~5 000 characters: 25 000 characters of prose, past the old 20 000 cut-off.
    const doc = `${Array.from({ length: 5 }, (_, i) => `P${i} ${'x'.repeat(5000)}`).join('\n\n')}\n\n\`\`\`bash\nnpm i thing\n\`\`\`\n`;
    const chunkTexts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      chunkTexts.push(body.messages[1]?.content ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '译' } }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown(doc, 'zh');
      if ('code' in result) throw new Error(`expected a translation, got ${result.code}`);
      expect(result.cached).toBe(false);
      // Every chunk went to the gateway — no segment was left in the source language.
      expect(chunkTexts).toHaveLength(10);
      expect((result.text.match(/译/g) ?? []).length).toBe(10);
      expect(result.text).not.toContain('xxxxxxxxxx');
      expect(result.text).toContain('\`\`\`bash\nnpm i thing\n\`\`\`');

      const again = await translateMarkdown(doc, 'zh');
      if ('code' in again) throw new Error(`expected a cache hit, got ${again.code}`);
      expect(again.cached).toBe(true);
      expect(again.text).toBe(result.text);
      expect(chunkTexts).toHaveLength(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses a segment the provider cut at its token limit and stores nothing', async () => {
    writeDefaultsConfig('my-cheap-model');
    const doc = '# A page\n\nprose that a capped completion would end mid-sentence';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '被截断的' }, finish_reason: 'length' }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown(doc, 'zh');
      expect('code' in result && result.code).toBe('upstream');
      expect(readCachedTranslations([doc], 'zh', 'readme')[doc]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries a chunk whose transport died instead of failing the whole document', async () => {
    writeDefaultsConfig('my-cheap-model');
    const doc = 'Retry page prose that must survive one reset socket';
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      // First chunk attempt: both model legs die on the socket. The retry then answers.
      if (calls <= 2) throw new Error('socket connection was closed unexpectedly');
      const body = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '译' }, finish_reason: 'stop' }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown(doc, 'zh');
      if ('code' in result) throw new Error(`expected a retry to succeed, got ${result.message.slice(0, 120)}`);
      expect(result.text).toBe('译');
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries a segment that dropped a link (tag verification)', async () => {
    writeDefaultsConfig('my-cheap-model');
    const doc = '# Links\n\nRead the [guide](https://example.com/guide) before starting.';
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { model: string };
      // First attempt (both legs): the translation quietly drops the link. The retry keeps it.
      const content = calls <= 2 ? '# 链接\n\n开始前请阅读指南。' : '# 链接\n\n开始前请阅读[指南](https://example.com/guide)。';
      return new Response(
        JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown(doc, 'zh');
      if ('code' in result) throw new Error(`expected verification to recover, got ${result.message.slice(0, 160)}`);
      expect(result.text).toContain('https://example.com/guide');
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps finished segments, so a rerun after a failed document only translates what is missing', async () => {
    writeDefaultsConfig('my-cheap-model');
    // Two oversized paragraphs → two chunks each; 'A' chunks succeed, 'C' chunks never do.
    const doc = `${'A'.repeat(4600)}\n\n${'C'.repeat(4600)}`;
    let calls = 0;
    const originalFetch = globalThis.fetch;
    let failC = true;
    globalThis.fetch = (async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      const asked = body.messages[1]?.content ?? '';
      if (failC && asked.includes('CCCC')) throw new Error('upstream unavailable');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '译' }, finish_reason: 'stop' }], model: body.model }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;
    try {
      const failed = await translateMarkdown(doc, 'zh');
      expect('code' in failed).toBe(true);
      const callsAfterFailure = calls;
      expect(callsAfterFailure).toBeGreaterThan(6);

      failC = false;
      calls = 0;
      const resumed = await translateMarkdown(doc, 'zh');
      if ('code' in resumed) throw new Error(`expected a resumed run, got ${resumed.message.slice(0, 160)}`);
      // The two 'A' segments came from the segment store; only the two 'C' chunks hit the gateway.
      expect(calls).toBe(2);
      expect(resumed.text).toBe('译\n\n译\n\n译\n\n译');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('answers timeout without spending a call when the document deadline has already passed', async () => {
    writeDefaultsConfig('my-cheap-model');
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('must not be reached');
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown('a document whose deadline is already gone', 'zh', { timeoutMs: 0 });
      expect('code' in result && result.code).toBe('timeout');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('translate-stream route', () => {
  it('reports chunk progress and ends with the finished rendering', async () => {
    writeDefaultsConfig('my-cheap-model');
    // Two paragraphs of 5 000 characters: each is sliced at 4 500, so the plan is 4 chunks.
    const doc = `${'P'.repeat(5000)}\n\n${'Q'.repeat(5000)}`;
    const asked: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      if (String(url).includes('/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
        asked.push(body.messages[1]?.content?.slice(0, 1) ?? '');
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '译' }, finish_reason: 'stop' }], model: body.model }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(url as Parameters<typeof fetch>[0], init);
    }) as unknown as typeof fetch;
    const app = fastify();
    registerHarnessRoutes(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      // A bound TCP listener reports an AddressInfo; the cast only names that library shape.
      const addr = app.server.address() as { port: number } | null;
      if (!addr) throw new Error('test server reported no address');
      const port = addr.port;
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/harness/translate-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: doc, lang: 'zh', format: 'markdown' }),
      });
      expect(res.status).toBe(200);
      const events = (await res.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; done?: number; total?: number; text?: string });

      const progress = events.filter((e) => e.type === 'progress');
      expect(progress[0]).toEqual({ type: 'progress', done: 0, total: 4 });
      expect(progress.map((e) => e.done)).toEqual([0, 1, 2, 3, 4]);
      const final = events.at(-1)!;
      expect(final.type).toBe('result');
      expect((final.text?.match(/译/g) ?? []).length).toBe(4);
      expect(asked).toHaveLength(4);
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });
});
