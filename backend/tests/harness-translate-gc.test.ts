import { beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastify from 'fastify';
import { harnessEnvDir } from '../src/harness/host/manifest.js';
import { pruneTranslationStore, readCachedTranslations } from '../src/harness/translation.js';
import { registerHarnessRoutes } from '../src/routes/harness.js';

/**
 * Housekeeping on the derived translation store.
 *
 * The store is one file per entry, so eviction is `unlink` — no rewrite, no risk of losing a
 * neighbour. The policy is age first, then a size budget with the OLDEST entries going first; a
 * crashed write's temp file is swept after an hour. None of this is correctness-bearing (the cache
 * is derived), which is exactly why it must never throw into a translation.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Every case starts from an empty store: the budget tests are meaningless over a shared directory. */
beforeEach(() => {
  for (const kind of ['descriptions', 'readme']) {
    fs.rmSync(path.join(harnessEnvDir(), 'i18n', kind), { recursive: true, force: true });
  }
  fs.rmSync(path.join(harnessEnvDir(), 'i18n', 'descriptions.json'), { force: true });
});

function seed(kind: 'descriptions' | 'readme', source: string, lang: string, ageMs: number): string {
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const dir = path.join(harnessEnvDir(), 'i18n', kind);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.${lang}.json`);
  fs.writeFileSync(file, JSON.stringify({ text: `译文 ${source}`, model: 'seeded/model', at: new Date().toISOString() }), 'utf8');
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

describe('pruneTranslationStore', () => {
  it('expires entries older than the age budget and keeps the fresh ones', () => {
    const ancient = seed('readme', 'ancient page', 'zh', 200 * DAY);
    const middle = seed('descriptions', 'middle description', 'zh', 2 * DAY);
    const fresh = seed('readme', 'fresh page', 'zh', 0);

    const stats = pruneTranslationStore({ maxAgeMs: 90 * DAY });

    expect(stats.removed).toBe(1);
    expect(stats.kept).toBe(2);
    expect(fs.existsSync(ancient)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('trims by size, oldest first, before touching anything newer', () => {
    const older = seed('readme', 'older page', 'zh', 3 * DAY);
    const newer = seed('readme', 'newer page', 'zh', 0);
    const budget = fs.statSync(newer).size + 1;

    const stats = pruneTranslationStore({ maxAgeMs: 0, maxBytes: budget });

    expect(stats.removed).toBe(1);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
    expect(stats.bytes).toBeLessThanOrEqual(budget);
  });

  it('sweeps a crashed write\u2019s temp file once it is old, and leaves a fresh one alone', () => {
    const dir = path.join(harnessEnvDir(), 'i18n', 'readme');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'abc.zh.json.tmp.1.1');
    const fresh = path.join(dir, 'def.zh.json.tmp.2.2');
    fs.writeFileSync(stale, '{}', 'utf8');
    fs.writeFileSync(fresh, '{}', 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    pruneTranslationStore();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('answers zeroes on an empty store instead of throwing', () => {
    const stats = pruneTranslationStore();
    expect(stats.removed).toBe(0);
    expect(stats.kept).toBe(0);
    expect(stats.bytes).toBe(0);
  });

  it('drops the pre-split blob only once IT is stale, never a blob that was just migrated from', () => {
    const blob = path.join(harnessEnvDir(), 'i18n', 'descriptions.json');
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    fs.writeFileSync(blob, JSON.stringify({ version: 1, entries: {} }), 'utf8');

    // Fresh (an upgrade that just happened): kept, because its entries may not be promoted yet.
    expect(pruneTranslationStore({ maxAgeMs: 90 * DAY }).removed).toBe(0);
    expect(fs.existsSync(blob)).toBe(true);

    const old = new Date(Date.now() - 120 * DAY);
    fs.utimesSync(blob, old, old);
    expect(pruneTranslationStore({ maxAgeMs: 90 * DAY }).removed).toBe(1);
    expect(fs.existsSync(blob)).toBe(false);
  });
});

describe('translation cache routes', () => {
  it('reads the README store for format=markdown and reports the truncation flag', async () => {
    const doc = '# Page\n\nbody';
    const hash = crypto.createHash('sha256').update(doc).digest('hex');
    const dir = path.join(harnessEnvDir(), 'i18n', 'readme');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${hash}.zh.json`),
      JSON.stringify({ text: '译文', model: 'seeded/model', at: new Date().toISOString(), truncated: true }),
      'utf8'
    );

    expect(readCachedTranslations([doc], 'zh', 'readme')[doc]?.truncated).toBe(true);
    // The description store must NOT answer for the same source text.
    expect(readCachedTranslations([doc], 'zh')[doc]).toBeUndefined();

    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/translations',
      payload: { lang: 'zh', texts: [doc], format: 'markdown' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { translations: Record<string, { text: string; truncated?: boolean }> };
    expect(body.translations[doc]?.text).toBe('译文');
    expect(body.translations[doc]?.truncated).toBe(true);
    await app.close();
  });

  it('exposes a manual prune that accepts an age budget', async () => {
    const file = seed('readme', 'manual prune page', 'zh', 10 * DAY);
    const app = fastify();
    registerHarnessRoutes(app);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/harness/translations/prune',
      payload: { maxAgeDays: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; removed: number };
    expect(body.status).toBe('ok');
    expect(body.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(file)).toBe(false);
    await app.close();
  });
});
