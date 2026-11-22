import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { validatePluginManifest, normalizePluginParts } from '../../src/plugins/manifest.js';
import type { ClientAdapterHost, ClientGatewayHost, ClientGatewayPlugin, GatewayChatSink } from '../../src/plugins/types.js';

/**
 * opencode-gateway — OpenCode proxy mode as one package with two parts
 * (ADR-0017/0026/0027/0028).
 *
 * What is pinned here is the CONTRACT the design rests on, not the vendored
 * wires: which requests the gateway accepts, that "installed but not taking
 * over" really relays instead of dispatching, that an OpenCode-native model ref
 * (which the OCR catalog does not carry) is rewritten rather than 404'd, and
 * that ONE install yields BOTH halves — the Client Hub hook and the claims.
 */

const PLUGIN_DIR = path.resolve(import.meta.dirname, '../../../plugins/opencode-gateway');

// The plugin sources live in a gitignored dev tree (a separate repository), so a
// fresh checkout has no `plugins/opencode-gateway`. A static import cannot be
// conditional — the file would fail at module load — so the package is loaded
// only when its directory exists. Bun's `node:test` compat layer ignores a
// `skip` option, so every block below registers only through `d`; `src!` is
// therefore never evaluated without the package.
const src = fs.existsSync(PLUGIN_DIR) ? await import('../../../plugins/opencode-gateway/index.js') : null;
/** Register a plugin-dependent block only when the package is present. */
const d = src ? describe : null;

/** The gateway half of the package under test, from the SAME call the host
 *  makes — a package that returned only one half would fail here, which is the
 *  contract ADR-0028 exists to enforce. */
function createGateway(host: ClientAdapterHost & ClientGatewayHost): ClientGatewayPlugin {
  const { createPlugin } = src!;
  const gateway = createPlugin(host).gateway;
  assert.ok(gateway, 'the package must return its client-gateway part');
  return gateway;
}

interface ChatCall {
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

interface FakeHostOptions {
  config?: Record<string, unknown>;
  virtualModels?: string[];
  models?: string[];
  /** Non-stream terminal instead of chunks. */
  json?: { status: number; payload: unknown };
  /** Throw from chat (pipeline failure before any terminal send). */
  throws?: Error;
}

function fakeHost(opts: FakeHostOptions = {}): {
  host: ClientAdapterHost & ClientGatewayHost;
  calls: ChatCall[];
  relays: Record<string, unknown>[];
} {
  const calls: ChatCall[] = [];
  const relays: Record<string, unknown>[] = [];
  const host = {
    log: () => {},
    ocrHome: () => '/tmp',
    pluginDir: () => PLUGIN_DIR,
    // The ingress half reads these only from getStatus()/setup(); the gateway
    // tests never call those, but the combined host must still be well-formed.
    forwardProxy: () => undefined,
    caCertPath: () => '/tmp/ca.pem',
    config: () => opts.config ?? {},
    catalog: () => ({
      virtualModels: opts.virtualModels ?? ['auto', 'lite', 'plus', 'pro', 'ultra'],
      models: (opts.models ?? []).map((id) => ({ id })),
    }),
    chat: async (body: Record<string, unknown>, sink: GatewayChatSink, signal?: AbortSignal) => {
      calls.push({ body, signal });
      if (opts.throws) throw opts.throws;
      if (opts.json) {
        sink.onJson(opts.json.status, opts.json.payload);
        return;
      }
      sink.onChunk('data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n');
      sink.onChunk('data: [DONE]\n\n');
      sink.onEnd();
    },
    relayUpstream: async (_req: unknown, _res: unknown, o: Record<string, unknown>) => {
      relays.push(o);
      return { wire: 'h1' as const };
    },
  } as unknown as ClientAdapterHost & ClientGatewayHost;
  return { host, calls, relays };
}

class FakeRes extends EventEmitter {
  headersSent = false;
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  finished = false;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = { ...(headers || {}) };
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk?: string): this {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.finished = true;
    return this;
  }

  body(): string {
    return this.chunks.join('');
  }

  json(): unknown {
    return JSON.parse(this.body());
  }
}

function fakeReq(
  body: unknown,
  init: { method?: string; url?: string; host?: string; authority?: string } = {}
): http.IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: http.IncomingHttpHeaders = { host: init.host ?? 'api.openai.com' };
  if (init.authority) headers[':authority'] = init.authority;
  if (init.authority) headers[':path'] = init.url ?? '/v1/chat/completions';
  const stream = Readable.from([Buffer.from(raw, 'utf8')]);
  return Object.assign(stream, {
    method: init.method ?? 'POST',
    url: init.url ?? '/v1/chat/completions',
    headers,
  }) as unknown as http.IncomingMessage;
}

const asRes = (res: FakeRes): http.ServerResponse => res as unknown as http.ServerResponse;

d?.('opencode-gateway manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8')) as {
    id: string;
    parts?: { type: string; hosts?: string[] }[];
  };

  it('is ONE package occupying both proxy-mode axes', () => {
    assert.doesNotThrow(() => validatePluginManifest(manifest, 'invalid plugin.json'));
    assert.deepEqual(
      normalizePluginParts(manifest as never).map((p) => p.type),
      ['client-adapter', 'client-gateway'],
      'the ingress and the traffic owner must ship together — either alone is dead weight'
    );
  });

  it('claims an explicit host list, never the wildcard', () => {
    const gateway = manifest.parts?.find((p) => p.type === 'client-gateway');
    assert.ok(gateway?.hosts && gateway.hosts.length > 0);
    // A wildcard claim would shadow the built-in universal row for every other
    // client on the machine — OpenCode has no exclusive host to justify it.
    assert.ok(!gateway.hosts.includes('*'));
  });
});

d?.('opencode-gateway ingress part', () => {
  const { createPlugin } = src!;
  it('is the Client Hub row for proxy mode, produced by the same createPlugin call', () => {
    const { host } = fakeHost();
    const adapter = createPlugin(host).clientAdapter;
    assert.ok(adapter, 'the package must return its client-adapter part');
    // The adapter name IS the Client Hub id: one package, one row, and the row
    // is where the operator enables the ingress.
    assert.equal(adapter.name, 'opencode-gateway');
    assert.equal(adapter.hookKind, 'service-env');
  });
});

d?.('opencode-gateway match()', () => {
  it('accepts only POST on a model path', () => {
    const { host } = fakeHost();
    const plugin = createGateway(host);
    const headers = { host: 'api.openai.com' };

    assert.equal(plugin.match({ method: 'POST', url: '/v1/chat/completions', headers }), true);
    assert.equal(plugin.match({ method: 'POST', url: '/chat/completions', headers }), true);
    assert.equal(plugin.match({ method: 'GET', url: '/v1/chat/completions', headers }), false);
    assert.equal(plugin.match({ method: 'POST', url: '/v1/models', headers }), false);
    assert.equal(plugin.match({ method: 'POST', url: '/v1/embeddings', headers }), false);
  });

  it('leaves the Anthropic/Responses wires to the built-in row while intercepting', () => {
    const { host } = fakeHost();
    const plugin = createGateway(host);
    const headers = { host: 'api.anthropic.com' };

    // Not this package's wire: restating the conversion would be a second
    // implementation, so the accept step declines and the built-in row answers.
    assert.equal(plugin.match({ method: 'POST', url: '/v1/messages', headers }), false);
    assert.equal(plugin.match({ method: 'POST', url: '/v1/responses', headers }), false);
  });

  it('claims every model path when interception is off (so it can relay)', () => {
    const { host } = fakeHost({ config: { intercept: false } });
    const plugin = createGateway(host);
    const headers = { host: 'api.anthropic.com' };

    assert.equal(plugin.match({ method: 'POST', url: '/v1/messages', headers }), true);
    assert.equal(plugin.match({ method: 'POST', url: '/v1/chat/completions', headers }), true);
    assert.equal(plugin.match({ method: 'POST', url: '/v1/models', headers }), false);
  });
});

d?.('opencode-gateway handle()', () => {
  it('relays byte-verbatim when interception is off, without reading the body', async () => {
    const { host, calls, relays } = fakeHost({ config: { intercept: false } });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'claude-sonnet-4-5', messages: [] }, {
      url: '/v1/messages',
      host: 'api.anthropic.com',
    });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(calls.length, 0);
    assert.equal(relays.length, 1);
    assert.equal(relays[0].host, 'api.anthropic.com');
    assert.equal(relays[0].port, 443);
    assert.equal(relays[0].path, '/v1/messages');
  });

  it('rewrites an OpenCode-native model ref to the target instead of 404ing', async () => {
    const { host, calls } = fakeHost({ config: { model: 'pro' } });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'claude-sonnet-4-5', messages: [] });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, 'pro');
  });

  it('preserves a ref the OCR catalog carries', async () => {
    const { host, calls } = fakeHost({ config: { model: 'auto' }, models: ['gpt-5-codex'] });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'gpt-5-codex', messages: [] });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(calls[0].body.model, 'gpt-5-codex');
  });

  it('forces the target model when asked', async () => {
    const { host, calls } = fakeHost({
      config: { model: 'ultra', forceModel: true },
      models: ['gpt-5-codex'],
    });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'gpt-5-codex', messages: [] });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(calls[0].body.model, 'ultra');
  });

  it('streams canonical OpenAI frames on the OpenAI wire', async () => {
    const { host } = fakeHost();
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'auto', messages: [], stream: true });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.body(), /data: .*"choices"/);
    assert.match(res.body(), /data: \[DONE\]/);
    assert.equal(res.finished, true);
  });

  it('answers a non-stream turn with the pipeline JSON payload', async () => {
    const { host } = fakeHost({ json: { status: 200, payload: { id: 'x', choices: [] } } });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'auto', messages: [], stream: false });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.json(), { id: 'x', choices: [] });
    assert.equal(res.finished, true);
  });

  it('rejects an unparseable body before touching the pipeline', async () => {
    const { host, calls } = fakeHost();
    const plugin = createGateway(host);
    const req = fakeReq('not json');
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(calls.length, 0);
    assert.equal(res.statusCode, 400);
    assert.match(String((res.json() as { error: { message: string } }).error.message), /Invalid JSON/);
  });

  it('answers a dispatch failure instead of leaving the client hanging', async () => {
    const { host } = fakeHost({ throws: new Error('no routable models') });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'auto', messages: [] });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(res.statusCode, 502);
    assert.equal(res.finished, true);
  });

  it('parses the dial target from an h2 authority', async () => {
    const { host, relays } = fakeHost({ config: { intercept: false } });
    const plugin = createGateway(host);
    const req = fakeReq({ model: 'x' }, {
      url: '/v1/messages',
      authority: 'api.anthropic.com:8443',
    });
    const res = new FakeRes();

    await plugin.handle(req, asRes(res));

    assert.equal(relays[0].host, 'api.anthropic.com');
    assert.equal(relays[0].port, 8443);
    assert.equal(relays[0].h2, true);
  });
});
