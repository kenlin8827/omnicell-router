import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeConnector } from '../src/opencode/connector.js';

/**
 * Hermetic OpenCodeConnector suite — NO operator state, NO live daemon.
 *
 * The historical shape of this file (auto-discover the REAL
 * `~/.config/opencode/service.json` and fetch REAL providers from
 * 127.0.0.1:49374) violated the isolated-runner contract: discovery falls
 * back to `os.homedir()` paths that the XDG sandbox cannot redirect, so on a
 * machine without a running daemon the suite was permanently red (and on one
 * WITH the operator's files, it consumed real state). Per the runner
 * tripwire ("a test consuming operator state is a bug; fix it with
 * injection/fixtures") the default tier now runs against a local Bun.serve
 * mock via the connector's `(customUrl, customPassword)` injection seam.
 *
 * The live tier (operator's real service, real ≥5-provider roster) is kept
 * behind an explicit `OCR_LIVE=1` opt-in; skipped runs announce themselves
 * on stderr so the escape hatch stays visible.
 */

const MOCK_PASSWORD = 'mock-service-password';
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`opencode:${MOCK_PASSWORD}`).toString('base64');

const FIXTURE_PROVIDERS = [
  { id: 'alibaba', name: 'Alibaba (DashScope)', models: 12 },
  { id: 'deepseek', name: 'DeepSeek', models: 4 },
  { id: 'kimi', name: 'Kimi (Moonshot)', models: 6 },
  { id: 'anthropic', name: 'Anthropic', models: 8 },
  { id: 'openai', name: 'OpenAI', models: 15 },
];

describe('OpenCodeConnector — hermetic tier (mock daemon)', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let mockUrl = '';

  before(() => {
    server = Bun.serve({
      port: 0, // OS-assigned: never collides with the operator's 49374
      fetch(req) {
        // Enforce the Basic header: success below PROVES the connector sent it.
        if ((req.headers.get('authorization') ?? '') !== EXPECTED_AUTH) {
          return new Response('unauthorized', { status: 401 });
        }
        const { pathname } = new URL(req.url);
        if (pathname === '/api/provider') return Response.json({ data: FIXTURE_PROVIDERS });
        return new Response('not found', { status: 404 });
      },
    });
    mockUrl = `http://127.0.0.1:${server.port}`;
  });

  after(() => {
    server?.stop(true);
  });

  describe('service-config resolution', () => {
    it('custom constructor args take precedence and build the Basic auth header', () => {
      const connector = new OpenCodeConnector(mockUrl, MOCK_PASSWORD);
      assert.strictEqual(connector.isAvailable(), true);
      const cfg = connector.getServiceConfig();
      assert.strictEqual(cfg?.baseUrl, mockUrl);
      assert.strictEqual(cfg?.authHeader, EXPECTED_AUTH);
    });

    it('env vars (OPENCODE_SERVER_URL/PASSWORD) are honored when no args are given', () => {
      process.env.OPENCODE_SERVER_URL = mockUrl;
      process.env.OPENCODE_SERVER_PASSWORD = MOCK_PASSWORD;
      try {
        const connector = new OpenCodeConnector();
        assert.strictEqual(connector.isAvailable(), true);
        assert.strictEqual(connector.getServiceConfig()?.baseUrl, mockUrl);
      } finally {
        // The isolated runner deliberately unsets these; never leak them back.
        delete process.env.OPENCODE_SERVER_URL;
        delete process.env.OPENCODE_SERVER_PASSWORD;
      }
    });
  });

  describe('getProviders', () => {
    it('fetches the provider roster with the Basic auth header', async () => {
      const connector = new OpenCodeConnector(mockUrl, MOCK_PASSWORD);
      const providers = await connector.getProviders();
      assert.ok(Array.isArray(providers));
      assert.ok(providers.length >= 5);
      const names = providers.map((p) => p.name);
      assert.ok(names.some((n) => n.includes('Alibaba')));
      assert.ok(names.some((n) => n.includes('DeepSeek')));
      assert.ok(names.some((n) => n.includes('Kimi')));
    });

    it('rejects with a status-bearing error when the daemon answers non-2xx', async () => {
      // Wrong password → the mock's 401 guard trips → connector surfaces [401].
      const connector = new OpenCodeConnector(mockUrl, 'wrong-password');
      await assert.rejects(connector.getProviders(), /failed \[401\]/);
    });
  });
});

// ─── Live tier — explicit opt-in, NEVER part of the default suite ───────────
// NOTE: registration is conditional (not `describe(..., { skip })`) — Bun's
// node:test compat layer ignores the skip option and would run the tier
// against the (absent) real daemon anyway.
const LIVE = process.env.OCR_LIVE === '1';
if (!LIVE) {
  console.error(
    '[opencode.test] Live tier skipped (set OCR_LIVE=1 to exercise the REAL local ' +
      'OpenCode daemon discovery + /api/provider fetch). Default suite stays hermetic.'
  );
} else {
  describe('OpenCodeConnector — LIVE tier (operator daemon, OCR_LIVE=1)', () => {
    it('auto-discovers the local OpenCode background service credentials', () => {
      const connector = new OpenCodeConnector();
      assert.strictEqual(connector.isAvailable(), true, 'Expected OpenCode service config to be found');
      const cfg = connector.getServiceConfig();
      assert.ok(cfg?.baseUrl.includes('49374'));
      assert.ok(cfg?.authHeader.startsWith('Basic '));
    });

    it('fetches active providers from the real OpenCode v2 REST API', async () => {
      const providers = await new OpenCodeConnector().getProviders();
      assert.ok(Array.isArray(providers));
      assert.ok(providers.length >= 5);
    });
  });
}
