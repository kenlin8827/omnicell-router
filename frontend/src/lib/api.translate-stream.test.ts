import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Response whose body is a sequence of NDJSON lines, exactly what the stream route writes. */
function ndjsonResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('api.harnessTranslateStream', () => {
  it('reports every progress event and resolves with the final rendering', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ndjsonResponse([
          { type: 'progress', done: 0, total: 3 },
          { type: 'progress', done: 1, total: 3 },
          { type: 'progress', done: 2, total: 3 },
          { type: 'progress', done: 3, total: 3 },
          { type: 'result', text: '译文', cached: false, model: 'lite' },
        ])
      )
    );
    const seen: { done: number; total: number }[] = [];
    const result = await api.harnessTranslateStream({ text: 'source', lang: 'zh' }, (done, total) =>
      seen.push({ done, total })
    );
    expect(seen).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
    expect(result).toEqual({ text: '译文', cached: false, model: 'lite' });
  });

  it('rejects with the streamed error instead of resolving a partial result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ndjsonResponse([{ type: 'progress', done: 0, total: 3 }, { type: 'error', message: 'no key' }]))
    );
    await expect(api.harnessTranslateStream({ text: 'source', lang: 'zh' }, () => {})).rejects.toThrow('no key');
  });

  it('rejects when the stream ends without a result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([{ type: 'progress', done: 1, total: 3 }])));
    await expect(api.harnessTranslateStream({ text: 'source', lang: 'zh' }, () => {})).rejects.toThrow(
      'ended without a result'
    );
  });
});
