import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import type { PipelineOrchestrator } from '../src/pipeline/orchestrator.js';

/**
 * Internal-session rows (ADR-0015 D6b): the gateway's own loopback callers
 * (console translation / chain probe) pin a fixed reserved-prefix session id
 * (`ocr-internal:*`) instead of minting a fresh cold_start session per call.
 *
 * Contract under test:
 *   • GET /api/admin/sessions derives `internal: true` from the id and hides
 *     those rows by default (hideInternal applies BEFORE pagination, so
 *     `total` stays truthful);
 *   • hideInternal=0 shows them;
 *   • the classification survives "the gateway restarted": a session that
 *     exists ONLY in the trace store (live session-manager state gone) is
 *     reconstructed with `internal: true` — the id IS the marker, no stored
 *     flag to lose.
 */

/** Admin-sessions list row — only the fields this contract reads. */
interface SessionRow {
  id: string;
  internal?: boolean;
}

interface SessionsListBody {
  data: SessionRow[];
  total: number;
}

const authHeaders = (): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
};

describe('internal sessions (ocr-internal: prefix)', () => {
  let app: FastifyInstance;
  let orchestrator: PipelineOrchestrator;

  before(async () => {
    const bundle = createServer(loadConfig(), true);
    app = bundle.app;
    orchestrator = bundle.orchestrator;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('hidden by default, exposed with hideInternal=0, flagged on the row', async () => {
    // A loopback-style turn on a reserved internal id + a regular client turn.
    const internal = await app.inject({
      headers: authHeaders(),
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'lite',
        messages: [{ role: 'user', content: 'Translate: keeps skills tidy.' }],
        router_options: { session_id: 'ocr-internal:translation' },
      },
    });
    assert.strictEqual(internal.statusCode, 200, 'internal-id turn must route');
    assert.strictEqual(internal.headers['x-ocr-session-id'], 'ocr-internal:translation');

    const regular = await app.inject({
      headers: { ...authHeaders(), 'x-session-id': 'sess_internal_filter_regular' },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'Hello from a real client' }] },
    });
    assert.strictEqual(regular.statusCode, 200);

    // Default: internal row gone, regular row present.
    const def = await app.inject({ headers: authHeaders(), method: 'GET', url: '/api/admin/sessions' });
    assert.strictEqual(def.statusCode, 200);
    const defBody = JSON.parse(def.body) as SessionsListBody;
    assert.ok(
      defBody.data.every(s => s.id !== 'ocr-internal:translation'),
      'default listing must hide internal rows'
    );
    assert.ok(
      defBody.data.some(s => s.id === 'sess_internal_filter_regular'),
      'regular sessions stay listed'
    );

    // Opt-in: internal row present and flagged.
    const inc = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions?hideInternal=0',
    });
    const incBody = JSON.parse(inc.body) as SessionsListBody;
    const row = incBody.data.find(s => s.id === 'ocr-internal:translation');
    assert.ok(row, 'hideInternal=0 must list the internal row');
    assert.strictEqual(row.internal, true, 'internal row must carry internal: true');
    const regularRow = incBody.data.find(s => s.id === 'sess_internal_filter_regular');
    assert.strictEqual(regularRow?.internal, false, 'regular row must NOT be flagged internal');
  });

  it('classification survives restart: trace-reconstructed rows keep internal: true', async () => {
    // Simulate the restart boundary: live session-manager state is gone, the
    // trace store survived (production: a real process restart replays the
    // persisted traces into a fresh tracker — here the live state is dropped
    // in-process, which reaches the same reconstruction path).
    orchestrator.getSessionManager()?.clear();

    const stillLive = orchestrator.getSessionManager()?.getAllSessions() ?? [];
    assert.ok(!stillLive.some(s => s.id === 'ocr-internal:translation'), 'live state cleared');

    const res = await app.inject({
      headers: authHeaders(),
      method: 'GET',
      url: '/api/admin/sessions?hideInternal=0&q=ocr-internal',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body) as SessionsListBody;
    const row = body.data.find(s => s.id === 'ocr-internal:translation');
    assert.ok(row, 'trace-only session must be reconstructed after restart');
    assert.strictEqual(row.internal, true, 'reconstructed row must still be flagged internal');

    // And the default filter must hide the reconstructed row too.
    const def = await app.inject({ headers: authHeaders(), method: 'GET', url: '/api/admin/sessions' });
    assert.ok(
      (JSON.parse(def.body) as SessionsListBody).data.every(s => s.id !== 'ocr-internal:translation'),
      'default listing must hide reconstructed internal rows'
    );
  });
});
