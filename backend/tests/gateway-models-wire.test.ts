import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/index.js';
import { createServer } from '../src/server.js';
import type { RouterConfig } from '../src/config/types.js';

/**
 * Console picker metadata: `/api/admin/gateway-models` must expose each row's
 * RESOLVED upstream wire, because the console is forbidden from re-deriving it
 * from a provider npm string (`wireFor()` in providers/wire.ts is the single
 * owner of that mapping).
 *
 * Two contracts pinned here:
 *   - a resolved wire rides the row (`wire: 'systemone'` marks a DECISION-wire
 *     model that no chat surface can address — ADR-0008 §7);
 *   - an UNRESOLVED wire adds NO key — a guessed 'openai' default would let the
 *     console believe a hand-registered model is chat-addressable.
 */
describe('GET /api/admin/gateway-models carries the resolved wire', () => {
  const base = loadConfig();
  const pricing = { input: 0, output: 0, cacheRead: 0 };
  const config: RouterConfig = {
    ...base,
    host: '127.0.0.1', // loopback: webAuth forced gate stays off
    webAuth: { enabled: false },
    apiKeys: [],
    models: [
      { id: 'w/decision', provider: 'w-ts', upstreamModel: 'dec', tier: 'plus', pricing, wire: 'systemone' },
      { id: 'w/anthropic', provider: 'w-ant', upstreamModel: 'claude', tier: 'lite', pricing, wire: 'anthropic' },
      { id: 'w/plain', provider: 'w-openai', upstreamModel: 'gpt', tier: 'pro', pricing, wire: 'openai' },
      // No wire: the shape a hand-registered model without catalog npm has.
      { id: 'w/nowire', provider: 'w-openai', upstreamModel: 'x', tier: 'ultra', pricing },
    ],
  };
  const { app } = createServer(config, true);

  it('reports wire per row and omits the key when none was resolved', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/gateway-models' });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as { models: Record<string, unknown>[] };
    const row = (id: string) => body.models.find((m) => m.id === id);

    assert.strictEqual(row('w/decision')?.wire, 'systemone', 'decision wire is exposed, not inferred');
    assert.strictEqual(row('w/anthropic')?.wire, 'anthropic');
    assert.strictEqual(row('w/plain')?.wire, 'openai');
    assert.ok(!('wire' in (row('w/nowire') ?? {})), 'unresolved wire must not fabricate a default');
    assert.ok(!('wire' in (row('auto') ?? {})), 'virtual auto* rows have no upstream wire');
  });
});
