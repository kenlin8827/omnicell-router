import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config/index.js';
import type { PipelineOrchestrator } from '../../src/pipeline/orchestrator.js';

/**
 * Single-request ("one-shot") rows on GET /api/admin/sessions.
 *
 * A client helper call — title generation, per-step summary, classification:
 * a fixed template prompt, no tools, no session claim — matches no layer of the
 * ADR-0002 §1 ladder, so it cold-starts at layer 8 and gets its own session.
 * That is CORRECT identity: welding it into the conversation it serves would be
 * the false merge the whole ladder is built to avoid. It is only DISPLAY noise
 * (one agent turn emits dozens), so the console opts out of showing it —
 * `hideOneShot=1` drops rows whose own request count is <= 1.
 *
 * Contract under test:
 *   • the API default REPORTS every session (no silent hiding);
 *   • `hideOneShot=1` drops the single-request rows and keeps multi-exchange ones;
 *   • the drop happens BEFORE pagination, so `total` stays truthful (a page never
 *     comes back with fewer rows than `total` promised);
 *   • a helper call never merges into a live conversation (identity is untouched).
 */

const authHeaders = (): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
};

interface SessionsListBody {
  data: Array<{ id: string; traceCount?: number; turnCount?: number }>;
  total: number;
}

/** One client helper call: the shape every title/summary/classifier request has. */
const helperCall = (prompt: string) => ({
  model: 'auto',
  messages: [
    { role: 'system', content: 'You are a terse summarizer.' },
    { role: 'user', content: prompt },
  ],
});

describe('one-shot session rows (hideOneShot)', () => {
  let app: FastifyInstance;
  let orchestrator: PipelineOrchestrator;
  const convId = 'sess_oneshot_filter_conversation';

  before(async () => {
    const bundle = createServer(loadConfig(), true);
    app = bundle.app;
    orchestrator = bundle.orchestrator;
    await app.ready();

    // Two helper calls, each a fresh template prompt => two cold-start sessions.
    for (const prompt of [
      'Summarize the following `observation, action (tool), result` sequence in one short sentence.',
      'Provide a short, helpful task name of 5-10 words.',
    ]) {
      const res = await app.inject({
        headers: authHeaders(),
        method: 'POST',
        url: '/v1/chat/completions',
        payload: helperCall(prompt),
      });
      assert.strictEqual(res.statusCode, 200, 'helper call must route');
      const minted = res.headers['x-ocr-session-id'] as string;
      assert.ok(minted && minted !== convId, 'helper call mints its own session');
    }

    // One real conversation: two exchanges on a client-named session.
    for (const content of ['Hello from a real client', 'And a follow-up turn']) {
      const res = await app.inject({
        headers: { ...authHeaders(), 'x-session-id': convId },
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'auto', messages: [{ role: 'user', content: `This turn: ${content}` }] },
      });
      assert.strictEqual(res.statusCode, 200);
    }
  });

  after(async () => {
    await app.close();
  });

  const list = async (qs = ''): Promise<SessionsListBody> => {
    const res = await app.inject({ headers: authHeaders(), method: 'GET', url: `/api/admin/sessions${qs}` });
    assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.body) as SessionsListBody;
  };

  it('reports every session by default — the filter is opt-in', async () => {
    const body = await list();
    const oneShots = body.data.filter(s => (s.traceCount ?? 0) <= 1);
    assert.ok(oneShots.length >= 2, 'helper calls are listed without the filter');
    assert.strictEqual(body.total, body.data.length, 'unfiltered total counts every row');
    const conv = body.data.find(s => s.id === convId);
    assert.ok(conv, 'the real conversation is listed');
    assert.ok((conv!.traceCount ?? 0) > 1, 'the conversation carries both exchanges');
  });

  it('hideOneShot=1 drops single-request rows only, and before pagination', async () => {
    const full = await list();
    const filtered = await list('?hideOneShot=1');

    assert.ok(
      filtered.data.every(s => (s.traceCount ?? 0) > 1),
      'no single-request row survives the filter'
    );
    assert.ok(
      filtered.data.some(s => s.id === convId),
      'a multi-exchange conversation stays listed'
    );

    // Filtered BEFORE pagination: `total` counts surviving rows only.
    const dropped = full.data.filter(s => (s.traceCount ?? 0) <= 1).length;
    assert.strictEqual(filtered.total, full.total - dropped, 'total excludes the hidden rows');
    assert.strictEqual(filtered.data.length, filtered.total, 'one page holds exactly the advertised rows');

    // Pagination on the filtered set is honest too: the first page is a slice
    // of the SAME filtered count, never a slice of the unfiltered list.
    const page = await list('?hideOneShot=1&limit=1&offset=0');
    assert.strictEqual(page.total, filtered.total, 'limit/offset never loosens the filter');
    assert.strictEqual(page.data.length, Math.min(1, filtered.total));
    assert.ok(page.data.every(s => (s.traceCount ?? 0) > 1));
  });

  it('hideOneShot=0 spells the default explicitly', async () => {
    const explicit = await list('?hideOneShot=0');
    const bare = await list();
    assert.strictEqual(explicit.total, bare.total, 'hideOneShot=0 equals the unfiltered listing');
  });

  it('the helper calls kept their own identity — nothing was merged', async () => {
    const sessions = orchestrator.getSessionManager()?.getAllSessions() ?? [];
    const conv = sessions.find(s => s.id === convId);
    assert.ok(conv, 'conversation session exists');
    // The conversation kept its own id; the helper calls minted separate ones.
    const body = await list();
    const oneShots = body.data.filter(s => (s.traceCount ?? 0) <= 1);
    assert.ok(
      oneShots.every(s => s.id !== convId),
      'no single-request row was welded onto the conversation'
    );
  });
});
