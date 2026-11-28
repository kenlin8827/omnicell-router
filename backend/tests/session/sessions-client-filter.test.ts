import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { createServer } from '../../src/server.js';
import { loadConfig } from '../../src/config/index.js';

/**
 * Client-family selector on GET /api/admin/sessions (`?client=` / `?q=`).
 *
 * The User-Agent is a forgeable software fingerprint (display-only, ADR-0002),
 * so the selector matches the DERIVED family id (`utils/client-families.ts`),
 * never a raw UA substring. Contract under test:
 *   • a session's row exposes `clientFamilies` (id + label, write order);
 *   • `?client=<family-id>` keeps only rows whose family set contains it;
 *   • the filter runs BEFORE pagination, so `total` stays truthful;
 *   • `?q=` matches a family id/label, but never a raw UA that the classifier
 *     did not map (a bare "Mozilla" search must not hit an unknown-UA row's
 *     full UA text — only the capped unknown label token);
 *   • an empty selector means every client.
 */

const authHeaders = (ua: string): Record<string, string> => {
  const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
  const base: Record<string, string> = { 'user-agent': ua };
  if (diskKeys.length > 0) base.authorization = `Bearer ${diskKeys[0].key}`;
  return base;
};

interface SessionsListBody {
  data: Array<{
    id: string;
    maxTier?: string;
    clientFamilies?: Array<{ id: string; label: string }>;
  }>;
  total: number;
}

const SUFFIX = Math.random().toString(36).slice(2, 8);
const PI_SESSION = `sess_client_pi_${SUFFIX}`;
const OPENCODE_SESSION = `sess_client_opencode_${SUFFIX}`;
const ANTHROPIC_SESSION = `sess_client_anthropic_${SUFFIX}`;
const PLAYGROUND_SESSION = `sess_client_playground_${SUFFIX}`;

describe('client-family filter on GET /api/admin/sessions (?client=)', () => {
  let app: FastifyInstance;

  before(async () => {
    const bundle = createServer(loadConfig(), true);
    app = bundle.app;
    await app.ready();

    const cases: [string, string][] = [
      [PI_SESSION, 'pi/1.2.3 (win32; node/v26.3.0; x64)'],
      [OPENCODE_SESSION, 'opencode/0.4.2'],
      // Anchored `/^pi/` must not swallow Anthropic.
      [ANTHROPIC_SESSION, 'Anthropic/1.0 (Python 3.12)'],
    ];
    for (const [sessionId, ua] of cases) {
      const res = await app.inject({
        headers: { ...authHeaders(ua), 'x-session-id': sessionId },
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'auto', messages: [{ role: 'user', content: `Hello from ${sessionId}` }] },
      });
      assert.strictEqual(res.statusCode, 200, 'call must route');
    }

    // A browser strips a script-set `User-Agent` on fetch, so the console
    // playground declares itself through `x-ocr-client`; it must classify as
    // `playground` even though the UA is a generic Chrome one.
    const pg = await app.inject({
      headers: {
        ...authHeaders('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0'),
        'x-ocr-client': 'OmniCellRouter-Playground/0.8.5',
        'x-session-id': PLAYGROUND_SESSION,
      },
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [{ role: 'user', content: 'Hello from playground' }] },
    });
    assert.strictEqual(pg.statusCode, 200, 'playground call must route');
  });

  after(async () => {
    await app.close();
  });

  const list = async (qs = ''): Promise<SessionsListBody> => {
    const res = await app.inject({
      headers: authHeaders('probe/1.0'),
      method: 'GET',
      url: `/api/admin/sessions${qs}`,
    });
    assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.body) as SessionsListBody;
  };

  it('rows expose the derived client families', async () => {
    const body = await list();
    const pi = body.data.find(s => s.id === PI_SESSION);
    assert.ok(pi, 'pi session listed');
    assert.deepEqual(pi!.clientFamilies?.map(f => f.id), ['pi']);

    const anthropic = body.data.find(s => s.id === ANTHROPIC_SESSION);
    assert.deepEqual(anthropic!.clientFamilies?.map(f => f.id), ['anthropic-sdk']);
  });

  it('x-ocr-client hint identifies the playground despite a browser UA', async () => {
    const body = await list();
    const pg = body.data.find(s => s.id === PLAYGROUND_SESSION);
    assert.ok(pg, 'playground session listed');
    assert.deepEqual(pg!.clientFamilies?.map(f => f.id), ['playground']);

    const filtered = await list('?client=playground');
    assert.ok(filtered.data.some(s => s.id === PLAYGROUND_SESSION));
    assert.ok(
      filtered.data.every(s => (s.clientFamilies ?? []).some(f => f.id === 'playground')),
      'every returned row carries the playground family'
    );
  });

  it('?client=<id> keeps only that family, before pagination', async () => {
    const full = await list();
    const piOnly = await list('?client=pi');
    assert.ok(piOnly.data.some(s => s.id === PI_SESSION));
    assert.ok(
      piOnly.data.every(s => (s.clientFamilies ?? []).some(f => f.id === 'pi')),
      'every returned row carries the pi family'
    );
    assert.ok(
      !piOnly.data.some(s => s.id === ANTHROPIC_SESSION),
      'the anthropic session is not a pi session'
    );

    // Filtered set is honest: total equals the surviving rows, and paginating
    // it never leaks a non-matching row back in.
    assert.strictEqual(piOnly.total, piOnly.data.length);
    assert.ok(piOnly.total <= full.total);
    const page = await list('?client=pi&limit=1&offset=0');
    assert.strictEqual(page.total, piOnly.total);
    assert.ok(page.data.every(s => (s.clientFamilies ?? []).some(f => f.id === 'pi')));
  });

  it('selector is case-insensitive and tolerates padding', async () => {
    const padded = await list('?client=%20PI%20');
    const plain = await list('?client=pi');
    assert.strictEqual(padded.total, plain.total);
  });

  it('an unknown family id matches nothing (never falls open)', async () => {
    const none = await list('?client=no-such-client-xyz');
    assert.strictEqual(none.total, 0);
    assert.deepEqual(none.data, []);
  });

  it('?q= matches a family id, so clients are searchable without the dropdown', async () => {
    const body = await list('?q=opencode');
    assert.ok(body.data.some(s => s.id === OPENCODE_SESSION));
    assert.ok(
      !body.data.some(s => s.id === PI_SESSION),
      'pi row carries no opencode family'
    );
  });

  it('?tier= keeps only rows at that exact ratchet ceiling', async () => {
    const full = await list();
    const sample = full.data.find(s => s.id === PI_SESSION);
    assert.ok(sample, 'sample row listed');
    const tier = sample!.maxTier;
    assert.ok(tier, 'a row always carries maxTier');

    const filtered = await list(`?tier=${tier}`);
    assert.ok(filtered.data.some(s => s.id === PI_SESSION));
    assert.ok(
      filtered.data.every(s => s.maxTier === tier),
      'every returned row sits on the selected tier'
    );
    assert.strictEqual(filtered.total, filtered.data.length);
  });

  it('unknown tier value matches nothing (never falls open)', async () => {
    assert.strictEqual((await list('?tier=no-such-tier')).total, 0);
  });
});
