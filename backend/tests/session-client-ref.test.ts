import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { SessionManager } from '../src/session/session-manager.js';
import type { ChatCompletionRequest } from '../src/types/openai.js';
import { RouterConfig } from '../src/config/types.js';
import { createServer } from '../src/server.js';
import type { SessionRow } from '../src/session/session-row.js';
import { loadConfig } from '../src/config/index.js';

/**
 * Client conversation refs (ADR-0002 §1, "client conversation refs") — the
 * gateway id stays the identity, the client-minted conversation id is bound to
 * it as an alias and rendered beside it.
 *
 * Resolution contract exercised here: aliases sit AFTER the byte-exact anchors
 * and the conversation key (content evidence wins a conflict, and the alias is
 * rebound to whatever session won), and BEFORE the fresh mint (a turn-1-shaped
 * resend under the same claim re-attaches instead of splitting).
 */

const clientRef = (id: string, kind = 'cursor') => ({ kind, id });

const withRef = (messages: ChatCompletionRequest['messages'], ref: { kind: string; id: string }) =>
  ({ model: 'auto', messages, router_options: { client_ref: ref } }) as ChatCompletionRequest;

describe('Client conversation refs — resolution', () => {
  it('re-attaches by claim when the opening and the served bytes are both gone', () => {
    const manager = new SessionManager({ enabled: true, strategy: 'monotonic' });
    const opened = withRef([{ role: 'user', content: '你是谁' }], clientRef('conv_A'));
    const first = manager.resolveSessionId(opened);
    assert.equal(first.lookupType, 'cold_start');
    assert.match(first.sessionId, /^sess_/, 'the gateway id stays the identity');

    manager.registerCompletedTurn(first.sessionId, opened.messages, 'served reply');
    // Client-side compaction: the opening question is gone AND the assistant
    // bytes were rewritten — no anchor, no conversation key, only the claim.
    const compacted = withRef(
      [
        { role: 'assistant', content: 'a rewritten preamble the gateway never served' },
        { role: 'user', content: '能做什么啊' },
      ],
      clientRef('conv_A')
    );
    const second = manager.resolveSessionId(compacted);
    assert.equal(second.lookupType, 'client_ref');
    assert.equal(second.sessionId, first.sessionId, 'same gateway session for the client conversation');
  });

  it('lets content evidence win a conflict, and rebinds the alias to the winner', () => {
    const manager = new SessionManager({ enabled: true, strategy: 'monotonic' });
    const claimed = manager.resolveSessionId(withRef([{ role: 'user', content: 'open claimed' }], clientRef('conv_X')));

    // A different conversation, established without any claim.
    const opening = [{ role: 'user' as const, content: 'open by content' }];
    const byContent = manager.resolveSessionId({ model: 'auto', messages: opening });
    manager.registerCompletedTurn(byContent.sessionId, opening, 'served reply');
    assert.notEqual(byContent.sessionId, claimed.sessionId);

    // Same claim, but the history anchors to the OTHER session: content wins.
    const continued = withRef(
      [
        ...opening,
        { role: 'assistant' as const, content: 'served reply' },
        { role: 'user' as const, content: 'more' },
      ],
      clientRef('conv_X')
    );
    const resolved = manager.resolveSessionId(continued);
    assert.equal(resolved.sessionId, byContent.sessionId, 'anchors outrank the client claim');
    assert.notEqual(resolved.lookupType, 'client_ref');

    // The alias followed reality: a claim-only turn now re-attaches there.
    const compacted = withRef(
      [
        { role: 'assistant', content: 'rewritten' },
        { role: 'user', content: 'after compaction' },
      ],
      clientRef('conv_X')
    );
    const rebound = manager.resolveSessionId(compacted);
    assert.equal(rebound.lookupType, 'client_ref');
    assert.equal(rebound.sessionId, byContent.sessionId);
  });

  it('scopes aliases by API-key identity (two tenants may mint the same string)', () => {
    const manager = new SessionManager({ enabled: true, strategy: 'monotonic' });
    const a = manager.resolveSessionId(withRef([{ role: 'user', content: 'tenant A' }], clientRef('conv_same')), {
      keyId: 'key-a',
    });
    const b = manager.resolveSessionId(withRef([{ role: 'user', content: 'tenant B' }], clientRef('conv_same')), {
      keyId: 'key-b',
    });
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.lookupType, 'cold_start');
    assert.equal(b.lookupType, 'cold_start');
  });

  it('keeps explicit ids above everything and binds the alias under them', () => {
    const manager = new SessionManager({ enabled: true, strategy: 'monotonic' });
    const explicit = manager.resolveSessionId(withRef([{ role: 'user', content: 'hi' }], clientRef('conv_E')), {
      headers: { 'x-session-id': 'explicit-777' },
    });
    assert.equal(explicit.lookupType, 'explicit_header');
    assert.equal(explicit.sessionId, 'explicit-777');

    const compacted = manager.resolveSessionId(
      withRef([{ role: 'assistant', content: 'rewritten' }, { role: 'user', content: 'next' }], clientRef('conv_E'))
    );
    assert.equal(compacted.lookupType, 'client_ref');
    assert.equal(compacted.sessionId, 'explicit-777');
  });

  it('persists aliases across a restart (snapshot v2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-client-ref-'));
    const snapshot = path.join(dir, 'sessions.json');
    try {
      const before = new SessionManager({ enabled: true, strategy: 'monotonic' }, snapshot);
      const first = before.resolveSessionId(withRef([{ role: 'user', content: 'before restart' }], clientRef('conv_P')));
      before.flushPersist();
      assert.ok(fs.existsSync(snapshot), 'binding must mark the snapshot dirty');

      const restored = new SessionManager({ enabled: true, strategy: 'monotonic' }, snapshot);
      const after = restored.resolveSessionId(
        withRef(
          [{ role: 'assistant', content: 'rewritten' }, { role: 'user', content: 'after restart' }],
          clientRef('conv_P')
        )
      );
      assert.equal(after.lookupType, 'client_ref');
      assert.equal(after.sessionId, first.sessionId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Client conversation refs — console surface (both ids)', () => {
  let app: FastifyInstance;

  // Auth mirror of server.ts: disk keys win over the test config, so reuse the
  // first enabled key when this machine has a populated config.yaml.
  const authHeaders = (): Record<string, string> => {
    const diskKeys = (loadConfig().apiKeys || []).filter(k => k.enabled !== false && k.key);
    return diskKeys.length > 0 ? { authorization: `Bearer ${diskKeys[0].key}` } : {};
  };

  const baseConfig: RouterConfig = {
    port: 3000,
    host: '127.0.0.1',
    fallback: { enabled: false, maxRetries: 1, escalateTier: 'plus', injectErrorContext: false },
    circuitBreaker: { enabled: true, failureThreshold: 3 },
    retry: {
      enabled: true,
      inplace: { enabled: true, maxAttempts: 1, backoffMs: 10, jitterMs: 5 },
      failover: { enabled: true, maxAttempts: 3, tierCrossPolicy: 'allow_escalate' },
    },
    models: [
      {
        id: 'lite-1',
        provider: 'mock',
        upstreamModel: 'lite-1',
        tier: 'lite',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 0.15, cacheRead: 0.015, output: 0.6 },
      },
      {
        id: 'plus-1',
        provider: 'mock',
        upstreamModel: 'plus-1',
        tier: 'plus',
        priority: 1,
        isDefaultInTier: true,
        pricing: { input: 3.0, cacheRead: 0.3, output: 15.0 },
      },
    ],
  };

  before(async () => {
    app = createServer(baseConfig, true).app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  const rows = async (): Promise<SessionRow[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/sessions', headers: authHeaders() });
    assert.equal(res.statusCode, 200);
    // Admin route contract: `{ data: SessionRow[] }` (asserted structurally below).
    return (JSON.parse(res.body) as { data: SessionRow[] }).data;
  };

  const chat = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(),
      payload: { model: 'auto', ...body },
    });
    assert.equal(res.statusCode, 200);
    return res;
  };

  it('shows the gateway id and the client id on one row, and re-attaches both turns', async () => {
    const ref = clientRef('conv_e2e_1');
    await chat({
      router_options: { client_ref: ref },
      messages: [{ role: 'user', content: '你是谁' }],
    });

    const first = (await rows()).filter(s => s.clientRefs?.some(r => r.id === ref.id));
    assert.equal(first.length, 1, 'one gateway session carries the client ref');
    assert.match(first[0].id, /^sess_/);
    assert.deepEqual(first[0].clientRefs, [ref]);

    // Compaction turn: the opening and the served assistant bytes are gone, so
    // only the alias can hold the two turns together.
    await chat({
      router_options: { client_ref: ref },
      messages: [
        { role: 'assistant', content: 'rewritten preamble' },
        { role: 'user', content: '继续' },
      ],
    });

    const after = (await rows()).filter(s => s.clientRefs?.some(r => r.id === ref.id));
    assert.equal(after.length, 1, 'the client conversation stays one gateway session');
    assert.equal(after[0].id, first[0].id);
    assert.equal(after[0].traceCount, 2);
  });

  it('completes normally and refuses a reserved-prefix claim', async () => {
    const ref = clientRef('conv_e2e_2');
    const res = await chat({
      router_options: { client_ref: ref },
      messages: [{ role: 'user', content: 'leak check' }],
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.choices?.length, 'normal completion returned');

    // A ref that claims the reserved prefix is not bound (no console alias).
    await chat({
      router_options: { client_ref: { kind: 'cursor', id: 'ocr-internal:probe' } },
      messages: [{ role: 'user', content: 'reserved prefix' }],
    });
    const leaked = (await rows()).filter(s => s.clientRefs?.some(r => r.id.startsWith('ocr-internal:')));
    assert.equal(leaked.length, 0, 'reserved-prefix ids must not be persisted as aliases');
  });
});
