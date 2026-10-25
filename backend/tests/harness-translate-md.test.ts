import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { harnessEnvDir } from '../src/harness/manifest.js';
import { getCachedTranslation, splitMarkdownRuns, chunkProse, translateMarkdown } from '../src/harness/translation.js';

/**
 * Long-form translation (a README) is split into prose and fenced-code runs. Everything here is
 * about staying LOSSLESS: a document that comes back missing a code block or a trailing paragraph is
 * worse than one that is still in the source language. The cache cases write the DERIVED cache file
 * directly (the sandbox OCR_HOME is disposable) so "a second read spends nothing" is proven rather
 * than argued.
 */

/** Seed one entry in the derived translation store, exactly as a previous run would have left it. */
function seedEntry(kind: 'descriptions' | 'readme', source: string, lang: string, text: string): void {
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const file = path.join(harnessEnvDir(), 'i18n', kind, `${hash}.${lang}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ text, model: 'seeded/model', at: new Date().toISOString() }), 'utf8');
}

describe('splitMarkdownRuns', () => {
  it('reproduces the document byte for byte when the runs are re-joined', () => {
    const doc = [
      '# Title',
      '',
      'Intro paragraph.',
      '',
      '```bash',
      'npm i thing',
      '```',
      '',
      'Trailing prose.',
    ].join('\n');
    const runs = splitMarkdownRuns(doc);
    expect(runs.map((r) => r.text).join('\n')).toBe(doc);
  });

  it('marks fenced blocks as code and leaves prose unmarked', () => {
    const runs = splitMarkdownRuns('prose\n```js\nconst a = 1;\n```\nafter');
    expect(runs.map((r) => r.code)).toEqual([false, true, false]);
    expect(runs[1]!.text).toContain('const a = 1;');
  });

  it('treats an unclosed fence as code to the end of the document', () => {
    const runs = splitMarkdownRuns('intro\n~~~\nstill code\nmore code');
    expect(runs[0]!.code).toBe(false);
    expect(runs[1]!.code).toBe(true);
    expect(runs[1]!.text).toBe('~~~\nstill code\nmore code');
  });

  it('accepts a fence indented up to three spaces (a list item code block)', () => {
    const runs = splitMarkdownRuns('- item\n\n   ```\n   x\n   ```\n');
    expect(runs.some((r) => r.code)).toBe(true);
  });

  it('answers one prose run for a document with no code at all', () => {
    const runs = splitMarkdownRuns('just words');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.code).toBe(false);
  });
});

describe('chunkProse', () => {
  it('keeps a short text as one chunk', () => {
    expect(chunkProse('short', 100)).toEqual(['short']);
  });

  it('cuts on paragraph boundaries and never exceeds the limit per paragraph case', () => {
    const text = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('\n\n');
    const chunks = chunkProse(text, 130);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(130);
    expect(chunks.join('\n\n')).toBe(text);
  });

  it('hard-slices a single oversized paragraph', () => {
    const chunks = chunkProse('x'.repeat(250), 100);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });
});

describe('translateMarkdown', () => {
  it('returns a code-only document unchanged without calling the gateway', async () => {
    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('the gateway must not be called for a code-only document');
    }) as unknown as typeof fetch;
    try {
      const doc = '```bash\nnpm i thing\n```';
      const result = await translateMarkdown(doc, 'zh');
      expect('code' in result).toBe(false);
      if ('code' in result) return;
      expect(result.text).toBe(doc);
      expect(result.cached).toBe(true);
      expect(result.truncated).toBe(false);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('refuses an unsupported language before any work', async () => {
    const result = await translateMarkdown('hello', 'xx');
    expect('code' in result && result.code).toBe('unsupported_lang');
  });

  it('answers a previously cached README from disk without calling the gateway', async () => {
    const doc = '# Title\n\nSome prose that was translated yesterday.';
    seedEntry('readme', doc, 'zh', '# 标题\n\n昨天翻译过的正文。');

    const original = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error('a cache hit must not reach the gateway');
    }) as unknown as typeof fetch;
    try {
      const result = await translateMarkdown(doc, 'zh');
      if ('code' in result) throw new Error(`expected a cache hit, got ${result.code}`);
      expect(result.cached).toBe(true);
      expect(result.text).toBe('# 标题\n\n昨天翻译过的正文。');
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('keeps the markdown namespace apart from the description namespace', async () => {
    const doc = 'same words';
    seedEntry('readme', doc, 'zh', '译文');
    seedEntry('descriptions', doc, 'zh', '描述译文');
    expect(getCachedTranslation(doc, 'zh')?.text).toBe('描述译文');
    const result = await translateMarkdown(doc, 'zh');
    if ('code' in result) throw new Error('expected a cache hit');
    expect(result.text).toBe('译文');
  });
});
